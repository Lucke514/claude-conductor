import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { checkHealth, makeAdapters, type ProviderStatus } from "./health.js";
import { ptyAvailable } from "./process.js";
import { PROVIDER_NAMES, type ProviderAdapter, type ProviderName } from "./providers/types.js";
import type { StateStore } from "./state.js";

export type CheckLevel = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  level: CheckLevel;
  detail: string;
  /** One concrete fix, when the check is not ok. */
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  projectDir: string;
  store: StateStore;
  /** Run a real one-line prompt against each provider (costs a few tokens). */
  live: boolean;
  liveTimeoutMs?: number;
  adapters?: Record<ProviderName, ProviderAdapter>;
}

const SMOKE_PROMPT = "This is a connectivity check. Do not read or modify any file. Reply with exactly: OK";

function gitVersion(): string | undefined {
  try {
    return execFileSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function providerCheck(st: ProviderStatus): DoctorCheck {
  const name = `${st.provider}: install & auth`;
  if (!st.enabled) return { name, level: "skip", detail: "disabled in config" };
  if (!st.installed) {
    const fix = st.provider === "codex" ? "npm i -g @openai/codex, or set providers.codex.binaryPath" : "install the Antigravity CLI (agy), or set providers.antigravity.binaryPath";
    return { name, level: "fail", detail: st.error ?? "binary not found", fix };
  }
  const where = `${st.binary ?? "?"}${st.version ? ` (${st.version})` : ""}`;
  if (st.auth === "missing") {
    const fix = st.provider === "codex" ? "codex login" : "run agy interactively once to sign in";
    return { name, level: "fail", detail: `${where}, not authenticated`, fix };
  }
  if (st.breaker.state === "open") {
    return { name, level: "warn", detail: `${where}, circuit breaker open for ${Math.ceil(st.breaker.remainingCooldownMs / 1000)}s`, fix: "wait for the cooldown" };
  }
  const auth = st.auth === "ok" ? "authenticated" : "auth not verifiable (checked by the live run)";
  return { name, level: st.auth === "ok" ? "ok" : "warn", detail: `${where}, ${auth}` };
}

/**
 * End-to-end self check: environment, config, each provider's binary/auth and,
 * with `live`, a real one-line run through the same adapter `delegate` uses.
 * The live run happens in a throwaway git repo, never in the user's project.
 */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    major >= 20
      ? { name: "node", level: "ok", detail: `v${process.versions.node}` }
      : { name: "node", level: "fail", detail: `v${process.versions.node}`, fix: "install Node.js 20 or newer" },
  );

  const git = gitVersion();
  checks.push(git ? { name: "git", level: "ok", detail: git } : { name: "git", level: "fail", detail: "git not found", fix: "install git (worktrees need it)" });

  let loaded;
  try {
    loaded = await loadConfig(opts.projectDir);
  } catch (err) {
    checks.push({ name: "config", level: "fail", detail: (err as Error).message, fix: "fix the file named above (/providers-config shows the schema)" });
    return { ok: false, checks };
  }
  const files = loaded.sources.filter((s) => s.loaded).map((s) => s.path);
  checks.push({ name: "config", level: "ok", detail: files.length ? `valid (${files.join(", ")})` : "valid (defaults only)" });
  const { config } = loaded;

  const agy = config.providers.antigravity;
  if (agy.enabled && (agy.usePty ?? true)) {
    checks.push(
      (await ptyAvailable())
        ? { name: "node-pty", level: "ok", detail: "loaded" }
        : { name: "node-pty", level: "warn", detail: "not loadable; agy will run without a TTY", fix: "npm --prefix server install (needs build tools), or set providers.antigravity.usePty: false" },
    );
  }

  const adapters = opts.adapters ?? makeAdapters(config);
  const statuses = await checkHealth(config, opts.store, adapters);
  for (const st of statuses) checks.push(providerCheck(st));

  for (const p of PROVIDER_NAMES) {
    const st = statuses.find((s) => s.provider === p)!;
    const name = `${p}: live run`;
    if (!opts.live) {
      checks.push({ name, level: "skip", detail: "skipped (--no-live)" });
      continue;
    }
    if (!st.enabled || !st.installed || st.auth === "missing") {
      checks.push({ name, level: "skip", detail: "provider not usable, see above" });
      continue;
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), "mp-doctor-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
      const r = await adapters[p].run({ prompt: SMOKE_PROMPT, cwd: dir, mode: "read", timeoutMs: opts.liveTimeoutMs ?? 120_000 });
      const secs = (r.durationMs / 1000).toFixed(1);
      if (r.ok) {
        const reply = r.output.trim().split(/\r?\n/)[0]!.slice(0, 60);
        checks.push({ name, level: "ok", detail: `replied "${reply}" in ${secs}s${r.model ? ` (${r.model})` : ""}${r.notes?.length ? `; ${r.notes.join("; ")}` : ""}` });
      } else {
        checks.push({ name, level: "fail", detail: `${r.error?.type ?? "ERROR"} after ${secs}s: ${r.error?.message ?? "no output"}`, fix: liveFix(p, r.error?.type) });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return { ok: checks.every((c) => c.level !== "fail"), checks };
}

function liveFix(p: ProviderName, type: string | undefined): string {
  switch (type) {
    case "AUTH":
      return p === "codex" ? "codex login" : "run agy interactively once to sign in";
    case "QUOTA":
    case "RATE_LIMIT":
      return "wait for the provider's limit to reset; delegate falls back meanwhile";
    case "TIMEOUT":
      return p === "antigravity" ? "check that node-pty loads, or raise providers.antigravity.timeoutMs" : `raise providers.${p}.timeoutMs`;
    case "PARSE_ERROR":
      return p === "codex" ? "the CLI output format changed: check `codex exec --json` and providers.codex.extraArgs" : "try providers.antigravity.outputFormat: \"text\"";
    default:
      return `run the CLI by hand to see the error, then adjust providers.${p}.extraArgs / readModeArgs`;
  }
}

const ICON: Record<CheckLevel, string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };

export function formatDoctor(r: DoctorReport): string {
  const width = Math.max(...r.checks.map((c) => c.name.length));
  const lines = r.checks.map((c) => `${ICON[c.level]} ${c.name.padEnd(width)}  ${c.detail}${c.fix ? `\n  ${" ".repeat(width)}  fix: ${c.fix}` : ""}`);
  lines.push("", r.ok ? "doctor: all checks passed" : "doctor: some checks failed");
  return lines.join("\n");
}
