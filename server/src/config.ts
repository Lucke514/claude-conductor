import { promises as fs } from "node:fs";
import { z } from "zod";
import { projectConfigPath, userConfigPath } from "./paths.js";
import { ERROR_TYPES, PROVIDER_NAMES, type ErrorType, type ProviderName } from "./providers/types.js";

const ChainEntry = z.enum([...PROVIDER_NAMES, "claude"]);
const ErrorPatterns = z.partialRecord(z.enum(ERROR_TYPES), z.array(z.string()));

const ProviderSchema = z.object({
  enabled: z.boolean().default(true),
  /** Binary name or absolute path. */
  binaryPath: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  /** Appended verbatim to the CLI argv (never through a shell). */
  extraArgs: z.array(z.string()).default([]),
  /** Run under a pseudo-terminal (node-pty). Antigravity defaults to true. */
  usePty: z.boolean().optional(),
  /** Regex sources (case-insensitive). A type given here replaces the built-in patterns for that type. */
  errorPatterns: ErrorPatterns.default({}),
  timeoutMs: z.number().int().positive().optional(),
  /** Flag used to pass the model. Codex: "-m". Antigravity: "--model". */
  modelFlag: z.string().optional(),
  /** Extra args added only in read / write mode. */
  readModeArgs: z.array(z.string()).optional(),
  writeModeArgs: z.array(z.string()).optional(),
  versionArgs: z.array(z.string()).optional(),
  /** argv for a cheap auth check (exit 0 = authenticated). Empty array disables it. */
  authCheckArgs: z.array(z.string()).optional(),
  /** Codex only: pass --skip-git-repo-check (worktrees live outside trusted dirs). */
  skipGitRepoCheck: z.boolean().optional(),
  /** Antigravity only: "text" (default) or "json" (--output-format json). */
  outputFormat: z.enum(["text", "json"]).optional(),
});

const RoutingTarget = z.union([
  z.enum(PROVIDER_NAMES),
  z.object({ provider: z.enum(PROVIDER_NAMES), keywords: z.array(z.string()).optional() }),
]);

export const ConfigSchema = z.object({
  chain: z.array(ChainEntry).min(1).default(["codex", "antigravity", "claude"]),
  routing: z.record(z.string(), RoutingTarget).default({}),
  defaults: z
    .object({
      mode: z.enum(["read", "write"]).default("read"),
      timeoutMs: z.number().int().positive().default(600_000),
      maxFileBytes: z.number().int().positive().default(64 * 1024),
      maxTotalBytes: z.number().int().positive().default(512 * 1024),
      maxDiffBytes: z.number().int().positive().default(200 * 1024),
    })
    .prefault({}),
  circuitBreaker: z
    .object({
      threshold: z.number().int().positive().default(3),
      cooldownMs: z.number().int().nonnegative().default(5 * 60_000),
    })
    .prefault({}),
  retry: z
    .object({
      maxRetries: z.number().int().nonnegative().default(2),
      baseDelayMs: z.number().int().nonnegative().default(2000),
      maxDelayMs: z.number().int().nonnegative().default(30_000),
      factor: z.number().positive().default(2),
      retryOn: z.array(z.enum(["RATE_LIMIT", "TIMEOUT"])).default(["RATE_LIMIT", "TIMEOUT"]),
    })
    .prefault({}),
  isolation: z
    .object({
      /** "worktree": read mode also runs in a disposable worktree (safe for CLIs without a sandbox). */
      readMode: z.enum(["worktree", "cwd"]).default("worktree"),
      /** Snapshot uncommitted (tracked) changes into the worktree base via `git stash create`. */
      includeUncommitted: z.boolean().default(true),
      /** Directories symlinked from the repo into each worktree (e.g. node_modules). */
      symlink: z.array(z.string()).default([]),
    })
    .prefault({}),
  verify: z
    .object({
      commands: z.array(z.union([z.string(), z.array(z.string()).min(1)])).default([]),
      timeoutMs: z.number().int().positive().default(300_000),
    })
    .prefault({}),
  statusline: z
    .object({
      mode: z.enum(["full", "compact", "off"]).default("compact"),
      /** Previous status line command to run and concatenate (set by /mp-setup). */
      compose: z.string().optional(),
    })
    .prefault({}),
  autoDelegate: z
    .object({
      /** Inject a delegation instruction on every user prompt (toggled with /mp-auto). */
      enabled: z.boolean().default(true),
    })
    .prefault({}),
  card: z
    .object({
      /** Conductor header (Claude Code mods). */
      enabled: z.boolean().default(true),
      /** "side": a pane beside the conversation (wide fullscreen terminal); "below": the band above the prompt. */
      placement: z.enum(["side", "below"]).default("side"),
    })
    .prefault({}),
  providers: z
    .object({
      codex: ProviderSchema.prefault({}),
      antigravity: ProviderSchema.prefault({}),
    })
    .prefault({}),
});

