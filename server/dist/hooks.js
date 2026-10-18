import { loadConfig } from "./config.js";
import { scrubCommand } from "./gh-scrub.js";
import { checkHealth } from "./health.js";
import { runProcess } from "./process.js";
import { StateStore } from "./state.js";
import { assertManagedPath, cleanupWorktrees } from "./worktree.js";
function projectDirFrom(input) {
    const env = process.env.CLAUDE_PROJECT_DIR;
    return env && !env.includes("${") ? env : (input.cwd ?? process.cwd());
}
async function safeConfig(dir) {
    try {
        return (await loadConfig(dir)).config;
    }
    catch {
        return undefined;
    }
}
/** PreToolUse(delegate): ask for confirmation in write mode; inject the Claude session id. */
export async function preDelegate(input) {
    const toolInput = { ...(input.tool_input ?? {}) };
    const config = await safeConfig(projectDirFrom(input));
    // sdd_task_delegate defaults to write; delegate follows defaults.mode.
    const sdd = input.tool_name?.endsWith("__sdd_task_delegate") ?? false;
    const mode = toolInput.mode ?? (sdd ? "write" : (config?.defaults.mode ?? "read"));
    if (input.session_id && !toolInput.sessionId)
        toolInput.sessionId = input.session_id;
    const out = { hookEventName: "PreToolUse", updatedInput: toolInput };
    if (mode === "write") {
        out.permissionDecision = "ask";
        out.permissionDecisionReason =
            `multi-provider: '${String(toolInput.provider ?? (sdd ? `the worker claimed for ${String(toolInput.slug)}/${String(toolInput.task)}` : "auto"))}' will MODIFY files in an isolated git worktree ` +
                `(branch mp/*). Nothing is merged automatically — you will review the diff. Allow?`;
    }
    return { hookSpecificOutput: out };
}
/** PreToolUse(Bash): strip attribution from gh pr create/edit bodies and git commit messages. */
export async function preBash(input) {
    const command = input.tool_input?.command;
    if (typeof command !== "string")
        return undefined;
    const r = scrubCommand(command, { cwd: input.cwd ?? process.cwd() });
    if (!r.changed)
        return undefined;
    return {
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: { ...input.tool_input, command: r.command },
            additionalContext: "multi-provider removed AI attribution/co-author lines from this command (attribution is disabled).",
        },
    };
}
/** Find the delegate JSON result inside an MCP tool_response of unknown shape. */
export function extractDelegateResult(resp, depth = 0) {
    if (depth > 6 || resp === null || resp === undefined)
        return undefined;
    if (typeof resp === "string") {
        const t = resp.trim();
        if (!t.startsWith("{") && !t.startsWith("["))
            return undefined;
        try {
            return extractDelegateResult(JSON.parse(t), depth + 1);
        }
        catch {
            return undefined;
        }
    }
    if (Array.isArray(resp)) {
        for (const item of resp) {
            const r = extractDelegateResult(item, depth + 1);
            if (r)
                return r;
        }
        return undefined;
    }
    if (typeof resp === "object") {
        const o = resp;
        if ("attempts" in o && "status" in o)
            return o;
        for (const v of Object.values(o)) {
            const r = extractDelegateResult(v, depth + 1);
            if (r)
                return r;
        }
    }
    return undefined;
}
/** Split "npm run lint -- --fix" into argv, honouring simple quotes. No shell involved. */
export function splitCommand(cmd) {
    const out = [];
    let cur = "";
    let quote = null;
    let has = false;
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (quote) {
            if (c === quote)
                quote = null;
            else if (c === "\\" && quote === '"' && i + 1 < cmd.length)
                cur += cmd[++i];
            else
                cur += c;
        }
        else if (c === '"' || c === "'") {
            quote = c;
            has = true;
        }
        else if (/\s/.test(c)) {
            if (has || cur)
                out.push(cur);
            cur = "";
            has = false;
        }
        else {
            cur += c;
        }
    }
    if (has || cur)
        out.push(cur);
    return out;
}
export async function runVerify(worktreePath, config) {
    const results = [];
    for (const c of config.verify.commands) {
        const argv = Array.isArray(c) ? c : splitCommand(c);
        if (argv.length === 0)
            continue;
        const r = await runProcess({
            command: argv[0],
            args: argv.slice(1),
            cwd: worktreePath,
            timeoutMs: config.verify.timeoutMs,
            env: { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
        });
        const text = `${r.stdout}\n${r.stderr}`.trim();
        results.push({
            command: argv.join(" "),
            exitCode: r.exitCode,
            ok: r.exitCode === 0 && !r.timedOut,
            durationMs: r.durationMs,
            outputTail: (r.spawnError ? r.spawnError.message : r.timedOut ? `timed out after ${config.verify.timeoutMs}ms\n${text}` : text).slice(-1500),
        });
    }
    return results;
}
/** PostToolUse(delegate): when there is a diff, run verify.commands inside the worktree. */
export async function postDelegate(input) {
    const res = extractDelegateResult(input.tool_response);
    const wt = res?.worktreePath;
    if (typeof wt !== "string" || !res?.diff)
        return undefined;
    try {
        assertManagedPath(wt);
    }
    catch {
        return undefined;
    }
    const config = await safeConfig(projectDirFrom(input));
    if (!config || config.verify.commands.length === 0) {
        return {
            hookSpecificOutput: {
                hookEventName: "PostToolUse",
                additionalContext: `multi-provider: no verify.commands configured. Run lint/tests yourself inside ${wt} before accepting the diff.`,
            },
        };
    }
    const results = await runVerify(wt, config);
    const allOk = results.every((r) => r.ok);
    const lines = results.map((r) => `- \`${r.command}\` → ${r.ok ? "OK" : `FAILED (exit ${r.exitCode ?? "none"})`} in ${Math.round(r.durationMs / 1000)}s` +
        (r.ok ? "" : `\n\`\`\`\n${r.outputTail}\n\`\`\``));
    return {
        hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `multi-provider verification in worktree ${wt}: ${allOk ? "ALL PASSED" : "FAILURES"}\n${lines.join("\n")}\n` +
                (allOk
                    ? "Still review the diff yourself before calling delegation_apply."
                    : "Do not apply this diff as-is: ask the worker for a fix, fix it yourself in the worktree, or discard it."),
        },
    };
}
export const AUTO_DELEGATE_CONTEXT = "multi-provider auto-delegation is ON (the user can turn it off with /mp-auto off). " +
    "Decide yourself whether this request contains a substantive task a worker can do from a self-contained brief " +
    "(code review, bug hunt, refactor, implementing a feature, writing tests, codebase analysis). " +
    "If it does, delegate it WITHOUT asking the user to run any command: write a self-contained brief " +
    "(objective, constraints, acceptance criteria) and call the multi-provider `delegate` tool with provider \"auto\", " +
    "mode \"write\" when the request asks to change code and \"read\" otherwise, passing the relevant files. " +
    "Then verify the result against the real code: on fallback_to_claude do the task yourself; in write mode show the diff " +
    "and verification results and call delegation_apply only after the user's OK; never merge mp/* branches. " +
    "Tell the user in one line that you are delegating and to which provider. " +
    "Do NOT delegate conversation, quick questions, tiny edits faster to do directly, plugin/config management, " +
    "or work that depends on context you cannot put in a brief.";
