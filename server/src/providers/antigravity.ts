import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { effectiveErrorPatterns, type ProviderConfig } from "../config.js";
import { classifyFailure, excerpt } from "../fallback.js";
import { findInPath, runProcess } from "../process.js";
import type { HealthReport, ProviderAdapter, ProviderRequest, ProviderResult, TokenUsage } from "./types.js";

/**
 * Google Antigravity CLI adapter.
 *
 *   agy [--model <m>] [--output-format json] [...modeArgs] [...extraArgs] -p "<prompt>"
 *
 * `agy -p` is known to hang when there is no TTY (fixed upstream in 1.1.1, but
 * older installs exist), so by default it runs under a pseudo-terminal
 * (node-pty) and ANSI codes are stripped. `usePty: false` switches to plain
 * spawn with stdin closed. A hard timeout kills the whole process tree.
 */

/** Conservative argv limits (Windows command line is 32767 chars total). */
const MAX_ARG_PROMPT = process.platform === "win32" ? 24_000 : 100_000;

export interface AgyJson {
  response: string;
  status?: string;
  usage?: TokenUsage;
}

/** Find the JSON envelope ({response, status, usage}) in possibly noisy output. */
export function parseAgyJson(output: string): AgyJson | undefined {
  const candidates: number[] = [];
  for (let i = 0; i < output.length; i++) {
    if (output[i] === "{" && (i === 0 || output[i - 1] === "\n")) candidates.push(i);
  }
  for (const start of candidates.reverse()) {
    const end = output.lastIndexOf("}");
    if (end < start) continue;
    try {
      const v = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
      if (typeof v !== "object" || v === null) continue;
      const response = typeof v.response === "string" ? v.response : undefined;
      if (response === undefined && typeof v.status !== "string") continue;
      const out: AgyJson = { response: response ?? "" };
      if (typeof v.status === "string") out.status = v.status;
      const usage = extractUsage(v.usage);
      if (usage) out.usage = usage;
      return out;
    } catch {
      /* try previous candidate */
    }
  }
  return undefined;
}

function extractUsage(u: unknown): TokenUsage | undefined {
  if (typeof u !== "object" || u === null) return undefined;
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const [k, v] of Object.entries(u as Record<string, unknown>)) {
    if (typeof v !== "number") continue;
    const key = k.toLowerCase();
    if (/cache/.test(key)) cached += v;
    else if (/input|prompt/.test(key)) input += v;
    else if (/output|candidates|completion/.test(key)) output += v;
  }
  return input || output ? { inputTokens: input, cachedInputTokens: cached, outputTokens: output } : undefined;
}

export class AntigravityAdapter implements ProviderAdapter {
  readonly name = "antigravity" as const;

  constructor(private readonly cfg: ProviderConfig) {}

  private get bin(): string {
    return this.cfg.binaryPath ?? "agy";
  }

  async isAvailable(): Promise<boolean> {
    return this.cfg.enabled && findInPath(this.bin) !== undefined;
  }

