import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { effectiveErrorPatterns } from "../config.js";
import { classifyFailure, excerpt } from "../fallback.js";
import { findInPath, runProcess } from "../process.js";
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
/** Write mode runs in a disposable worktree without git/GitHub credentials (sdd-guardrails R4/R5). */
export const DEFAULT_WRITE_ARGS = ["--dangerously-skip-permissions"];
const MAX_ARG_PROMPT = process.platform === "win32" ? 24_000 : 100_000;
/** Find the JSON envelope ({response, status, usage}) in possibly noisy output. */
export function parseAgyJson(output) {
    const candidates = [];
    for (let i = 0; i < output.length; i++) {
        if (output[i] === "{" && (i === 0 || output[i - 1] === "\n"))
            candidates.push(i);
    }
    for (const start of candidates.reverse()) {
        const end = output.lastIndexOf("}");
        if (end < start)
            continue;
        try {
            const v = JSON.parse(output.slice(start, end + 1));
            if (typeof v !== "object" || v === null)
                continue;
            const response = typeof v.response === "string" ? v.response : undefined;
            if (response === undefined && typeof v.status !== "string")
                continue;
            const out = { response: response ?? "" };
            if (typeof v.status === "string")
                out.status = v.status;
            const usage = extractUsage(v.usage);
            if (usage)
                out.usage = usage;
            return out;
        }
        catch {
            /* try previous candidate */
        }
    }
    return undefined;
}
function extractUsage(u) {
    if (typeof u !== "object" || u === null)
        return undefined;
    let input = 0;
    let output = 0;
    let cached = 0;
    for (const [k, v] of Object.entries(u)) {
        if (typeof v !== "number")
            continue;
        const key = k.toLowerCase();
        if (/cache/.test(key))
            cached += v;
        else if (/input|prompt/.test(key))
            input += v;
        else if (/output|candidates|completion/.test(key))
            output += v;
    }
    return input || output ? { inputTokens: input, cachedInputTokens: cached, outputTokens: output } : undefined;
}
export class AntigravityAdapter {
    cfg;
    name = "antigravity";
    constructor(cfg) {
        this.cfg = cfg;
    }
    get bin() {
        return this.cfg.binaryPath ?? "agy";
    }
    async isAvailable() {
        return this.cfg.enabled && findInPath(this.bin) !== undefined;
    }
    buildArgs(req, prompt) {
        const args = [];
        const model = req.model ?? this.cfg.model;
        if (model)
            args.push(this.cfg.modelFlag ?? "--model", model);
        if (this.cfg.outputFormat === "json")
            args.push("--output-format", "json");
        // Headless write mode cannot answer permission prompts: skip them inside the isolated worktree (R2).
        args.push(...((req.mode === "write" ? (this.cfg.writeModeArgs ?? DEFAULT_WRITE_ARGS) : this.cfg.readModeArgs) ?? []));
        args.push(...this.cfg.extraArgs);
        args.push("-p", prompt);
        return args;
    }
    async run(req) {
        const patterns = effectiveErrorPatterns("antigravity", this.cfg);
        // Very long prompts don't fit in argv: hand them over through a file in the worktree.
        let prompt = req.prompt;
        let promptFile;
        if (prompt.length > MAX_ARG_PROMPT) {
            promptFile = path.join(req.cwd, `.mp-task-${randomBytes(4).toString("hex")}.md`);
            await fs.writeFile(promptFile, prompt, "utf8");
            prompt =
                `Your full task description is in the file ${path.basename(promptFile)} in the current directory. ` +
                    `Read it completely and follow it exactly. Do not modify or delete that file.`;
        }
        const notes = [];
        try {
            const r = await runProcess({
                command: this.bin,
                args: this.buildArgs(req, prompt),
                cwd: req.cwd,
                timeoutMs: req.timeoutMs,
                env: { NO_COLOR: "1", ...req.env },
                usePty: this.cfg.usePty ?? true,
                ...(req.signal ? { signal: req.signal } : {}),
                ...(req.onProgress ? { onOutput: req.onProgress } : {}),
                ...(req.idleTimeoutMs ? { idleTimeoutMs: req.idleTimeoutMs } : {}),
            });
            notes.push(...r.notes);
            const model = req.model ?? this.cfg.model;
            const base = { exitCode: r.exitCode, durationMs: r.durationMs, notes, ...(model ? { model } : {}) };
            if (r.cancelled)
                return { ...base, ok: false, output: r.stdout.trim(), error: { type: "CANCELLED", message: "delegation cancelled" } };
            // Under a PTY stderr is merged into stdout.
            const combined = [r.stdout, r.stderr].filter(Boolean).join("\n");
            let output = r.stdout.trim();
            let usage;
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
            if (failure)
                return { ...base, ok: false, output, error: failure };
            if (!output)
                return { ...base, ok: false, output: "", error: { type: "EMPTY_OUTPUT", message: "agy produced no output" } };
            return { ...base, ok: true, output, ...(usage ? { usage } : {}) };
        }
        finally {
            if (promptFile)
                await fs.rm(promptFile, { force: true }).catch(() => undefined);
        }
    }
    async healthCheck() {
        const checkedAt = new Date().toISOString();
        const binary = findInPath(this.bin);
        const report = { provider: "antigravity", enabled: this.cfg.enabled, installed: !!binary, auth: "unknown", checkedAt };
        if (!binary)
            return { ...report, error: `'${this.bin}' not found in PATH` };
        report.binary = binary;
        const v = await runProcess({ command: this.bin, args: this.cfg.versionArgs ?? ["--version"], cwd: process.cwd(), timeoutMs: 15_000 });
        if (v.exitCode === 0)
            report.version = (v.stdout || v.stderr).trim().split(/\r?\n/)[0];
        else
            report.error = `version check failed (exit ${v.exitCode ?? "none"})`;
        // agy has no documented auth-status command. Only probe when explicitly configured
        // (e.g. ["-p", "Reply with OK"] — note this consumes a request).
        const authArgs = this.cfg.authCheckArgs ?? [];
        if (authArgs.length > 0) {
            const a = await runProcess({ command: this.bin, args: authArgs, cwd: process.cwd(), timeoutMs: 60_000, usePty: this.cfg.usePty ?? true });
            const text = `${a.stdout}\n${a.stderr}`;
            const failure = classifyFailure(a, text, effectiveErrorPatterns("antigravity", this.cfg));
            report.auth = failure?.type === "AUTH" ? "missing" : failure ? "unknown" : "ok";
            if (failure)
                report.authDetail = failure.type;
        }
        return report;
    }
}
/** A single short line that matches an AUTH/QUOTA pattern is an error, not an answer. */
function looksLikeOnlyError(output, patterns) {
    if (output.length > 300 || output.includes("\n"))
        return false;
    return [...(patterns.AUTH ?? []), ...(patterns.QUOTA ?? [])].some((re) => re.test(output));
}
//# sourceMappingURL=antigravity.js.map