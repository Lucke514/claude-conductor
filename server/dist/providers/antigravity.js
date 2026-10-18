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
/** Read mode plans only: agy proposes and does not act (nested-repos R7). */
export const DEFAULT_READ_ARGS = ["--mode", "plan"];
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
const PERMISSION_TOOLS = ["ask_permission", "ask_custom_permission"];
const WAITING_STATE = /wait|pending|approv|review|permission/i;
function parseEvent(line) {
    const t = line.trim();
    if (!t.startsWith("{"))
        return undefined;
    try {
        const v = JSON.parse(t);
        return typeof v === "object" && v !== null && !Array.isArray(v) ? v : undefined;
    }
    catch {
        return undefined;
    }
}
/** A permission request in one event, as the stream shows it. */
export function permissionRequest(ev) {
    const st = ev.step_update;
    if (!st)
        return undefined;
    const tool = st.tool_name ?? st.tool_info?.name ?? "";
    const waiting = st.requires_approval === true || (st.step_type === "tool" && !!st.state && WAITING_STATE.test(st.state));
    if (!waiting && !PERMISSION_TOOLS.includes(tool))
        return undefined;
    const params = st.tool_info?.parameters ?? {};
    const command = [params.CommandLine, params.command, params.Command].find((v) => typeof v === "string");
    return { tool: tool || "unknown", ...(command ? { command } : {}) };
}
/** One human line for delegation_status from an event, or undefined for text deltas and noise. */
export function progressFromEvent(ev) {
    const st = ev.step_update;
    if (ev.event === "result")
        return `result ${ev.result?.status ?? ""}`.trim();
    if (!st)
        return undefined;
    if (st.step_type === "tool") {
        const params = st.tool_info?.parameters ?? {};
        const arg = [params.CommandLine, params.AbsolutePath, params.TargetFile, params.Query].find((v) => typeof v === "string");
        return `${(st.state ?? "").toLowerCase()} ${st.tool_name ?? st.tool_info?.name ?? "tool"}${arg ? `: ${arg}` : ""}`.trim();
    }
    if (st.step_type === "agent_response" && st.state === "DONE")
        return "agent response done";
    return undefined;
}
/** agy --output-format stream-json: NDJSON events (init, step_update, result). */
export function parseAgyStream(output) {
    const out = { response: "", events: 0 };
    let deltas = "";
    for (const line of output.split(/\r?\n/)) {
        const ev = parseEvent(line);
        if (!ev)
            continue;
        out.events++;
        out.permission ??= permissionRequest(ev);
        const st = ev.step_update;
        if (st?.step_type === "agent_response" && typeof st.text_delta === "string")
            deltas += st.text_delta;
        if (ev.event === "result" && ev.result) {
            if (typeof ev.result.status === "string")
                out.status = ev.result.status;
            if (typeof ev.result.response === "string")
                out.response = ev.result.response;
            const usage = extractUsage(ev.result.usage);
            if (usage)
                out.usage = usage;
        }
    }
    if (!out.response)
        out.response = deltas;
    return out;
}
const UNKNOWN_FLAG = /unknown (flag|option)|unrecognized (flag|option|argument)|invalid (flag|option)/i;
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
        else if (/total/.test(key))
            continue;
        else if (/output|candidates|completion|thinking/.test(key))
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
    /** "stream-json" by default: events give progress, stall detection and permission requests. */
    get format() {
        return this.cfg.outputFormat ?? "stream-json";
    }
    buildArgs(req, prompt, format = this.format) {
        const args = [];
        const model = req.model ?? this.cfg.model;
        if (model)
            args.push(this.cfg.modelFlag ?? "--model", model);
        if (format !== "text")
            args.push("--output-format", format);
        // Headless write mode cannot answer permission prompts: skip them inside the isolated worktree (R2).
        args.push(...((req.mode === "write" ? (this.cfg.writeModeArgs ?? DEFAULT_WRITE_ARGS) : (this.cfg.readModeArgs ?? DEFAULT_READ_ARGS))));
        args.push(...this.cfg.extraArgs);
        args.push("-p", prompt);
        return args;
    }
    async run(req) {
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
            const first = await this.attempt(req, prompt, this.format, notes);
            // E2: an agy without --output-format stream-json gets one more try in text mode.
            if (first.retryAsText) {
                notes.push("this agy does not accept --output-format stream-json; ran in text mode (no progress or stall events)");
                return (await this.attempt(req, prompt, "text", notes)).result;
            }
            return first.result;
        }
        finally {
            if (promptFile)
                await fs.rm(promptFile, { force: true }).catch(() => undefined);
        }
    }
    async attempt(req, prompt, format, notes) {
        const patterns = effectiveErrorPatterns("antigravity", this.cfg);
        const stream = format === "stream-json";
        // A permission request ends the attempt at once instead of waiting for the idle or total limit (R3).
        const own = new AbortController();
        const onAbort = () => own.abort();
        if (req.signal?.aborted)
            own.abort();
        else
            req.signal?.addEventListener("abort", onAbort, { once: true });
        let permission;
        let pending = "";
        const onOutput = (chunk) => {
            // Text output is the answer itself (it can quote files): it keeps the idle clock alive but is not forwarded (E6).
            if (!stream)
                return;
            const lines = (pending + chunk).split(/\r?\n/);
            pending = lines.pop() ?? "";
            for (const line of lines) {
                const ev = parseEvent(line);
                if (!ev)
                    continue;
                const progress = progressFromEvent(ev);
                if (progress)
                    req.onProgress?.(`${progress}\n`);
                if (!permission && (permission = permissionRequest(ev)))
                    own.abort();
            }
        };
        let r;
        try {
            r = await runProcess({
                command: this.bin,
                args: this.buildArgs(req, prompt, format),
                cwd: req.cwd,
                timeoutMs: req.timeoutMs,
                env: { NO_COLOR: "1", ...req.env },
                // A PTY makes agy interactive (it may wait on prompts); stream-json needs none.
                usePty: this.cfg.usePty ?? !stream,
                signal: own.signal,
                onOutput,
                ...(req.idleTimeoutMs ? { idleTimeoutMs: req.idleTimeoutMs } : {}),
            });
        }
        finally {
            req.signal?.removeEventListener("abort", onAbort);
        }
        notes.push(...r.notes);
        const model = req.model ?? this.cfg.model;
        const base = { exitCode: r.exitCode, durationMs: r.durationMs, notes, ...(model ? { model } : {}) };
        const done = (result) => ({ result });
        if (permission) {
            const what = permission.command ? `${permission.tool}: ${permission.command}` : permission.tool;
            return done({
                ...base,
                ok: false,
                output: "",
                error: {
                    type: "PERMISSION_BLOCKED",
                    message: `agy waited for approval of ${what}. fix: set providers.antigravity.writeModeArgs (default ["--dangerously-skip-permissions"]) or readModeArgs`,
                },
            });
        }
        if (r.cancelled)
            return done({ ...base, ok: false, output: r.stdout.trim(), error: { type: "CANCELLED", message: "delegation cancelled" } });
        // Under a PTY stderr is merged into stdout.
        const combined = [r.stdout, r.stderr].filter(Boolean).join("\n");
        if (stream && r.exitCode !== 0 && !r.timedOut && !r.stalled && UNKNOWN_FLAG.test(combined))
            return { result: { ...base, ok: false, output: "" }, retryAsText: true };
        let output = r.stdout.trim();
        let usage;
        if (stream && r.exitCode === 0 && !r.timedOut && !r.stalled) {
            const parsed = parseAgyStream(r.stdout);
            if (parsed.events === 0 && r.stdout.trim()) {
                return done({ ...base, ok: false, output: "", error: { type: "PARSE_ERROR", message: `no stream-json events in output: ${excerpt(r.stdout, 200)}` } });
            }
            if (parsed.status && /^running$/i.test(parsed.status)) {
                return done({ ...base, ok: false, output: parsed.response, error: { type: "TIMEOUT", message: "agy reported status RUNNING (print timeout)" } });
            }
            if (parsed.status && /error|fail/i.test(parsed.status)) {
                const failure = classifyFailure({ exitCode: 1, timedOut: false }, combined, patterns);
                return done({ ...base, ok: false, output: parsed.response, error: failure ?? { type: "NON_ZERO_EXIT", message: `status ${parsed.status}` } });
            }
            output = parsed.response.trim();
            usage = parsed.usage;
        }
        if (format === "json" && r.exitCode === 0 && !r.timedOut) {
            const env = parseAgyJson(r.stdout);
            if (!env) {
                return done({ ...base, ok: false, output: "", error: { type: "PARSE_ERROR", message: `no JSON envelope in output: ${excerpt(r.stdout, 200)}` } });
            }
            if (env.status && /^running$/i.test(env.status)) {
                return done({ ...base, ok: false, output: env.response, error: { type: "TIMEOUT", message: "agy reported status RUNNING (print timeout)" } });
            }
            if (env.status && /error|fail/i.test(env.status)) {
                const failure = classifyFailure({ exitCode: 1, timedOut: false }, combined, patterns);
                return done({ ...base, ok: false, output: env.response, error: failure ?? { type: "NON_ZERO_EXIT", message: `status ${env.status}` } });
            }
            output = env.response.trim();
            usage = env.usage;
        }
        const clean = r.exitCode === 0 && !r.timedOut && !r.stalled && output !== "" && !looksLikeOnlyError(output, patterns);
        const failure = clean ? undefined : classifyFailure(r, combined, patterns);
        if (failure)
            return done({ ...base, ok: false, output, error: failure });
        if (!output)
            return done({ ...base, ok: false, output: "", error: { type: "EMPTY_OUTPUT", message: "agy produced no output" } });
        return done({ ...base, ok: true, output, ...(usage ? { usage } : {}) });
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