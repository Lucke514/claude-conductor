export const ERROR_TYPES = [
  "NOT_INSTALLED",
  "AUTH",
  "RATE_LIMIT",
  "QUOTA",
  "TIMEOUT",
  "NON_ZERO_EXIT",
  "EMPTY_OUTPUT",
  "PARSE_ERROR",
  /** The delegation was cancelled (MCP cancellation or delegation_cancel): never the provider's fault. */
  "CANCELLED",
  /** No output for `idleTimeoutMs`: killed by the plugin, not the provider's fault. */
  "STALLED",
  /** The worker waited for a permission the headless run cannot grant (configuration). */
  "PERMISSION_BLOCKED",
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

/**
 * The failures a provider is to blame for (R7). Everything else — cancelled, stalled, a
 * permission the headless run cannot grant, a binary that is not installed — never counts.
 */
const ATTRIBUTABLE: readonly string[] = ["AUTH", "QUOTA", "RATE_LIMIT", "PARSE_ERROR", "EMPTY_OUTPUT", "NON_ZERO_EXIT", "TIMEOUT"];

export function isAttributable(type: ErrorType | "CIRCUIT_OPEN"): boolean {
  return ATTRIBUTABLE.includes(type);
}

export const PROVIDER_NAMES = ["codex", "antigravity"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type Mode = "read" | "write";

export interface ProviderRequest {
  /** Fully self-contained prompt built by prompt-builder. */
  prompt: string;
  /** Directory the worker runs in (a git worktree in write mode). */
  cwd: string;
  mode: Mode;
  timeoutMs: number;
  model?: string;
  /** Extra environment for the child (e.g. GIT_CONFIG_* to force worktree hooks); `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  /** Aborting kills the worker's process tree. */
  signal?: AbortSignal;
  /** The worker's output as it arrives (progress, idle detection). */
  onProgress?: (chunk: string) => void;
  /** Kill the worker after this long without output (STALLED). */
  idleTimeoutMs?: number;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ProviderError {
  type: ErrorType;
  message: string;
}

export interface ProviderResult {
  ok: boolean;
  output: string;
  model?: string;
  usage?: TokenUsage;
  error?: ProviderError;
  exitCode: number | null;
  durationMs: number;
  /** Non-fatal notes, e.g. "node-pty unavailable, used plain spawn". */
  notes?: string[];
}

export type AuthState = "ok" | "missing" | "unknown";

export interface HealthReport {
  provider: ProviderName;
  enabled: boolean;
  installed: boolean;
  binary?: string;
  version?: string;
  auth: AuthState;
  authDetail?: string;
  error?: string;
  checkedAt: string;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  isAvailable(): Promise<boolean>;
  healthCheck(): Promise<HealthReport>;
  run(request: ProviderRequest): Promise<ProviderResult>;
}
