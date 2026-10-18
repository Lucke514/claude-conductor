import { git } from "./git.js";
import { runProcess } from "./process.js";
export const PUSH_CHECK_TIMEOUT_MS = 10_000;
export async function checkRemotePush(repoRoot, branch, timeoutMs = PUSH_CHECK_TIMEOUT_MS) {
    const violations = [];
    const notes = [];
    const remotes = (await git(["remote"], repoRoot)).stdout.split(/\r?\n/).filter(Boolean);
    for (const remote of remotes) {
        const r = await runProcess({
            command: "git",
            args: ["ls-remote", "--heads", remote, `refs/heads/${branch}`],
            cwd: repoRoot,
            timeoutMs,
            env: { GIT_TERMINAL_PROMPT: "0" },
        });
        if (r.timedOut || r.exitCode !== 0) {
            const why = r.timedOut ? `no answer in ${Math.round(timeoutMs / 1000)}s` : (r.spawnError?.message ?? (r.stderr.trim().split("\n").pop() || `exit ${r.exitCode}`));
            notes.push(`push check skipped: ${remote}: ${why}`);
            continue;
        }
        if (r.stdout.trim()) {
            violations.push({ type: "worker_push", detail: `worker pushed ${branch} to remote '${remote}'`, remote, branch });
        }
    }
    return { violations, notes };
}
//# sourceMappingURL=remote-check.js.map