  buildArgs(req: ProviderRequest, prompt: string): string[] {
    const args: string[] = [];
    const model = req.model ?? this.cfg.model;
    if (model) args.push(this.cfg.modelFlag ?? "--model", model);
    if (this.cfg.outputFormat === "json") args.push("--output-format", "json");
    args.push(...((req.mode === "write" ? this.cfg.writeModeArgs : this.cfg.readModeArgs) ?? []));
    args.push(...this.cfg.extraArgs);
    args.push("-p", prompt);
    return args;
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    const patterns = effectiveErrorPatterns("antigravity", this.cfg);
    // Very long prompts don't fit in argv: hand them over through a file in the worktree.
    let prompt = req.prompt;
    let promptFile: string | undefined;
    if (prompt.length > MAX_ARG_PROMPT) {
      promptFile = path.join(req.cwd, `.mp-task-${randomBytes(4).toString("hex")}.md`);
      await fs.writeFile(promptFile, prompt, "utf8");
      prompt =
        `Your full task description is in the file ${path.basename(promptFile)} in the current directory. ` +
        `Read it completely and follow it exactly. Do not modify or delete that file.`;
    }
    const notes: string[] = [];
    try {
      const r = await runProcess({
        command: this.bin,
        args: this.buildArgs(req, prompt),
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
        env: { NO_COLOR: "1", ...req.env },
        usePty: this.cfg.usePty ?? true,
      });
      notes.push(...r.notes);
      const model = req.model ?? this.cfg.model;
      const base = { exitCode: r.exitCode, durationMs: r.durationMs, notes, ...(model ? { model } : {}) };
      // Under a PTY stderr is merged into stdout.
      const combined = [r.stdout, r.stderr].filter(Boolean).join("\n");

      let output = r.stdout.trim();
      let usage: TokenUsage | undefined;
      if (this.cfg.outputFormat === "json" && r.exitCode === 0 && !r.timedOut) {
        const env = parseAgyJson(r.stdout);
        if (!env) {
          return { ...base, ok: false, output: "", error: { type: "PARSE_ERROR", message: `no JSON envelope in output: ${excerpt(r.stdout, 200)}` } };
        }
        if (env.status && /^running$/i.test(env.status)) {
          return { ...base, ok: false, output: env.response, error: { type: "TIMEOUT", message: "agy reported status RUNNING (print timeout)" } };
        }
        if (env.status && /error|fail/i.test(env.status)) {
          const failure = classifyFailure({ exitCode: 1, timedOut: false }, combined, patterns);
          return { ...base, ok: false, output: env.response, error: failure ?? { type: "NON_ZERO_EXIT", message: `status ${env.status}` } };
        }
        output = env.response.trim();
        usage = env.usage;
      }

      const clean = r.exitCode === 0 && !r.timedOut && output !== "" && !looksLikeOnlyError(output, patterns);
      const failure = clean ? undefined : classifyFailure(r, combined, patterns);
      if (failure) return { ...base, ok: false, output, error: failure };
      if (!output) return { ...base, ok: false, output: "", error: { type: "EMPTY_OUTPUT", message: "agy produced no output" } };
      return { ...base, ok: true, output, ...(usage ? { usage } : {}) };
    } finally {
      if (promptFile) await fs.rm(promptFile, { force: true }).catch(() => undefined);
    }
  }

  async healthCheck(): Promise<HealthReport> {
    const checkedAt = new Date().toISOString();
    const binary = findInPath(this.bin);
    const report: HealthReport = { provider: "antigravity", enabled: this.cfg.enabled, installed: !!binary, auth: "unknown", checkedAt };
    if (!binary) return { ...report, error: `'${this.bin}' not found in PATH` };
    report.binary = binary;
    const v = await runProcess({ command: this.bin, args: this.cfg.versionArgs ?? ["--version"], cwd: process.cwd(), timeoutMs: 15_000 });
    if (v.exitCode === 0) report.version = (v.stdout || v.stderr).trim().split(/\r?\n/)[0];
    else report.error = `version check failed (exit ${v.exitCode ?? "none"})`;

    // agy has no documented auth-status command. Only probe when explicitly configured
    // (e.g. ["-p", "Reply with OK"] — note this consumes a request).
    const authArgs = this.cfg.authCheckArgs ?? [];
    if (authArgs.length > 0) {
      const a = await runProcess({ command: this.bin, args: authArgs, cwd: process.cwd(), timeoutMs: 60_000, usePty: this.cfg.usePty ?? true });
      const text = `${a.stdout}\n${a.stderr}`;
      const failure = classifyFailure(a, text, effectiveErrorPatterns("antigravity", this.cfg));
      report.auth = failure?.type === "AUTH" ? "missing" : failure ? "unknown" : "ok";
      if (failure) report.authDetail = failure.type;
    }
    return report;
  }
}

/** A single short line that matches an AUTH/QUOTA pattern is an error, not an answer. */
function looksLikeOnlyError(output: string, patterns: ReturnType<typeof effectiveErrorPatterns>): boolean {
  if (output.length > 300 || output.includes("\n")) return false;
  return [...(patterns.AUTH ?? []), ...(patterns.QUOTA ?? [])].some((re) => re.test(output));
}
