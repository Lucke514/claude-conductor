import { isAttributable } from "./providers/types.js";
// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------
/** Order matters: AUTH beats QUOTA beats RATE_LIMIT ("429 quota exceeded" is QUOTA). */
const PATTERN_ORDER = ["AUTH", "QUOTA", "RATE_LIMIT"];
export function classifyFailure(run, text, patterns) {
    if (run.spawnError) {
        const code = run.spawnError.code;
        if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") {
            return { type: "NOT_INSTALLED", message: run.spawnError.message };
        }
        return { type: "NON_ZERO_EXIT", message: run.spawnError.message };
    }
    // Killed by the plugin: the exit code (null) says nothing about the provider.
    if (run.cancelled)
        return { type: "CANCELLED", message: "delegation cancelled" };
    if (run.stalled)
        return { type: "STALLED", message: "no output for the idle timeout; process was killed" };
    if (run.timedOut)
        return { type: "TIMEOUT", message: "process exceeded timeout and was killed" };
    if (run.exitCode === 127)
        return { type: "NOT_INSTALLED", message: "exit code 127 (command not found)" };
    // Patterns are checked even when exit code is 0: some CLIs print the error and exit 0.
    const matched = matchPatterns(text, patterns, run.exitCode === 0 ? ["AUTH", "QUOTA"] : PATTERN_ORDER);
    if (matched)
        return { type: matched, message: excerpt(text) };
    if (run.exitCode !== 0)
        return { type: "NON_ZERO_EXIT", message: `exit code ${run.exitCode}: ${excerpt(text)}` };
    return undefined;
}
export function matchPatterns(text, patterns, order = PATTERN_ORDER) {
    for (const type of order) {
        if (patterns[type]?.some((re) => re.test(text)))
            return type;
    }
    return undefined;
}
/** Last meaningful lines of output, length-capped. Never contains env or files. */
export function excerpt(text, max = 400) {
    const t = text.trim();
    return t.length > max ? `…${t.slice(t.length - max)}` : t;
}
const NO_RETRY = ["AUTH", "NOT_INSTALLED", "QUOTA"];
export function backoffDelay(retry, attempt) {
    const d = retry.baseDelayMs * Math.pow(retry.factor, attempt);
    return Math.min(retry.maxDelayMs, d);
}
/**
 * Build the order to try: an explicit provider goes first, followed by the rest
 * of the configured chain (unless fallback is disabled).
 */
export function resolveOrder(chain, first, fallback = true) {
    if (!first)
        return [...chain];
    if (!fallback)
        return [first];
    return [first, ...chain.filter((p) => p !== first)];
}
export async function runChain(order, deps) {
    const attempts = [];
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const cancelled = (provider, result) => ({
        status: "cancelled",
        ...(provider ? { provider } : {}),
        ...(result ? { result } : {}),
        attempts,
        summary: "delegation cancelled: no further provider was tried",
    });
    for (const entry of order) {
        if (deps.signal?.aborted)
            return cancelled();
        if (entry === "claude") {
            return { status: "fallback_to_claude", attempts, summary: summarize(attempts) };
        }
        const adapter = deps.adapters[entry];
        if (!adapter) {
            attempts.push({ provider: entry, skipped: "unknown_provider", error: "no adapter registered" });
            continue;
        }
        if (!deps.config.providers[entry].enabled) {
            attempts.push({ provider: entry, skipped: "disabled", error: "provider disabled in config" });
            continue;
        }
        if (!deps.breaker.canRequest(entry)) {
            const secs = Math.ceil(deps.breaker.remainingCooldownMs(entry) / 1000);
            attempts.push({ provider: entry, skipped: "circuit_open", error: `circuit breaker open (${secs}s cooldown left)` });
            continue;
        }
        for (let retry = 0;; retry++) {
            const result = await deps.execute(entry, adapter);
            await deps.onAttempt?.(entry, result);
            if (result.ok) {
                deps.breaker.onSuccess(entry);
                attempts.push({ provider: entry, ...(retry > 0 ? { retry } : {}), durationMs: result.durationMs });
                return { status: "success", provider: entry, result, attempts };
            }
            const type = result.error?.type ?? "NON_ZERO_EXIT";
            // A cancellation is never the provider's fault: no breaker, no retry, no next provider.
            if (type === "CANCELLED" || deps.signal?.aborted) {
                attempts.push({ provider: entry, errorType: "CANCELLED", error: "cancelled", durationMs: result.durationMs });
                return cancelled(entry, result);
            }
            if (isAttributable(type))
                deps.breaker.onFailure(entry);
            attempts.push({
                provider: entry,
                error: result.error?.message ?? "unknown error",
                errorType: type,
                retry,
                durationMs: result.durationMs,
            });
            const retryable = !NO_RETRY.includes(type) &&
                deps.config.retry.retryOn.includes(type) &&
                retry < deps.config.retry.maxRetries &&
                deps.breaker.canRequest(entry);
            if (!retryable)
                break;
            await sleep(backoffDelay(deps.config.retry, retry));
        }
    }
    return { status: "failed", attempts, summary: summarize(attempts) };
}
export function summarize(attempts) {
    if (attempts.length === 0)
        return "no provider was attempted";
    return attempts
        .map((a) => {
        const what = a.skipped ? `skipped (${a.skipped})` : a.errorType ? `${a.errorType}` : "ok";
        const retry = a.retry ? ` retry#${a.retry}` : "";
        return `${a.provider}${retry}: ${what}${a.error ? ` — ${a.error.slice(0, 160)}` : ""}`;
    })
        .join("; ");
}
// ---------------------------------------------------------------------------
// Routing for provider: "auto"
// ---------------------------------------------------------------------------
export function routeTask(task, routing, taskType) {
    if (taskType && routing[taskType]) {
        const t = routing[taskType];
        return { provider: typeof t === "string" ? t : t.provider, rule: taskType };
    }
    const lower = task.toLowerCase();
    for (const [rule, target] of Object.entries(routing)) {
        const keywords = typeof target === "string" ? [rule] : (target.keywords ?? [rule]);
        for (const kw of keywords) {
            const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(kw.toLowerCase())}`, "u");
            if (re.test(lower))
                return { provider: typeof target === "string" ? target : target.provider, rule };
        }
    }
    return undefined;
}
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//# sourceMappingURL=fallback.js.map