export type MpConfig = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderSchema>;

export interface LoadedConfig {
  config: MpConfig;
  sources: { path: string; loaded: boolean; error?: string }[];
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Deep merge: objects merge recursively, arrays and scalars are replaced. */
export function deepMerge(base: Json, override: Json): Json {
  if (isObj(base) && isObj(override)) {
    const out: { [k: string]: Json } = { ...base };
    for (const [k, v] of Object.entries(override)) {
      out[k] = k in out ? deepMerge(out[k]!, v) : v;
    }
    return out;
  }
  return override;
}

function isObj(v: Json): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class ConfigError extends Error {}

export function parseConfig(raw: unknown, label = "config"): MpConfig {
  const r = ConfigSchema.safeParse(raw ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(`invalid ${label}: ${issues}`);
  }
  for (const [key, target] of Object.entries(r.data.routing)) {
    const provider = typeof target === "string" ? target : target.provider;
    if (!r.data.providers[provider]) throw new ConfigError(`invalid ${label}: routing.${key} -> unknown provider`);
  }
  return r.data;
}

async function readJsonFile(file: string): Promise<{ data?: Json; error?: string; exists: boolean }> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    return { exists: true, error: (err as Error).message };
  }
  try {
    return { exists: true, data: JSON.parse(text) as Json };
  } catch (err) {
    return { exists: true, error: `JSON parse error: ${(err as Error).message}` };
  }
}

/**
 * Effective config = defaults <- <project>/.claude/multiprovider.json <- ~/.claude/multiprovider.json.
 * Each file is validated on its own (to report precise errors) and then the merge is validated.
 */
export async function loadConfig(projectDir: string): Promise<LoadedConfig> {
  const files = [projectConfigPath(projectDir), userConfigPath()];
  let merged: Json = {};
  const sources: LoadedConfig["sources"] = [];
  for (const file of files) {
    const r = await readJsonFile(file);
    if (r.error) throw new ConfigError(`${file}: ${r.error}`);
    if (!r.exists) {
      sources.push({ path: file, loaded: false });
      continue;
    }
    // Validate the file alone so the error message points at it.
    parseConfig(r.data, file);
    merged = deepMerge(merged, r.data ?? {});
    sources.push({ path: file, loaded: true });
  }
  return { config: parseConfig(merged, "merged config"), sources };
}

// ---------------------------------------------------------------------------
// Error patterns
// ---------------------------------------------------------------------------

const COMMON_PATTERNS: Partial<Record<ErrorType, string[]>> = {
  AUTH: ["\\b401\\b", "unauthori[sz]ed", "not logged in", "authentication required", "login required", "please (re-?)?log ?in"],
  QUOTA: ["usage limit", "quota exceeded", "exceeded your current quota", "insufficient_quota", "billing"],
  RATE_LIMIT: ["rate.?limit", "\\b429\\b", "too many requests"],
};

export const DEFAULT_ERROR_PATTERNS: Record<ProviderName, Partial<Record<ErrorType, string[]>>> = {
  codex: {
    AUTH: [...COMMON_PATTERNS.AUTH!, "refresh token", "token (has )?expired", "invalid api key"],
    QUOTA: [...COMMON_PATTERNS.QUOTA!, "hit your usage limit", "upgrade to plus"],
    RATE_LIMIT: [...COMMON_PATTERNS.RATE_LIMIT!, "at capacity", "high demand"],
  },
  antigravity: {
    AUTH: [...COMMON_PATTERNS.AUTH!, "failed to retrieve token", "keyring is locked", "unauthenticated", "permission_denied"],
    QUOTA: [...COMMON_PATTERNS.QUOTA!],
    RATE_LIMIT: [...COMMON_PATTERNS.RATE_LIMIT!, "resource.?exhausted"],
  },
};

export function effectiveErrorPatterns(provider: ProviderName, cfg: ProviderConfig): Partial<Record<ErrorType, RegExp[]>> {
  const out: Partial<Record<ErrorType, RegExp[]>> = {};
  const defaults = DEFAULT_ERROR_PATTERNS[provider];
  for (const type of ERROR_TYPES) {
    const sources = cfg.errorPatterns[type] ?? defaults[type];
    if (!sources) continue;
    out[type] = sources.map((s) => {
      try {
        return new RegExp(s, "i");
      } catch {
        // Invalid regex in config: treat as a literal substring.
        return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
    });
  }
  return out;
}