/** UserPromptSubmit: when autoDelegate is on, tell Claude to delegate suitable requests by itself. */
export async function userPromptSubmit(input) {
    const prompt = (input.prompt ?? "").trim();
    if (!prompt || prompt.startsWith("/"))
        return undefined;
    const config = await safeConfig(projectDirFrom(input));
    if (!config?.autoDelegate.enabled)
        return undefined;
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: AUTO_DELEGATE_CONTEXT } };
}
/** SessionStart: silent health check; only speaks when no provider is usable. */
export async function sessionStart(input) {
    const dir = projectDirFrom(input);
    let config;
    try {
        config = (await loadConfig(dir)).config;
    }
    catch (err) {
        return { systemMessage: `multi-provider: invalid configuration — ${err.message}` };
    }
    // Housekeeping: drop delegation worktrees older than 24h.
    await cleanupWorktrees(dir, 24 * 3600_000).catch(() => undefined);
    const statuses = await checkHealth(config, new StateStore()).catch(() => []);
    if (statuses.some((s) => s.available))
        return undefined;
    const detail = statuses
        .map((s) => `${s.provider}: ${!s.enabled ? "disabled" : !s.installed ? "not installed" : s.auth === "missing" ? "not authenticated" : s.breaker.state === "open" ? "circuit open" : (s.error ?? "unavailable")}`)
        .join(", ");
    const msg = `multi-provider: no delegation provider is available (${detail}). Delegations will fall back to Claude.`;
    return { systemMessage: msg, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: msg } };
}
//# sourceMappingURL=hooks.js.map