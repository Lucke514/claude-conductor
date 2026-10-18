import { splitCommand } from "../hooks.js";
import { runProcess } from "../process.js";
import type { QualityGate, SddTask } from "./artifacts.js";

/**
 * Runs a task's `Verify` and the plan's quality gates inside the delegation
 * worktree (R7). Never through a shell: a command written with shell syntax is
 * reported as a pending manual check instead (E3). Nothing is deleted (E9).
 */

export interface VerifyItem {
  kind: "verify" | "gate";
  /** Gate name, for `kind: "gate"`. */
  gate?: string;
  command: string;
  result: "pass" | "fail" | "manual";
  /** Why a check is manual. */
  reason?: string;
  exitCode?: number | null;
  durationMs?: number;
  /**
   * Gates only: `false` = no new failures, `true` = a failure the baseline does not
   * have, `"compare"` = the baseline records failures; compare against it by hand.
   */
  newFailure?: boolean | "compare";
  baseline?: string;
  outputTail?: string;
}

/** The first shell construct in an unquoted (or double-quoted, for `$`/backticks) position. */
export function shellSyntax(cmd: string): string | undefined {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = null;
      else if (c === "$" || c === "`") return c;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "&" || c === "|") return cmd[i + 1] === c ? c + c : c;
    else if (";<>`$()*?~{}".includes(c)) return c;
  }
  return quote ? `unterminated ${quote}` : undefined;
}

/** Whether a baseline cell records zero failures (only then can a failure be called new). */
export function baselineIsClean(baseline: string): boolean {
  if (/pre-?exist|preexist|flaky|provisional|not measured/i.test(baseline)) return false;
  return /\b0\s+(failed|failures?|fail|errors?|errores|warnings?)\b/i.test(baseline) || /\bexit 0\b/i.test(baseline) || /\b(\d+) passed \(\1\)/.test(baseline);
}

const ENV = { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" };

async function run(cwd: string, command: string, timeoutMs: number): Promise<Pick<VerifyItem, "result" | "exitCode" | "durationMs" | "outputTail" | "reason">> {
  const shell = shellSyntax(command);
  if (shell) return { result: "manual", reason: `uses shell syntax (${shell}); never run through a shell — run it yourself after reviewing it` };
  const argv = splitCommand(command);
  if (argv.length === 0) return { result: "manual", reason: "empty command" };
  const r = await runProcess({ command: argv[0]!, args: argv.slice(1), cwd, timeoutMs, env: ENV });
  const text = `${r.stdout}\n${r.stderr}`.trim();
  return {
    result: r.exitCode === 0 && !r.timedOut ? "pass" : "fail",
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    outputTail: (r.spawnError ? r.spawnError.message : r.timedOut ? `timed out after ${timeoutMs}ms\n${text}` : text).slice(-1500),
  };
}

export async function verifyTask(worktreePath: string, task: SddTask, gates: QualityGate[], timeoutMs: number): Promise<VerifyItem[]> {
  const items: VerifyItem[] = [];
  if (task.verifyCommands.length === 0) {
    items.push({ kind: "verify", command: task.verify ?? "—", result: "manual", reason: "the task's Verify is a manual check" });
  }
  for (const command of task.verifyCommands) items.push({ kind: "verify", command, ...(await run(worktreePath, command, timeoutMs)) });
  for (const g of gates) {
    for (const command of g.commands) {
      if (g.pipelineOnly) {
        items.push({ kind: "gate", gate: g.gate, command, result: "manual", reason: "pipeline-only gate: read it from CI on this change set", baseline: g.baseline });
        continue;
      }
      const r = await run(worktreePath, command, timeoutMs);
      const item: VerifyItem = { kind: "gate", gate: g.gate, command, ...r, baseline: g.baseline };
      if (r.result === "pass") item.newFailure = false;
      else if (r.result === "fail") item.newFailure = baselineIsClean(g.baseline) ? true : "compare";
      items.push(item);
    }
  }
  return items;
}
