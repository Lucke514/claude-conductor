import { splitCommand, shellSyntax } from "../verify-commands.js";
import { runProcess } from "../process.js";
export { shellSyntax } from "../verify-commands.js";
/** Whether a baseline cell records zero failures (only then can a failure be called new). */
export function baselineIsClean(baseline) {
    if (/pre-?exist|preexist|flaky|provisional|not measured/i.test(baseline))
        return false;
    return /\b0\s+(failed|failures?|fail|errors?|errores|warnings?)\b/i.test(baseline) || /\bexit 0\b/i.test(baseline) || /\b(\d+) passed \(\1\)/.test(baseline);
}
const ENV = { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
async function run(cwd, command, timeoutMs, options) {
    const shell = shellSyntax(command);
    if (shell)
        return { result: "manual", reason: `uses shell syntax (${shell}); never run through a shell — run it yourself after reviewing it` };
    const argv = splitCommand(command);
    if (argv.length === 0)
        return { result: "manual", reason: "empty command" };
    options.onCommand?.(command);
    const r = await runProcess({ command: argv[0], args: argv.slice(1), cwd, timeoutMs, env: ENV, signal: options.signal });
    const text = `${r.stdout}\n${r.stderr}`.trim();
    return {
        ...(r.spawnError ? { reason: r.spawnError.message } : {}),
        result: r.cancelled ? "cancelled" : r.spawnError ? "manual" : r.exitCode === 0 && !r.timedOut ? "pass" : "fail",
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        outputTail: (r.spawnError ? r.spawnError.message : r.timedOut ? `timed out after ${timeoutMs}ms\n${text}` : text).slice(-1500),
    };
}
/** The repo a gate's `Where` names, when it is a repo of the workspace other than the task's (R5 of nested-repos). */
function otherRepo(where, repos) {
    const name = where.replace(/`/g, "").trim().replace(/\/+$/, "");
    // A task without **Repo** behaves as before nested-repos: every gate runs.
    if (!repos.repo)
        return undefined;
    return name && name !== repos.repo && repos.workspaceRepos?.includes(name) ? name : undefined;
}
export async function verifyTask(worktreePath, task, gates, timeoutMs, repos = {}, options = {}) {
    const items = [];
    if (task.verifyCommands.length === 0) {
        items.push({ kind: "verify", command: task.verify ?? "—", result: "manual", reason: "the task's Verify is a manual check" });
    }
    for (const command of task.verifyCommands) {
        if (options.signal?.aborted)
            return items;
        items.push({ kind: "verify", command, ...(await run(worktreePath, command, timeoutMs, options)) });
    }
    for (const g of gates) {
        for (const command of g.commands) {
            if (options.signal?.aborted)
                return items;
            if (g.pipelineOnly) {
                items.push({ kind: "gate", gate: g.gate, command, result: "manual", reason: "pipeline-only gate: read it from CI on this change set", baseline: g.baseline });
                continue;
            }
            const elsewhere = otherRepo(g.where, repos);
            if (elsewhere) {
                items.push({ kind: "gate", gate: g.gate, command, result: "manual", reason: `runs in ${elsewhere}, not in this task's repo: run it there yourself`, baseline: g.baseline });
                continue;
            }
            const r = await run(worktreePath, command, timeoutMs, options);
            const item = { kind: "gate", gate: g.gate, command, ...r, baseline: g.baseline };
            if (r.result === "pass")
                item.newFailure = false;
            else if (r.result === "fail")
                item.newFailure = baselineIsClean(g.baseline) ? true : "compare";
            items.push(item);
        }
    }
    return items;
}
//# sourceMappingURL=verify.js.map