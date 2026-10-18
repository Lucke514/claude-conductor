import { loadConfig, type MpConfig } from "./config.js";
import { scrubCommand } from "./gh-scrub.js";
import { checkHealth } from "./health.js";
import { runProcess } from "./process.js";
import { StateStore } from "./state.js";
import { assertManagedPath, cleanupWorktrees } from "./worktree.js";

/**
 * Claude Code hook handlers. Each takes the hook's stdin JSON and returns the
 * JSON to print on stdout (or undefined for "no output").
 */

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  source?: string;
}

type HookOutput = Record<string, unknown> | undefined;

function projectDirFrom(input: HookInput): string {
  const env = process.env.CLAUDE_PROJECT_DIR;
  return env && !env.includes("${") ? env : (input.cwd ?? process.cwd());
}

async function safeConfig(dir: string): Promise<MpConfig | undefined> {
  try {
    return (await loadConfig(dir)).config;
  } catch {
    return undefined;
  }
}

/** PreToolUse(delegate): ask for confirmation in write mode; inject the Claude session id. */
export async function preDelegate(input: HookInput): Promise<HookOutput> {
  const toolInput = { ...(input.tool_input ?? {}) };
  const config = await safeConfig(projectDirFrom(input));
  const mode = (toolInput.mode as string | undefined) ?? config?.defaults.mode ?? "read";
  if (input.session_id && !toolInput.sessionId) toolInput.sessionId = input.session_id;
  const out: Record<string, unknown> = { hookEventName: "PreToolUse", updatedInput: toolInput };
  if (mode === "write") {
    out.permissionDecision = "ask";
    out.permissionDecisionReason =
      `multi-provider: '${String(toolInput.provider ?? "auto")}' will MODIFY files in an isolated git worktree ` +
      `(branch mp/*). Nothing is merged automatically — you will review the diff. Allow?`;
  }
  return { hookSpecificOutput: out };
}

/** PreToolUse(Bash): strip attribution from gh pr create/edit bodies and git commit messages. */
export async function preBash(input: HookInput): Promise<HookOutput> {
  const command = input.tool_input?.command;
  if (typeof command !== "string") return undefined;
  const r = scrubCommand(command, { cwd: input.cwd ?? process.cwd() });
  if (!r.changed) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...input.tool_input, command: r.command },
      additionalContext: "multi-provider removed AI attribution/co-author lines from this command (attribution is disabled).",
    },
  };
}

/** Find the delegate JSON result inside an MCP tool_response of unknown shape. */
export function extractDelegateResult(resp: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 6 || resp === null || resp === undefined) return undefined;
  if (typeof resp === "string") {
    const t = resp.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
    try {
      return extractDelegateResult(JSON.parse(t), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(resp)) {
    for (const item of resp) {
      const r = extractDelegateResult(item, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  if (typeof resp === "object") {
    const o = resp as Record<string, unknown>;
    if ("attempts" in o && "status" in o) return o;
    for (const v of Object.values(o)) {
      const r = extractDelegateResult(v, depth + 1);
      if (r) return r;
    }
  }
  return undefined;
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
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
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

export interface VerifyResult {
  command: string;
  exitCode: number | null;
  ok: boolean;
  durationMs: number;
  outputTail: string;
}

export async function runVerify(worktreePath: string, config: MpConfig): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  for (const c of config.verify.commands) {
    const argv = Array.isArray(c) ? c : splitCommand(c);
    if (argv.length === 0) continue;
    const r = await runProcess({
      command: argv[0]!,
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
export async function postDelegate(input: HookInput): Promise<HookOutput> {
  const res = extractDelegateResult(input.tool_response);
  const wt = res?.worktreePath;
  if (typeof wt !== "string" || !res?.diff) return undefined;
  try {
    assertManagedPath(wt);
  } catch {
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
  const lines = results.map(
    (r) => `- \`${r.command}\` → ${r.ok ? "OK" : `FAILED (exit ${r.exitCode ?? "none"})`} in ${Math.round(r.durationMs / 1000)}s` +
      (r.ok ? "" : `\n\`\`\`\n${r.outputTail}\n\`\`\``),
  );
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        `multi-provider verification in worktree ${wt}: ${allOk ? "ALL PASSED" : "FAILURES"}\n${lines.join("\n")}\n` +
        (allOk
          ? "Still review the diff yourself before calling delegation_apply."
          : "Do not apply this diff as-is: ask the worker for a fix, fix it yourself in the worktree, or discard it."),
    },
  };
}

/** SessionStart: silent health check; only speaks when no provider is usable. */
export async function sessionStart(input: HookInput): Promise<HookOutput> {
  const dir = projectDirFrom(input);
  let config: MpConfig;
  try {
    config = (await loadConfig(dir)).config;
  } catch (err) {
    return { systemMessage: `multi-provider: invalid configuration — ${(err as Error).message}` };
  }
  // Housekeeping: drop delegation worktrees older than 24h.
  await cleanupWorktrees(dir, 24 * 3600_000).catch(() => undefined);
  const statuses = await checkHealth(config, new StateStore()).catch(() => []);
  if (statuses.some((s) => s.available)) return undefined;
  const detail = statuses
    .map((s) => `${s.provider}: ${!s.enabled ? "disabled" : !s.installed ? "not installed" : s.auth === "missing" ? "not authenticated" : s.breaker.state === "open" ? "circuit open" : (s.error ?? "unavailable")}`)
    .join(", ");
  const msg = `multi-provider: no delegation provider is available (${detail}). Delegations will fall back to Claude.`;
  return { systemMessage: msg, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: msg } };
}
