import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type MpConfig, type ProviderConfig } from "./config.js";
import { checkHealth, makeAdapters, type ProviderStatus } from "./health.js";
import { ptyAvailable, runProcess } from "./process.js";
import { PROVIDER_NAMES, type ProviderAdapter, type ProviderName } from "./providers/types.js";
import { PENDING_WARN_DAYS, pendingWorktrees } from "./pending.js";
import { knownRepoDirs, workspaceRepos } from "./repo.js";
import { scanSecrets } from "./secrets-scan.js";
import { pluginRoot } from "./setup.js";
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
  /** Plugin root whose .mcp.json is checked (defaults to the running plugin). */
  pluginRoot?: string;
}

const SMOKE_PROMPT = "This is a connectivity check. Do not read or modify any file. Reply with exactly: OK";

function gitVersion(): string | undefined {
  try {
    return execFileSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the plugin's .mcp.json the way Claude Code does for plugins: only the
 * literal "${CLAUDE_PLUGIN_ROOT}" is replaced, so forms like "${CLAUDE_PLUGIN_ROOT:-.}"
 * fall back to their default and point at the user's project instead.
 */
export function mcpConfigCheck(root: string): DoctorCheck {
  const name = "mcp server config";
  const file = path.join(root, ".mcp.json");
  let servers: Record<string, { command?: string; args?: string[] }>;
  try {
    servers = JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {};
  } catch (err) {
    return { name, level: "fail", detail: `${file}: ${(err as Error).message}`, fix: "reinstall the plugin" };
  }
  for (const [id, srv] of Object.entries(servers)) {
    const args = (srv.args ?? []).map((a) => a.split("${CLAUDE_PLUGIN_ROOT}").join(root));
    const bad = args.find((a) => a.includes("${CLAUDE_PLUGIN_ROOT"));
    if (bad) return { name, level: "fail", detail: `${id}: "${bad}" is not resolved by Claude Code for plugins`, fix: 'use the exact "${CLAUDE_PLUGIN_ROOT}" placeholder in .mcp.json' };
    const entry = args.find((a) => /\.(m?js)$/.test(a));
    if (entry && !existsSync(entry)) return { name, level: "fail", detail: `${id}: ${entry} not found`, fix: "reinstall the plugin" };
  }
  return { name, level: "ok", detail: `${Object.keys(servers).join(", ") || "no servers"} resolve inside ${root}` };
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

  checks.push(mcpConfigCheck(opts.pluginRoot ?? pluginRoot()));
  checks.push(...(await workspaceChecks(opts.projectDir, config)));
  checks.push(await pendingCheck(knownRepoDirs(opts.projectDir, (await opts.store.read().catch(() => undefined))?.repos)));

  const agy = config.providers.antigravity;
  // stream-json (the default) runs without a PTY; only text/json need node-pty.
  if (agy.enabled && (agy.usePty ?? (agy.outputFormat ?? "stream-json") !== "stream-json")) {
    checks.push(
      (await ptyAvailable())
        ? { name: "node-pty", level: "ok", detail: "loaded" }
        : { name: "node-pty", level: "warn", detail: "not loadable; agy will run without a TTY", fix: "npm --prefix server install (needs build tools), or set providers.antigravity.usePty: false" },
    );
  }

  const adapters = opts.adapters ?? makeAdapters(config);
  const statuses = await checkHealth(config, opts.store, adapters);
  for (const st of statuses) checks.push(providerCheck(st));
  const codexSt = statuses.find((s) => s.provider === "codex");
  if (codexSt?.enabled && codexSt.installed) checks.push(await codexTransportCheck(config.providers.codex));
  const agySt = statuses.find((s) => s.provider === "antigravity");
  if (agySt?.enabled && agySt.installed) checks.push(await agyFlagsCheck(config.providers.antigravity));

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

/** Nested git repos a delegation can target with `repo`: top-level ones and the specs' worktrees. */
async function nestedRepos(projectDir: string): Promise<string[]> {
  const repos = await workspaceRepos(projectDir);
  const specs = path.join(projectDir, ".claude", "worktrees");
  for (const slug of subdirs(specs)) {
    for (const repo of await workspaceRepos(path.join(specs, slug))) repos.push(`.claude/worktrees/${slug}/${repo}`);
  }
  return repos;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** nested-repos R12: the repos `repo` / `**Repo**` can name, and whether readMode keeps their .env files away from workers. */
export async function workspaceChecks(projectDir: string, config: Pick<MpConfig, "isolation">): Promise<DoctorCheck[]> {
  const repos = await nestedRepos(projectDir);
  const withSecrets: string[] = [];
  for (const r of repos) if ((await scanSecrets(path.join(projectDir, ...r.split("/")))).found.length > 0) withSecrets.push(r);
  const checks: DoctorCheck[] = [
    repos.length === 0
      ? { name: "workspace repos", level: "skip", detail: "no nested git repos under the project" }
      : {
          name: "workspace repos",
          level: "ok",
          detail: `${repos.map((r) => (withSecrets.includes(r) ? `${r} (.env)` : r)).join(", ")} — delegate with \`repo\` or a task's **Repo**`,
        },
  ];
  if (config.isolation.readMode === "cwd") {
    const scan = await scanSecrets(projectDir);
    checks.push(
      scan.found.length > 0 || scan.truncated
        ? {
            name: "read isolation",
            level: "warn",
            detail: `readMode "cwd": workers read the real tree, where ${scan.found.length ? scan.found.join(", ") : "the .env scan hit its limit"}${scan.found.length && scan.truncated ? ", …" : ""} ${config.isolation.allowCwdWithSecrets ? "is reachable (allowCwdWithSecrets: true)" : "make read delegations fail with UNSAFE_READ_MODE"}`,
            fix: 'set isolation.readMode: "worktree" (ignored files never reach the worker)',
          }
        : { name: "read isolation", level: "ok", detail: 'readMode "cwd", no .env files reachable' },
    );
  } else {
    checks.push({
      name: "read isolation",
      level: "ok",
      detail:
        "worktree: ignored files (.env*) are never in the worker's directory. Residual: the CLIs' sandboxes do not block reads by absolute path outside it",
    });
  }
  return checks;
}

/** delegation-lifecycle R1/Q1: diffs that cleanup never removes, with their age. */
export async function pendingCheck(dirs: string | string[], now = Date.now()): Promise<DoctorCheck> {
  const name = "pending worktrees";
  const list = await pendingWorktrees(dirs, now).catch(() => []);
  if (list.length === 0) return { name, level: "ok", detail: "none: no diff awaits review" };
  const days = (ms: number) => Math.floor(ms / 86_400_000);
  const old = list.filter((p) => days(p.ageMs) >= PENDING_WARN_DAYS);
  return {
    name,
    level: old.length ? "warn" : "ok",
    detail: list.map((p) => `${p.state} ${days(p.ageMs)}d ${p.path}`).join("; "),
    ...(old.length ? { fix: "review each diff, then delegation_apply or delegation_discard it; delegation_cleanup { force: true } removes them all" } : {}),
  };
}

/** E1: which transport codex will really use. */
export async function codexTransportCheck(cfg: ProviderConfig): Promise<DoctorCheck> {
  const name = "codex: transport";
  if (cfg.transport === "exec") return { name, level: "ok", detail: "exec (providers.codex.transport)" };
  const r = await runProcess({ command: cfg.binaryPath ?? "codex", args: ["app-server", "--help"], cwd: process.cwd(), timeoutMs: 15_000 });
  return r.exitCode === 0
    ? { name, level: "ok", detail: "app-server (JSON-RPC; falls back to exec if it fails)" }
    : {
        name,
        level: "warn",
        detail: "exec: this codex has no app-server, so no progress events or clean interrupt",
        fix: "update codex (npm i -g @openai/codex), or set providers.codex.transport: \"exec\" to silence this",
      };
}

/** E2: the agy flags the defaults rely on. */
export async function agyFlagsCheck(cfg: ProviderConfig): Promise<DoctorCheck> {
  const name = "antigravity: flags";
  const r = await runProcess({ command: cfg.binaryPath ?? "agy", args: ["--help"], cwd: process.cwd(), timeoutMs: 15_000 });
  const help = `${r.stdout}\n${r.stderr}`;
  const missing = [
    (cfg.outputFormat ?? "stream-json") === "stream-json" && !/stream-json/.test(help) ? "--output-format stream-json" : "",
    !cfg.writeModeArgs && !/--dangerously-skip-permissions/.test(help) ? "--dangerously-skip-permissions" : "",
    !cfg.readModeArgs && !/--mode\b[^\n]*\bplan\b/.test(help) ? "--mode plan" : "",
  ].filter(Boolean);
  if (missing.length === 0) return { name, level: "ok", detail: "stream-json, --dangerously-skip-permissions and --mode plan available" };
  return {
    name,
    level: "warn",
    detail: `this agy does not list ${missing.join(" and ")}`,
    fix: "update Antigravity CLI, or set providers.antigravity.outputFormat: \"text\" / writeModeArgs / readModeArgs explicitly",
  };
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
