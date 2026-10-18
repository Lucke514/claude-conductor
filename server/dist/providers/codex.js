import { effectiveErrorPatterns } from "../config.js";
import { classifyFailure, excerpt } from "../fallback.js";
import { findInPath, runProcess } from "../process.js";
export function parseCodexJsonl(stdout) {
    const parsed = { finalMessage: "", errors: [], invalidLines: 0, eventCount: 0 };
    let usage;
    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        let ev;
        try {
            const v = JSON.parse(line);
            if (typeof v !== "object" || v === null || Array.isArray(v)) {
                parsed.invalidLines++;
                continue;
            }
            ev = v;
        }
        catch {
            parsed.invalidLines++;
            continue;
        }
        parsed.eventCount++;
        switch (ev.type) {
            case "thread.started":
                parsed.threadId = ev.thread_id;
                break;
            case "item.completed":
                if (ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
                    parsed.finalMessage = ev.item.text;
                }
                else if (ev.item?.type === "error" && ev.item.message) {
                    parsed.errors.push(ev.item.message);
                }
                break;
            case "turn.completed":
                if (ev.usage) {
                    usage ??= { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
                    usage.inputTokens += ev.usage.input_tokens ?? 0;
                    usage.cachedInputTokens += ev.usage.cached_input_tokens ?? 0;
                    usage.outputTokens += (ev.usage.output_tokens ?? 0) + (ev.usage.reasoning_output_tokens ?? 0);
                }
                break;
            case "turn.failed":
                parsed.errors.push(ev.error?.message ?? "turn failed");
                break;
            case "error":
                parsed.errors.push(ev.message ?? "error");
                break;
            default:
                break;
        }
    }
    if (usage)
        parsed.usage = usage;
    return parsed;
}
export class CodexAdapter {
    cfg;
    name = "codex";
    constructor(cfg) {
        this.cfg = cfg;
    }
    get bin() {
        return this.cfg.binaryPath ?? "codex";
    }
    async isAvailable() {
        return this.cfg.enabled && findInPath(this.bin) !== undefined;
    }
    buildArgs(req) {
        const args = ["exec", "--json", "--color", "never", "-C", req.cwd];
        args.push("--sandbox", req.mode === "write" ? "workspace-write" : "read-only");
        if (this.cfg.skipGitRepoCheck ?? true)
            args.push("--skip-git-repo-check");
        const model = req.model ?? this.cfg.model;
        if (model)
            args.push(this.cfg.modelFlag ?? "-m", model);
        args.push(...((req.mode === "write" ? this.cfg.writeModeArgs : this.cfg.readModeArgs) ?? []));
        args.push(...this.cfg.extraArgs);
        args.push("-");
        return args;
    }
    async run(req) {
        const patterns = effectiveErrorPatterns("codex", this.cfg);
        const r = await runProcess({
            command: this.bin,
            args: this.buildArgs(req),
            cwd: req.cwd,
            input: req.prompt,
            timeoutMs: req.timeoutMs,
            env: { NO_COLOR: "1", ...req.env },
            usePty: this.cfg.usePty ?? false,
            ...(req.signal ? { signal: req.signal } : {}),
            ...(req.onProgress ? { onOutput: req.onProgress } : {}),
        });
        const model = req.model ?? this.cfg.model;
        const base = { exitCode: r.exitCode, durationMs: r.durationMs, notes: r.notes, ...(model ? { model } : {}) };
        const parsed = parseCodexJsonl(r.stdout);
        if (r.cancelled)
            return { ...base, ok: false, output: parsed.finalMessage, error: { type: "CANCELLED", message: "delegation cancelled" } };
        const diagnostic = [r.stderr, ...parsed.errors].join("\n");
        const clean = r.exitCode === 0 && !r.timedOut && parsed.finalMessage.trim() !== "";
        const failure = clean ? undefined : classifyFailure(r, diagnostic, patterns);
        if (failure) {
            return { ...base, ok: false, output: parsed.finalMessage, error: failure, ...(parsed.usage ? { usage: parsed.usage } : {}) };
        }
        if (!parsed.finalMessage && parsed.invalidLines > 0) {
            return { ...base, ok: false, output: "", error: { type: "PARSE_ERROR", message: `no JSON events in output: ${excerpt(r.stdout, 200)}` } };
        }
        if (parsed.errors.length > 0 && !parsed.finalMessage) {
            return { ...base, ok: false, output: "", error: { type: "NON_ZERO_EXIT", message: excerpt(parsed.errors.join("; ")) } };
        }
        if (!parsed.finalMessage.trim()) {
            return { ...base, ok: false, output: "", error: { type: "EMPTY_OUTPUT", message: "codex produced no agent message" } };
        }
        return { ...base, ok: true, output: parsed.finalMessage, ...(parsed.usage ? { usage: parsed.usage } : {}) };
    }
    async healthCheck() {
        const checkedAt = new Date().toISOString();
        const binary = findInPath(this.bin);
        const report = { provider: "codex", enabled: this.cfg.enabled, installed: !!binary, auth: "unknown", checkedAt };
        if (!binary)
            return { ...report, error: `'${this.bin}' not found in PATH` };
        report.binary = binary;
        const v = await runProcess({ command: this.bin, args: this.cfg.versionArgs ?? ["--version"], cwd: process.cwd(), timeoutMs: 15_000 });
        if (v.exitCode === 0)
            report.version = (v.stdout || v.stderr).trim().split(/\r?\n/)[0];
        else
            report.error = `version check failed (exit ${v.exitCode ?? "none"})`;
        const authArgs = this.cfg.authCheckArgs ?? ["login", "status"];
        if (authArgs.length > 0) {
            // `codex login status` exits 0 when logged in and 1 otherwise. We only look at the
            // exit code and the first status line — never at ~/.codex/auth.json.
            const a = await runProcess({ command: this.bin, args: authArgs, cwd: process.cwd(), timeoutMs: 15_000 });
            report.auth = a.timedOut || a.spawnError ? "unknown" : a.exitCode === 0 ? "ok" : "missing";
            const line = (a.stderr || a.stdout).trim().split(/\r?\n/)[0] ?? "";
            // Strip anything that looks like a key fragment from the status line.
            report.authDetail = line.replace(/(sk-|key[ -])[\w*.-]+/gi, "$1***").slice(0, 120);
        }
        return report;
    }
}
//# sourceMappingURL=codex.js.map