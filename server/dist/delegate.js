import { randomBytes } from "node:crypto";
import { appendAudit } from "./audit.js";
import { chainFor, resolveOrder, routeTask, runChain } from "./fallback.js";
import { repoRootOf } from "./git.js";
import { makeAdapters, makeBreaker } from "./health.js";
import { buildPrompt } from "./prompt-builder.js";
import { PROVIDER_NAMES } from "./providers/types.js";
import { RepoError, resolveRepo } from "./repo.js";
import { scanSecrets } from "./secrets-scan.js";
import { recordCall, recordRecent, registerRepo, taskLabel } from "./state.js";
import { checkRemotePush } from "./remote-check.js";
import { ensureShims, workerEnv } from "./worker-env.js";
import { collectChanges, createWorktree, removeWorktree } from "./worktree.js";
const normPath = (p) => p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
/** Changed files not covered by the task's Files (exact path, or under an entry ending in `/`). */
export function outsideScope(changed, scope) {
    const entries = scope.map(normPath).filter(Boolean);
    return changed.filter((f) => {
        const file = normPath(f);
        return !entries.some((e) => (e.endsWith("/") ? file.startsWith(e) : file === e));
    });
}
/** Failed writes whose worktree is kept when it has changes. */
const KEEP_ON = ["CANCELLED", "TIMEOUT", "STALLED"];
/** Of those, the ones that end the chain as `partial` (R5); CANCELLED ends it as `cancelled`. */
const STOP_ON = ["TIMEOUT", "STALLED"];
export async function delegate(params, ctx) {
    const started = Date.now();
    const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
    const { config } = ctx;
    const mode = params.mode ?? config.defaults.mode;
    const timeoutMs = params.timeoutMs ?? (mode === "write" ? config.defaults.writeTimeoutMs : config.defaults.timeoutMs);
    const sessionKey = params.sessionId ?? ctx.instanceId;
    // R1: an invalid repo fails before any job, worktree or worker exists.
    const target = params.repo !== undefined ? await resolveRepo(ctx.projectDir, params.repo) : undefined;
    const codeDir = target?.root ?? ctx.projectDir;
    // Paths may carry the repo's prefix (`backend-monolith/src/x.ts`): strip one, once.
    const prefixes = target ? [target.rel, params.repoName].filter((p) => Boolean(p)).map((p) => `${p}/`) : [];
    const inRepo = (files) => files?.map((f) => {
        const norm = f.replace(/\\/g, "/");
        const prefix = prefixes.find((p) => norm.startsWith(p));
        return prefix ? norm.slice(prefix.length) : f;
    });
    // The job's controller follows the MCP request's signal and delegation_cancel alike.
    const signal = ctx.jobs
        ? ctx.jobs.start({ id, provider: null, mode, task: taskLabel(params.task), ...(params.sdd ? { sdd: params.sdd } : {}) }, ctx.signal).signal
        : ctx.signal;
    try {
        return await run();
    }
    finally {
        await ctx.jobs?.finish(id);
    }
    async function run() {
        const built = await buildPrompt({
            task: params.task,
            mode,
            files: inRepo(params.files) ?? [],
            projectDir: codeDir,
            maxFileBytes: config.defaults.maxFileBytes,
            maxTotalBytes: config.defaults.maxTotalBytes,
            ...(params.extraOutput ? { extraOutput: params.extraOutput } : {}),
        });
        const chain = chainFor(config, mode);
        const routed = params.provider === "auto" ? routeTask(params.task, config.routing, params.taskType) : undefined;
        // R8: a route to a provider outside this mode's chain is ignored; an explicit provider is still tried first.
        const routing = routed && chain.includes(routed.provider) ? routed : undefined;
        const first = params.provider === "auto" ? routing?.provider : params.provider;
        const order = resolveOrder(chain, first, params.provider === "auto" ? true : (params.fallback ?? true));
        const adapters = ctx.adapters ?? makeAdapters(config);
        const breaker = makeBreaker(config);
        const state = await ctx.store.read();
        for (const p of PROVIDER_NAMES)
            breaker.load(p, state.providers[p]?.breaker);
        const violations = [];
        const notes = [];
        if (routed && !routing)
            notes.push(`routing rule '${routed.rule}' points to ${routed.provider}, which is not in the ${mode} chain (${chain.join(" → ")}); ignored`);
        let kept;
        const repoRoot = target?.root ?? (await repoRootOf(ctx.projectDir));
        // R11: remember the nested repo so cleanup and status find its mp/* worktrees.
        if (target)
            await ctx.store.update((s) => registerRepo(s, target.root)).catch(() => undefined);
        const isolate = mode === "write" || config.isolation.readMode === "worktree";
        if (!isolate) {
            // R6: without a worktree the worker reads the real tree; refuse while it holds reachable .env files.
            const scan = await scanSecrets(codeDir);
            if (scan.found.length > 0 || scan.truncated) {
                const what = scan.found.length > 0 ? `.env files are reachable (${scan.found.join(", ")}${scan.truncated ? ", …" : ""})` : "the scan for .env files hit its limit";
                if (!config.isolation.allowCwdWithSecrets) {
                    throw new RepoError("UNSAFE_READ_MODE", `isolation.readMode "cwd" refused: ${what}. Use readMode "worktree" (ignored files never reach the worker), or set isolation.allowCwdWithSecrets: true to accept the risk. No worker was started.`);
                }
                notes.push(`readMode "cwd" ran although ${what} (isolation.allowCwdWithSecrets: true)`);
            }
        }
        if (mode === "write" && !repoRoot) {
            return finish({
                provider: null,
                model: null,
                status: "failed",
                output: "",
                attempts: [],
                summary: "write mode requires a git repository (changes are isolated in a git worktree)",
            });
        }
        await ensureShims();
        let lastHadChanges = false;
        const execute = async (provider, adapter) => {
            let meta;
            if (isolate && repoRoot) {
                meta = await createWorktree({
                    cwd: repoRoot,
                    provider,
                    includeUncommitted: config.isolation.includeUncommitted,
                    symlink: (target && (config.isolation.symlinkByRepo[target.rel] ?? (params.repoName ? config.isolation.symlinkByRepo[params.repoName] : undefined))) ??
                        config.isolation.symlink,
                    ...(params.sdd ? { sdd: params.sdd } : {}),
                });
            }
            if (meta?.skippedSymlinks)
                notes.push(`symlink skipped (credentials/secrets are never linked into a worktree): ${meta.skippedSymlinks.join(", ")}`);
            ctx.jobs?.setProvider(id, provider, meta);
            const model = provider === params.provider ? params.model : undefined;
            let result;
            try {
                result = await adapter.run({
                    prompt: built.prompt,
                    cwd: meta?.path ?? codeDir,
                    mode,
                    timeoutMs: config.providers[provider].timeoutMs ?? timeoutMs,
                    ...(model ? { model } : {}),
                    env: workerEnv(meta, process.env, [ctx.projectDir, ...(repoRoot ? [repoRoot] : [])]),
                    ...(signal ? { signal } : {}),
                    ...(ctx.jobs ? { onProgress: (chunk) => ctx.jobs?.progress(id, chunk) } : {}),
                    idleTimeoutMs: config.defaults.idleTimeoutMs,
                });
            }
            catch (err) {
                result = { ok: false, output: "", exitCode: null, durationMs: 0, error: { type: "NON_ZERO_EXIT", message: err.message } };
            }
            if (result.notes)
                notes.push(...result.notes.map((n) => `${provider}: ${n}`));
            if (meta) {
                const changes = await collectChanges(meta, config.defaults.maxDiffBytes, `${id}-${provider}`);
                ctx.jobs?.setFilesChanged(id, changes.files.length);
                violations.push(...changes.violations);
                if (config.guardrails.checkRemotePush) {
                    const pushed = await checkRemotePush(meta.repoRoot, meta.branch);
                    violations.push(...pushed.violations);
                    notes.push(...pushed.notes);
                }
                if (mode === "read" && changes.files.length > 0) {
                    violations.push({
                        type: "write_in_read_mode",
                        detail: `${provider} modified ${changes.files.length} file(s) in read mode; changes were discarded: ${changes.files.slice(0, 10).join(", ")}`,
                    });
                }
                if (params.scopeFiles && mode === "write" && changes.files.length > 0) {
                    const outside = outsideScope(changes.files, inRepo(params.scopeFiles));
                    if (outside.length > 0) {
                        violations.push({
                            type: "outside_task_files",
                            detail: `${provider} changed ${outside.length} file(s) outside the task's Files: ${outside.slice(0, 10).join(", ")}`,
                            files: outside,
                        });
                    }
                }
                // A cancelled, timed-out or stalled write keeps what the worker already did (E3, R5), like a finished one.
                const keep = result.ok || KEEP_ON.includes(result.error?.type ?? "NON_ZERO_EXIT");
                lastHadChanges = mode === "write" && changes.files.length > 0;
                if (mode === "write" && keep && changes.files.length > 0) {
                    kept = { meta, changes };
                }
                else {
                    await removeWorktree(meta).catch(() => undefined);
                    if (mode === "write" && result.ok)
                        notes.push(`${provider}: finished without changing any file`);
                }
            }
            return result;
        };
        const outcome = await runChain(order, {
            adapters,
            breaker,
            config,
            execute,
            ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
            ...(signal ? { signal } : {}),
            shouldStop: (_provider, result) => lastHadChanges && STOP_ON.includes(result.error?.type ?? "NON_ZERO_EXIT"),
            onAttempt: async (provider, result) => {
                await ctx.store.update((s) => {
                    recordCall(s, {
                        provider,
                        durationMs: result.durationMs,
                        sessionKey,
                        ...(result.usage ? { usage: result.usage } : {}),
                        ...(result.error ? { error: result.error } : {}),
                    });
                    (s.providers[provider] ??= {}).breaker = breaker.snapshot(provider);
                });
            },
        });
        // Persist breaker transitions also for skipped (open) providers.
        await ctx.store.update((s) => {
            s.chain = [...config.chain];
            for (const p of PROVIDER_NAMES)
                (s.providers[p] ??= {}).breaker = breaker.snapshot(p);
        });
        const result = outcome.result;
        return finish({
            provider: outcome.provider ?? null,
            model: result?.model ?? null,
            status: outcome.status,
            output: result?.output ?? "",
            attempts: outcome.attempts,
            ...(outcome.summary ? { summary: outcome.summary } : {}),
            ...(result?.usage ? { usage: result.usage } : {}),
        });
        async function finish(r) {
            const response = {
                id,
                requestedProvider: params.provider,
                mode,
                ...(target ? { repo: target.rel } : {}),
                files: built.files,
                durationMs: Date.now() - started,
                nextSteps: [],
                ...r,
            };
            if (routing)
                response.routing = { rule: routing.rule, provider: routing.provider };
            // R9: say plainly when another provider answered, so reports never credit the one asked for.
            const expected = params.provider === "auto" ? (routing?.provider ?? order.find((p) => p !== "claude")) : params.provider;
            if (r.provider && expected && r.provider !== expected) {
                const failed = r.attempts.find((a) => a.provider === expected);
                const why = failed?.errorType ?? failed?.skipped;
                notes.push(`requested ${expected}, answered by ${r.provider} (fallback${why ? ` after ${expected}: ${why}` : ""})`);
            }
            if (kept && (r.status === "success" || r.status === "cancelled" || r.status === "partial")) {
                response.diff = kept.changes.diff;
                response.diffTruncated = kept.changes.truncated;
                response.filesChanged = kept.changes.files;
                response.worktreePath = kept.meta.path;
                response.branch = kept.meta.branch;
                if (kept.changes.patchFile)
                    response.patchFile = kept.changes.patchFile;
            }
            if (violations.length > 0)
                response.violations = violations;
            if (notes.length > 0)
                response.notes = notes;
            response.nextSteps = nextSteps(response);
            await ctx.store
                .update((s) => recordRecent(s, {
                id,
                at: new Date().toISOString(),
                requested: params.provider,
                provider: response.provider,
                mode,
                status: response.status,
                task: taskLabel(params.task),
                durationMs: response.durationMs,
                ...(response.filesChanged ? { filesChanged: response.filesChanged.length } : {}),
                ...(params.sdd ? { sdd: { slug: params.sdd.slug, taskId: params.sdd.taskId } } : {}),
                ...(violations.length ? { violations: violations.map((v) => ({ type: v.type, detail: v.detail })) } : {}),
            }))
                .catch(() => undefined);
            await appendAudit({
                id,
                ts: new Date().toISOString(),
                requestedProvider: params.provider,
                provider: response.provider,
                mode,
                status: response.status,
                durationMs: response.durationMs,
                promptSha256: built.sha256,
                promptBytes: Buffer.byteLength(built.prompt),
                filesCount: built.files.filter((f) => f.included).length,
                ...(response.model ? { model: response.model } : {}),
                ...(routing ? { routingRule: routing.rule } : {}),
                attempts: response.attempts.map((a) => ({
                    provider: a.provider,
                    ...(a.errorType ? { errorType: a.errorType } : {}),
                    ...(a.skipped ? { skipped: a.skipped } : {}),
                    ...(a.retry ? { retry: a.retry } : {}),
                    ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
                })),
                ...(response.filesChanged ? { filesChanged: response.filesChanged.length } : {}),
                ...(violations.length ? { violations: violations.map((v) => ({ type: v.type, detail: v.detail })) } : {}),
                sessionKey,
                ...(params.sdd ? { sdd: { slug: params.sdd.slug, taskId: params.sdd.taskId } } : {}),
            }).catch(() => undefined);
            return response;
        }
    }
}
function nextSteps(r) {
    if (r.status === "partial") {
        return [
            `The worker ran out of time (${r.attempts.at(-1)?.errorType ?? "TIMEOUT"}) after changing files; nothing was retried. Its work is in ${r.worktreePath} (see \`diff\`, full patch in \`patchFile\`).`,
            "Review it like any diff. Keep it: `delegation_apply` with the worktreePath and finish the rest yourself, or delegate the remainder. Drop it: `delegation_discard`.",
        ];
    }
    if (r.status === "cancelled") {
        return r.worktreePath
            ? [
                `Cancelled. The worker's changes so far stay in ${r.worktreePath} (see \`diff\`).`,
                "Keep them: `delegation_apply` with the worktreePath, then finish the task yourself. Drop them: `delegation_discard`.",
            ]
            : ["Cancelled before the worker changed anything. No other provider was tried."];
    }
    if (r.status === "fallback_to_claude") {
        return ["No worker could complete the task. Do it yourself (Claude); see `summary` for why each provider failed."];
    }
    if (r.status === "failed")
        return ["Delegation failed and the chain has no 'claude' fallback. Inspect `attempts`/`summary`."];
    const steps = ["Verify the worker's claims against the real code before using them — never accept unverified output."];
    if (r.worktreePath) {
        steps.push(`Review the diff and run lint/tests inside ${r.worktreePath}.`, "Accept: call `delegation_apply` with the worktreePath (git apply --3way onto the user's branch, no commit), then commit yourself.", "Reject: call `delegation_discard` with the worktreePath. mp/* branches are never merged.");
    }
    for (const v of r.violations ?? []) {
        if (v.type === "worker_push")
            steps.push(`A worker pushed ${v.branch} to '${v.remote}'. Tell the user and, with their OK, delete it: \`git push ${v.remote} --delete ${v.branch}\`.`);
    }
    if (r.violations?.length)
        steps.push("Violations were recorded (see `violations`); treat this result with extra suspicion.");
    return steps;
}
//# sourceMappingURL=delegate.js.map