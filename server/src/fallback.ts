import type { CircuitBreaker } from "./circuit-breaker.js";
import type { MpConfig } from "./config.js";
import type { ErrorType, ProviderAdapter, ProviderError, ProviderName, ProviderResult } from "./providers/types.js";
import type { RunResult } from "./process.js";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** Order matters: AUTH beats QUOTA beats RATE_LIMIT ("429 quota exceeded" is QUOTA). */
const PATTERN_ORDER: ErrorType[] = ["AUTH", "QUOTA", "RATE_LIMIT"];

export function classifyFailure(
  run: Pick<RunResult, "exitCode" | "timedOut" | "spawnError">,
  text: string,
  patterns: Partial<Record<ErrorType, RegExp[]>>,
): ProviderError | undefined {
  if (run.spawnError) {
    const code = run.spawnError.code;
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") {
      return { type: "NOT_INSTALLED", message: run.spawnError.message };
    }
    return { type: "NON_ZERO_EXIT", message: run.spawnError.message };
  }
  if (run.timedOut) return { type: "TIMEOUT", message: "process exceeded timeout and was killed" };
  if (run.exitCode === 127) return { type: "NOT_INSTALLED", message: "exit code 127 (command not found)" };
  // Patterns are checked even when exit code is 0: some CLIs print the error and exit 0.
  const matched = matchPatterns(text, patterns, run.exitCode === 0 ? ["AUTH", "QUOTA"] : PATTERN_ORDER);
  if (matched) return { type: matched, message: excerpt(text) };
  if (run.exitCode !== 0) return { type: "NON_ZERO_EXIT", message: `exit code ${run.exitCode}: ${excerpt(text)}` };
  return undefined;
}

export function matchPatterns(
  text: string,
  patterns: Partial<Record<ErrorType, RegExp[]>>,
  order: ErrorType[] = PATTERN_ORDER,
): ErrorType | undefined {
  for (const type of order) {
    if (patterns[type]?.some((re) => re.test(text))) return type;
  }
  return undefined;
}

/** Last meaningful lines of output, length-capped. Never contains env or files. */
export function excerpt(text: string, max = 400): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(t.length - max)}` : t;
}

// ---------------------------------------------------------------------------
// Fallback chain
// ---------------------------------------------------------------------------

export type ChainEntry = ProviderName | "claude";

export interface Attempt {
  provider: ChainEntry;
  error?: string;
  errorType?: ErrorType;
  skipped?: "disabled" | "circuit_open" | "unknown_provider";
  retry?: number;
  durationMs?: number;
}

export type ChainStatus = "success" | "fallback_to_claude" | "failed";

export interface ChainOutcome {
  status: ChainStatus;
  provider?: ProviderName;
  result?: ProviderResult;
  attempts: Attempt[];
  /** Human-readable summary of what went wrong, for Claude to take over. */
  summary?: string;
}

export interface ChainDeps {
  adapters: Partial<Record<ProviderName, ProviderAdapter>>;
  breaker: CircuitBreaker;
  config: Pick<MpConfig, "retry" | "providers">;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Runs one attempt for a provider. Lets the caller wrap execution (create a
   * worktree, build env, etc.). Defaults to adapter.run with a fixed request.
   */
  execute: (provider: ProviderName, adapter: ProviderAdapter) => Promise<ProviderResult>;
  /** Called after every attempt (for metrics / state.json). */
  onAttempt?: (provider: ProviderName, result: ProviderResult) => Promise<void> | void;
}

const NO_RETRY: ErrorType[] = ["AUTH", "NOT_INSTALLED", "QUOTA"];

export function backoffDelay(retry: MpConfig["retry"], attempt: number): number {
  const d = retry.baseDelayMs * Math.pow(retry.factor, attempt);
  return Math.min(retry.maxDelayMs, d);
}

/**
 * Build the order to try: an explicit provider goes first, followed by the rest
 * of the configured chain (unless fallback is disabled).
 */
export function resolveOrder(chain: ChainEntry[], first?: ProviderName, fallback = true): ChainEntry[] {
  if (!first) return [...chain];
  if (!fallback) return [first];
  return [first, ...chain.filter((p) => p !== first)];
}

export async function runChain(order: ChainEntry[], deps: ChainDeps): Promise<ChainOutcome> {
  const attempts: Attempt[] = [];
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (const entry of order) {
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

    for (let retry = 0; ; retry++) {
      const result = await deps.execute(entry, adapter);
      await deps.onAttempt?.(entry, result);
      if (result.ok) {
        deps.breaker.onSuccess(entry);
        attempts.push({ provider: entry, ...(retry > 0 ? { retry } : {}), durationMs: result.durationMs });
        return { status: "success", provider: entry, result, attempts };
      }
      const type = result.error?.type ?? "NON_ZERO_EXIT";
      deps.breaker.onFailure(entry);
      attempts.push({
        provider: entry,
        error: result.error?.message ?? "unknown error",
        errorType: type,
        retry,
        durationMs: result.durationMs,
      });
      const retryable =
        !NO_RETRY.includes(type) &&
        (deps.config.retry.retryOn as ErrorType[]).includes(type) &&
        retry < deps.config.retry.maxRetries &&
        deps.breaker.canRequest(entry);
      if (!retryable) break;
      await sleep(backoffDelay(deps.config.retry, retry));
    }
  }
  return { status: "failed", attempts, summary: summarize(attempts) };
}

export function summarize(attempts: Attempt[]): string {
  if (attempts.length === 0) return "no provider was attempted";
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

export function routeTask(
  task: string,
  routing: MpConfig["routing"],
  taskType?: string,
): { provider: ProviderName; rule: string } | undefined {
  if (taskType && routing[taskType]) {
    const t = routing[taskType]!;
    return { provider: typeof t === "string" ? t : t.provider, rule: taskType };
  }
  const lower = task.toLowerCase();
  for (const [rule, target] of Object.entries(routing)) {
    const keywords = typeof target === "string" ? [rule] : (target.keywords ?? [rule]);
    for (const kw of keywords) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(kw.toLowerCase())}`, "u");
      if (re.test(lower)) return { provider: typeof target === "string" ? target : target.provider, rule };
    }
  }
  return undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
