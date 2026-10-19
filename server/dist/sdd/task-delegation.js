import { appendAudit } from "../audit.js";
import { delegate } from "../delegate.js";
import { chainFor, routeTask } from "../fallback.js";
import { repoRootOf } from "../git.js";
import { PROVIDER_NAMES } from "../providers/types.js";
import { resolveTaskRepo, workspaceRepos } from "../repo.js";
import { makeReservationId, release, reserve } from "../reservations.js";
import { checkReferences, loadFeature, resolveTask, SddError } from "./artifacts.js";
import { acceptanceItems, buildTaskBrief } from "./brief.js";
import { checkDelegable, claimCommitted, commitCommand, notCommittedError, ownerValue, writeOwner } from "./claim.js";
import { verifyTask } from "./verify.js";
const OWNER_RE = new RegExp(`^(${PROVIDER_NAMES.join("|")}) \\(multi-provider\\) since \\d{4}-\\d{2}-\\d{2}$`);
function pickProvider(requested, feature, task, ctx) {
    if (requested !== "auto")
        return requested;
    // Tasks are delegated in write mode by default: its chain decides (nested-repos R8).
    const chain = chainFor(ctx.config, "write");
    const routed = routeTask(`${task.title}\n${task.do ?? ""}`, ctx.config.routing);
    if (routed && chain.includes(routed.provider))
        return routed.provider;
    const first = chain.find((p) => p !== "claude");
    if (!first)
        throw new SddError("TASK_CLAIMED", `the chain (${chain.join(" → ")}) has no provider to claim ${task.id} of ${feature.slug} for — do it with Claude`);
    return first;
}
async function loadTask(projectDir, slug, ref) {
    const feature = await loadFeature(projectDir, slug);
    const task = resolveTask(feature, ref);
    checkReferences(feature, task);
    return { feature, task };
}
export async function sddTaskClaim(args, ctx) {
    const { feature, task } = await loadTask(ctx.projectDir, args.slug, args.task);
    checkDelegable(feature, task);
    const provider = pickProvider(args.provider ?? "auto", feature, task, ctx);
    // R4: an unknown **Repo** fails before the Owner is written.
    const target = task.repo ? await resolveTaskRepo(ctx.projectDir, feature.slug, task.repo) : undefined;
    const owner = ownerValue(provider);
    await writeOwner(ctx.projectDir, feature, task.id, owner);
    const commit = commitCommand(feature, task.id, "claim").display;
    return {
        slug: feature.slug,
        taskId: task.id,
        title: task.title,
        provider,
        owner,
        ...(target ? { repo: target.rel } : {}),
        tasksFile: feature.tasksFile,
        commit,
        nextSteps: [
            `Commit the claim yourself, without co-author or attribution trailers: \`${commit}\` (only ${feature.tasksFile} goes in).`,
            `Then call \`sdd_task_delegate\` with slug "${feature.slug}" and task "${task.id}".`,
        ],
    };
}
const LINE = /^\s*[-*]\s*\[(met|not met|unverifiable)\]\s+([A-Z]\d+)\b\s*[—–:-]?\s*(.*)$/i;
/** R8: one verdict per Acceptance clause and per R#/E#; anything the worker did not answer is unverifiable. */
export function parseAcceptance(output, items) {
    const found = new Map();
    for (const line of output.replace(/\r\n?/g, "\n").split("\n")) {
        const m = LINE.exec(line);
        if (m && !found.has(m[2].toUpperCase()))
            found.set(m[2].toUpperCase(), { verdict: m[1].toLowerCase(), evidence: m[3].trim() });
    }
    return items.map((i) => {
        const f = found.get(i.id);
        return { id: i.id, item: i.text, verdict: f?.verdict ?? "unverifiable", evidence: f?.evidence ?? "no line for this item in the worker's ## Acceptance section" };
    });
}
function notesDraft(r, task, verification, acceptance) {
    const verify = verification.filter((v) => v.kind === "verify");
    const vText = verify.length ? verify.map((v) => `\`${v.command}\` ${v.result}`).join(", ") : "not run";
    const gates = verification.filter((v) => v.kind === "gate");
    const gText = gates.length
        ? gates.map((g) => `${g.gate} ${g.result === "pass" ? "ok" : g.result === "manual" ? "manual" : g.newFailure === true ? "NEW FAILURE" : "compare with baseline"}`).join(", ")
        : "none recorded";
    const met = acceptance.filter((a) => a.verdict === "met").length;
    return (`${task.id} delegated to ${r.provider ?? "—"} (delegation ${r.id}); files: ${(r.filesChanged ?? []).map((f) => `\`${f}\``).join(", ") || "none"}; ` +
        `Verify: ${vText}; gates: ${gText}; acceptance ${met}/${acceptance.length} met per the worker; ` +
        `landed in: <commit after delegation_apply>. Clean-code: <your review> · close calls: <your review>`);
}
export async function taskReservationKey(projectDir, slug, taskId) {
    const root = (await repoRootOf(projectDir)) ?? projectDir;
    return `${root.replace(/\/+$/, "")}/${slug}/${taskId}`;
}
export async function sddTaskDelegate(args, ctx) {
    if (args.task.trim().toLowerCase() === "next") {
        throw new SddError("TASK_NOT_FOUND", "sdd_task_delegate needs the task id that sdd_task_claim returned, not 'next'");
    }
    const { feature, task } = await loadTask(ctx.projectDir, args.slug, args.task);
    const owner = task.owner ?? "—";
    const m = OWNER_RE.exec(owner);
    if (!m)
        throw new SddError("TASK_CLAIMED", `${task.id} is owned by '${owner}', not by a multi-provider worker — claim it with sdd_task_claim first`);
    checkDelegable(feature, task, owner);
    if (!(await claimCommitted(ctx.projectDir, feature, task.id, owner)))
        throw notCommittedError(feature, task.id, owner);
    const reservationKey = await taskReservationKey(ctx.projectDir, feature.slug, task.id);
    const reservationId = makeReservationId();
    const maxAgeMs = (args.timeoutMs ?? ctx.config.defaults.writeTimeoutMs) + ctx.config.verify.timeoutMs;
    const res = await reserve(reservationKey, {
        id: reservationId,
        maxAgeMs,
        ...(args.now !== undefined ? { now: args.now } : {}),
    });
    if (!res.ok) {
        await appendAudit({
            type: "TASK_IN_FLIGHT",
            id: res.heldBy,
            callerId: reservationId,
            heldBy: res.heldBy,
            ts: new Date().toISOString(),
            sdd: { slug: feature.slug, taskId: task.id },
        }).catch(() => undefined);
        throw new SddError("TASK_IN_FLIGHT", `${task.id} of ${feature.slug} is already being delegated (held by ${res.heldBy})`, res.heldBy);
    }
    try {
        const provider = m[1];
        const mode = args.mode ?? "write";
        const brief = buildTaskBrief(feature, task);
        const target = task.repo ? await resolveTaskRepo(ctx.projectDir, feature.slug, task.repo) : undefined;
        const r = await delegate({
            provider,
            task: brief.task,
            files: brief.files,
            scopeFiles: task.files,
            // Files of a task with **Repo** are relative to that repo; delegate also accepts a `<Repo>/` prefix.
            ...(target ? { repo: target.rel, repoName: task.repo } : {}),
            extraOutput: brief.extraOutput,
            mode,
            fallback: true,
            sdd: { slug: feature.slug, taskId: task.id },
            ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
            ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        }, ctx);
        // A cancelled worker's partial diff is not verified: the user asked it to stop.
        const verification = r.worktreePath && r.status === "success"
            ? await verifyTask(r.worktreePath, task, feature.gates, ctx.config.verify.timeoutMs, {
                ...(task.repo ? { repo: task.repo } : {}),
                workspaceRepos: await workspaceRepos(ctx.projectDir),
            })
            : [];
        const acceptance = parseAcceptance(r.output, acceptanceItems(feature, task));
        // Pipeline-only gates are read from CI later; anything else must have run and passed.
        const drift = (r.violations ?? []).flatMap((v) => (v.type === "outside_task_files" ? v.files : []));
        const verified = drift.length === 0 && verification.length > 0 && verification.every((v) => v.result === "pass" || v.reason?.startsWith("pipeline-only"));
        const sdd = {
            slug: feature.slug,
            taskId: task.id,
            owner,
            acceptance,
            verification,
            verified,
            drift,
            notesDraft: notesDraft(r, task, verification, acceptance),
        };
        const notes = [...(target?.notes ?? []), ...(r.notes ?? [])];
        if (res.note)
            notes.push(res.note);
        const steps = [];
        if (r.status === "cancelled" || r.status === "partial") {
            // A cancelled or partial task stays claimed: the user decides whether to resume or hand it back.
            steps.push(`${task.id} was ${r.status === "partial" ? "left partial (out of time, with changes)" : "cancelled"} and stays claimed by ${owner}. To hand it back: \`sdd_task_release\` with slug "${feature.slug}" and task "${task.id}", then commit.`);
        }
        else if (r.status !== "success") {
            await writeOwner(ctx.projectDir, feature, task.id, "—");
            const commit = commitCommand(feature, task.id, "release").display;
            sdd.handback = { owner: "—", commit };
            sdd.owner = "—";
            steps.push(`No worker completed ${task.id}: its Owner is back to — (handback). Commit it: \`${commit}\`, then do the task yourself or delegate it again.`);
        }
        else {
            if (r.provider && r.provider !== provider)
                notes.push(`${task.id} was claimed for ${provider} but ${r.provider} did the work (fallback): fix the Owner line when you commit the work.`);
            if (r.worktreePath) {
                steps.push(verified
                    ? `Verify and gates passed in ${r.worktreePath}. Review the diff and the acceptance verdicts against the real code.`
                    : drift.length > 0
                        ? `SPEC DRIFT: the worker changed files outside ${task.id}'s Files (${drift.join(", ")}). Decide with the user: revert them in ${r.worktreePath}, or amend the spec/tasks first.`
                        : `NOT VERIFIED: see sdd.verification. The diff stays in ${r.worktreePath} and ${task.id} stays claimed; fix it there, ask the worker again, or discard.`, `Accept: \`delegation_apply\` with the worktreePath, then run your clean-code review, tick ${task.id}, write its Notes from sdd.notesDraft and commit \`${feature.slug}: ${task.id} …\` (no attribution trailers).`, `Reject: \`delegation_discard\` with the worktreePath, then \`sdd_task_release\` and commit the handback.`);
            }
            else {
                steps.push(mode === "read"
                    ? `Read-mode report for ${task.id}: check its findings against the real code; call \`sdd_task_release\` if you will not delegate the implementation.`
                    : `The worker finished without changing any file; call \`sdd_task_release\` and commit the handback, or do ${task.id} yourself.`);
            }
        }
        steps.push(...r.nextSteps.filter((s) => s.startsWith("Verify the worker") || s.startsWith("Violations")));
        return { ...r, ...(notes.length ? { notes } : {}), nextSteps: steps, sdd };
    }
    finally {
        await release(reservationKey, reservationId).catch(() => undefined);
    }
}
export async function sddTaskRelease(args, ctx) {
    const feature = await loadFeature(ctx.projectDir, args.slug);
    const task = resolveTask(feature, args.task);
    if (task.owner === null)
        return { slug: feature.slug, taskId: task.id, released: false, reason: `${task.id} is already unclaimed` };
    await writeOwner(ctx.projectDir, feature, task.id, "—");
    const commit = commitCommand(feature, task.id, "release").display;
    return { slug: feature.slug, taskId: task.id, released: true, previousOwner: task.owner, commit, nextSteps: [`Commit the handback without attribution trailers: \`${commit}\`.`] };
}
//# sourceMappingURL=task-delegation.js.map