import { splitCommand } from "../hooks.js";
import { runProcess } from "../process.js";
/** The first shell construct in an unquoted (or double-quoted, for `$`/backticks) position. */
export function shellSyntax(cmd) {
    let quote = null;
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (quote === "'") {
            if (c === "'")
                quote = null;
            continue;
        }
        if (quote === '"') {
            if (c === "\\")
                i++;
            else if (c === '"')
                quote = null;
            else if (c === "$" || c === "`")
                return c;
            continue;
        }
        if (c === "'" || c === '"')
            quote = c;
        else if (c === "&" || c === "|")
            return cmd[i + 1] === c ? c + c : c;
        else if (";<>`$()*?~{}".includes(c))
            return c;
    }
    return quote ? `unterminated ${quote}` : undefined;
}
/** Whether a baseline cell records zero failures (only then can a failure be called new). */
export function baselineIsClean(baseline) {
    if (/pre-?exist|preexist|flaky|provisional|not measured/i.test(baseline))
        return false;
    return /\b0\s+(failed|failures?|fail|errors?|errores|warnings?)\b/i.test(baseline) || /\bexit 0\b/i.test(baseline) || /\b(\d+) passed \(\1\)/.test(baseline);
}
const ENV = { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
async function run(cwd, command, timeoutMs) {
    const shell = shellSyntax(command);
    if (shell)
        return { result: "manual", reason: `uses shell syntax (${shell}); never run through a shell — run it yourself after reviewing it` };
    const argv = splitCommand(command);
    if (argv.length === 0)
        return { result: "manual", reason: "empty command" };
    const r = await runProcess({ command: argv[0], args: argv.slice(1), cwd, timeoutMs, env: ENV });
    const text = `${r.stdout}\n${r.stderr}`.trim();
    return {
        result: r.exitCode === 0 && !r.timedOut ? "pass" : "fail",
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
export async function verifyTask(worktreePath, task, gates, timeoutMs, repos = {}) {
    const items = [];
    if (task.verifyCommands.length === 0) {
        items.push({ kind: "verify", command: task.verify ?? "—", result: "manual", reason: "the task's Verify is a manual check" });
    }
    for (const command of task.verifyCommands)
        items.push({ kind: "verify", command, ...(await run(worktreePath, command, timeoutMs)) });
    for (const g of gates) {
        for (const command of g.commands) {
            if (g.pipelineOnly) {
                items.push({ kind: "gate", gate: g.gate, command, result: "manual", reason: "pipeline-only gate: read it from CI on this change set", baseline: g.baseline });
                continue;
            }
            const elsewhere = otherRepo(g.where, repos);
            if (elsewhere) {
                items.push({ kind: "gate", gate: g.gate, command, result: "manual", reason: `runs in ${elsewhere}, not in this task's repo: run it there yourself`, baseline: g.baseline });
                continue;
            }
            const r = await run(worktreePath, command, timeoutMs);
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