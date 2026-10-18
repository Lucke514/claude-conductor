import { git } from "./git.js";
import { runProcess } from "./process.js";

/**
 * After a delegation, look for its `mp/*` branch on every remote (R6). Runs with
 * Claude's own environment, never the worker's. A remote that cannot be reached
 * yields a note, not a violation (E6); a repo without remotes is skipped (E7).
 */

export interface PushViolation {
  type: "worker_push";
  detail: string;
  remote: string;
  branch: string;
}

export const PUSH_CHECK_TIMEOUT_MS = 10_000;

export async function checkRemotePush(
  repoRoot: string,
  branch: string,
  timeoutMs = PUSH_CHECK_TIMEOUT_MS,
): Promise<{ violations: PushViolation[]; notes: string[] }> {
  const violations: PushViolation[] = [];
  const notes: string[] = [];
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
