import type { MpConfig } from "./config.js";
import { runProcess } from "./process.js";
import type { VerifyItem } from "./sdd/verify.js";

export interface VerifyOutcome {
  result: "pass" | "fail" | "cancelled" | "none";
  items: VerifyItem[];
}

export interface VerifyOptions {
  signal?: AbortSignal;
  onCommand?: (command: string) => void;
}

export function verifyOutcome(items: VerifyItem[], signal?: AbortSignal): VerifyOutcome {
  const result = signal?.aborted || items.some((i) => i.result === "cancelled")
    ? "cancelled"
    : items.length === 0
      ? "none"
      : items.every((i) => i.result === "pass" || i.reason?.startsWith("pipeline-only")) ? "pass" : "fail";
  return { result, items };
}

/** Split "npm run lint -- --fix" into argv, honouring simple quotes. No shell involved. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = null;
      // As in sh, a backslash inside double quotes escapes only " \ $ and `; a Windows path keeps its backslashes.
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1]!)) cur += cmd[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
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

/** Run configured commands in order; cancellation skips every remaining command. */
export async function runVerify(worktreePath: string, config: MpConfig, signal?: AbortSignal, onCommand?: (command: string) => void): Promise<VerifyOutcome> {
  const items: VerifyItem[] = [];
  for (const c of config.verify.commands) {
    if (signal?.aborted) break;
    const command = Array.isArray(c) ? c.join(" ") : c;
    const shell = typeof c === "string" ? shellSyntax(c) : undefined;
    const argv = Array.isArray(c) ? c : splitCommand(c);
    if (shell || argv.length === 0) {
      items.push({ kind: "verify", command, result: "manual", reason: shell ? `uses shell syntax (${shell}); run it yourself after reviewing it` : "empty command" });
      continue;
    }
    onCommand?.(command);
    const r = await runProcess({
      command: argv[0]!,
      args: argv.slice(1),
      cwd: worktreePath,
      timeoutMs: config.verify.timeoutMs,
      env: { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      signal,
    });
    const text = `${r.stdout}\n${r.stderr}`.trim();
    items.push({
      kind: "verify",
      command,
      result: r.cancelled ? "cancelled" : r.spawnError ? "manual" : r.exitCode === 0 && !r.timedOut ? "pass" : "fail",
      ...(r.spawnError ? { reason: r.spawnError.message } : {}),
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      outputTail: (r.spawnError ? r.spawnError.message : r.timedOut ? `timed out after ${config.verify.timeoutMs}ms\n${text}` : text).slice(-1500),
    });
  }
  return verifyOutcome(items, signal);
}
