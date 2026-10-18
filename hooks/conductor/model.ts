// Conductor card: pure view model. No engine imports, so it is unit-tested
// with Vitest (server/tests/card-model.test.ts) and reused by card.tsx.

export type Tone = "ok" | "warn" | "error" | "dim" | "text" | "brass";

export const PALETTE: Record<Tone, string> = {
  ok: "#5FD38D",
  warn: "#E8C25A",
  error: "#F06A6A",
  dim: "#7C8592",
  text: "#D6D9DE",
  brass: "#E0A85A",
};
export const BORDER = {
  idle: "#5A4527",
  active: "#E0A85A",
  firstUse: "#3A414C",
  degraded: "#6A2E2E",
  claudeOnly: "#262C35",
} as const;

export const PROVIDERS = ["codex", "antigravity"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export const SHORT: Record<string, string> = { codex: "codex", antigravity: "agy", claude: "claude" };

// --- state.json shape (subset written by the MCP server) ---------------------

export interface StateFile {
  chain?: string[];
  providers?: Partial<Record<ProviderName, ProviderStateFile>>;
  recent?: RecentFile[];
}
export interface ProviderStateFile {
  health?: { installed?: boolean; enabled?: boolean; auth?: string; version?: string };
  breaker?: { state?: string; consecutiveFailures?: number; cooldownUntil?: number | null };
  metrics?: {
    day?: string;
    callsToday?: number;
    tokensToday?: number;
    durationMsToday?: number;
    lastError?: { type: string; message?: string; at: string } | null;
    lastCallAt?: string | null;
  };
  history?: { at: string; ok: boolean; tokens: number; durationMs: number }[];
}
export interface RecentFile {
  id: string;
  at: string;
  requested?: string;
  provider: string | null;
  mode: string;
  status: string;
  task: string;
  filesChanged?: number;
  durationMs?: number;
}

export interface Running {
  provider: string;
  mode: string;
  task: string;
  startedAt: number;
}

export interface SessionTally {
  calls: number;
  tokens: number;
}

// --- formatting ---------------------------------------------------------------

export function fmtTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${n >= 1e4 ? Math.round(n / 1e3) : (n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${String(s % 60).padStart(2, "0")}s` : ""}`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
}

/** Countdown as mm:ss. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtAgo(iso: string, now: number): string {
  const d = now - Date.parse(iso);
  if (!Number.isFinite(d) || d < 45_000) return "ahora";
  const m = Math.round(d / 60_000);
  if (m < 60) return `hace ${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `hace ${h}h` : `hace ${Math.round(h / 24)}d`;
}

const SPARK = "▁▂▃▄▅▆▇█";

/** Last `n` calls as a sparkline (tokens, else duration); failed calls draw as ▁. */
export function sparkline(history: ProviderStateFile["history"], n = 5): string {
  const pts = (history ?? []).slice(-n);
  if (pts.length === 0) return "";
  const vals = pts.map((p) => (p.tokens > 0 ? p.tokens : p.durationMs));
  const max = Math.max(...vals, 1);
  return pts
    .map((p, i) => (p.ok ? SPARK[Math.min(SPARK.length - 1, Math.max(1, Math.round((vals[i]! / max) * (SPARK.length - 1))))] : SPARK[0]))
    .join("");
}

export function bar(value: number, max: number, width = 10): string {
  const filled = max > 0 ? Math.min(width, Math.round((value / max) * width)) : 0;
  return "▮".repeat(filled) + "▯".repeat(width - filled);
}

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// --- provider status ----------------------------------------------------------

export type StatusKind = "ok" | "cooldown" | "half_open" | "degraded" | "no_auth" | "not_installed" | "disabled" | "unknown";

export interface ProviderView {
  name: ProviderName;
  short: string;
  kind: StatusKind;
  tone: Tone;
  /** "● afinado", "◐ silencio 2m", "⊘ sin auth"… */
  badge: string;
  /** One-line detail for the compact row. */
  detail: string;
  /** What fixes it (blocking states only). */
  fix?: string;
  spark: string;
  usable: boolean;
  callsToday: number;
  tokensToday: number;
  durationMsToday: number;
  version?: string;
  auth?: string;
  breakerLine: string;
  cooldownMs: number;
}

const FIX: Record<ProviderName, { auth: string; install: string }> = {
  codex: { auth: "ejecuta codex login", install: "instala @openai/codex" },
  antigravity: { auth: "abre agy e inicia sesión", install: "instala Antigravity CLI" },
};

export function providerView(name: ProviderName, p: ProviderStateFile | undefined, now: number, today: string): ProviderView {
  const health = p?.health ?? {};
  const breaker = p?.breaker ?? {};
  const m = p?.metrics && p.metrics.day === today ? p.metrics : undefined;
  const calls = m?.callsToday ?? 0;
  const tokens = m?.tokensToday ?? 0;
  const dur = m?.durationMsToday ?? 0;
  const cooldownMs = breaker.state === "open" && breaker.cooldownUntil ? Math.max(0, breaker.cooldownUntil - now) : 0;
  const lastErr = p?.metrics?.lastError ?? null;
  const recentErr = lastErr && now - Date.parse(lastErr.at) < 10 * 60_000 && lastErr.at >= (p?.metrics?.lastCallAt ?? "");

  let kind: StatusKind;
  if (health.enabled === false) kind = "disabled";
  else if (health.installed === false) kind = "not_installed";
  else if (health.auth === "missing") kind = "no_auth";
  else if (cooldownMs > 0) kind = "cooldown";
  else if (breaker.state === "open" || breaker.state === "half_open") kind = "half_open";
  else if (recentErr) kind = "degraded";
  else if (!p?.health && !p?.metrics) kind = "unknown";
  else kind = "ok";

  const usage = [calls ? `${calls} llamada${calls === 1 ? "" : "s"}` : "", tokens ? `${fmtTokens(tokens)} tok` : "", dur ? fmtDuration(dur) : ""]
    .filter(Boolean)
    .join(" · ");
  const errType = lastErr?.type ?? "";
  const fails = breaker.consecutiveFailures ?? 0;

  const table: Record<StatusKind, { tone: Tone; badge: string; detail: string; fix?: string }> = {
    ok: { tone: "ok", badge: calls ? "● afinado" : "● listo", detail: usage || "sin llamadas hoy" },
    cooldown: {
      tone: "warn",
      badge: `◐ silencio ${fmtDuration(cooldownMs)}`,
      detail: `circuito abierto${errType ? ` · ${errType}${fails > 1 ? ` ×${fails}` : ""}` : ""}`,
    },
    half_open: { tone: "warn", badge: "◐ probando", detail: "circuito a prueba: la próxima llamada decide" },
    degraded: { tone: "warn", badge: "! inestable", detail: `${errType}${lastErr ? ` ${fmtAgo(lastErr.at, now)}` : ""}` },
    no_auth: { tone: "error", badge: "⊘ sin auth", detail: FIX[name].auth, fix: FIX[name].auth },
    not_installed: { tone: "error", badge: "✗ no instalado", detail: FIX[name].install, fix: FIX[name].install },
    disabled: { tone: "dim", badge: "– deshabilitado", detail: "enabled: false en la config" },
    unknown: { tone: "dim", badge: "· sin datos", detail: "aún sin health check" },
  };
  const t = table[kind];
  const breakerLine =
    kind === "cooldown"
      ? `circuito abierto · ${errType || "fallos"}${fails > 1 ? ` ×${fails}` : ""} · reintenta ${fmtClock(cooldownMs)}`
      : kind === "half_open"
        ? "circuito a prueba (half-open)"
        : `circuito cerrado · ${fails} fallo${fails === 1 ? "" : "s"} seguido${fails === 1 ? "" : "s"}`;

  return {
    name,
    short: SHORT[name]!,
    kind,
    ...t,
    spark: sparkline(p?.history),
    usable: kind === "ok" || kind === "degraded" || kind === "half_open" || kind === "unknown",
    callsToday: calls,
    tokensToday: tokens,
    durationMsToday: dur,
    ...(health.version ? { version: health.version } : {}),
    ...(health.auth ? { auth: health.auth } : {}),
    breakerLine,
    cooldownMs,
  };
}

// --- the card -----------------------------------------------------------------

export type CardKind = "running" | "first_use" | "claude_only" | "degraded" | "normal";

export interface ChainItem {
  name: string;
  struck: boolean;
}

export interface RecentView {
  id: string;
  time: string;
  who: string;
  mode: string;
  task: string;
  outcome: string;
  tone: Tone;
}

export interface CardView {
  kind: CardKind;
  border: string;
  chain: ChainItem[];
  summary: string;
  providers: ProviderView[];
  recent: RecentView[];
  last?: RecentView & { ago: string };
  running?: { provider: string; mode: string; task: string; elapsed: string; spinner: string };
  /** Max values for the expanded bars, shared across providers. */
  maxCalls: number;
  maxTokens: number;
  maxDuration: number;
}

const VERDICT_VIEW: Record<string, { text: string; tone: Tone }> = {
  ACCEPT: { text: "✓ ACCEPT", tone: "ok" },
  REQUEST_CHANGES: { text: "↻ REQUEST_CHANGES", tone: "warn" },
  DISCARD: { text: "✗ DISCARD", tone: "error" },
};

export function outcomeOf(r: RecentFile, verdict?: string): { text: string; tone: Tone } {
  if (verdict && VERDICT_VIEW[verdict]) return VERDICT_VIEW[verdict]!;
  if (r.status === "fallback_to_claude") return { text: "↪ fallback", tone: "text" };
  if (r.status === "failed") return { text: "✗ falló", tone: "error" };
  if (r.mode === "write" && r.filesChanged) return { text: `◇ diff ${r.filesChanged} archivo${r.filesChanged === 1 ? "" : "s"}`, tone: "brass" };
  return { text: "✓ ok", tone: "ok" };
}

function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function buildCard(input: {
  state: StateFile | undefined;
  now: number;
  running?: Running | null;
  verdicts?: Record<string, string>;
  session?: SessionTally;
  tick?: number;
}): CardView {
  const { now } = input;
  const today = new Date(now).toISOString().slice(0, 10);
  const state = input.state ?? {};
  const providers = PROVIDERS.map((p) => providerView(p, state.providers?.[p], now, today));
  const byName = new Map(providers.map((p) => [p.name as string, p]));
  const chainNames = state.chain?.length ? state.chain : ["codex", "antigravity", "claude"];
  const chain = chainNames.map((n) => ({ name: SHORT[n] ?? n, struck: n !== "claude" && !(byName.get(n)?.usable ?? false) }));

  const recent = (state.recent ?? []).slice(0, 3).map((r): RecentView => {
    const o = outcomeOf(r, input.verdicts?.[r.id]);
    const who = r.provider ? SHORT[r.provider] ?? r.provider : `${SHORT[r.requested ?? ""] ?? r.requested ?? "auto"}→claude`;
    return { id: r.id, time: clock(r.at), who, mode: r.mode, task: r.task, outcome: o.text, tone: o.tone };
  });

  const totalToday = providers.reduce((a, p) => a + p.callsToday, 0);
  const tokensToday = providers.reduce((a, p) => a + p.tokensToday, 0);
  const sess = input.session;
  const summary = sess && sess.calls > 0
    ? `sesión ${sess.calls} delegaci${sess.calls === 1 ? "ón" : "ones"}${sess.tokens ? ` · ${fmtTokens(sess.tokens)} tok` : ""}`
    : totalToday > 0
      ? `hoy ${totalToday} delegaci${totalToday === 1 ? "ón" : "ones"}${tokensToday ? ` · ${fmtTokens(tokensToday)} tok` : ""}`
      : "listo para delegar";

  const anyUsable = providers.some((p) => p.usable);
  const anyBlocked = providers.some((p) => p.tone === "error" || p.kind === "degraded");
  const firstUse = (state.recent ?? []).length === 0 && totalToday === 0;

  let kind: CardKind;
  if (input.running) kind = "running";
  else if (!anyUsable) kind = "claude_only";
  else if (anyBlocked) kind = "degraded";
  else if (firstUse) kind = "first_use";
  else kind = "normal";

  const border =
    kind === "running" ? BORDER.active
      : kind === "claude_only" ? BORDER.claudeOnly
        : kind === "degraded" ? BORDER.degraded
          : kind === "first_use" ? BORDER.firstUse
            : BORDER.idle;

  const view: CardView = {
    kind,
    border,
    chain,
    summary,
    providers,
    recent,
    maxCalls: Math.max(10, ...providers.map((p) => p.callsToday)),
    maxTokens: Math.max(1, ...providers.map((p) => p.tokensToday)),
    maxDuration: Math.max(1, ...providers.map((p) => p.durationMsToday)),
  };
  const first = (state.recent ?? [])[0];
  if (first && recent[0]) view.last = { ...recent[0], ago: fmtAgo(first.at, now) };
  if (input.running) {
    const r = input.running;
    view.running = {
      provider: SHORT[r.provider] ?? r.provider,
      mode: r.mode,
      task: r.task,
      elapsed: fmtClock(now - r.startedAt),
      spinner: SPINNER[(input.tick ?? 0) % SPINNER.length]!,
    };
  }
  return view;
}

/** Pulls VERDICT and an optional delegation id out of a worker agent's report. */
export function parseVerdict(text: string): { verdict: string; id?: string } | undefined {
  const m = text.match(/VERDICT:\s*(ACCEPT|REQUEST_CHANGES|DISCARD)\b/);
  if (!m) return undefined;
  const id = text.match(/delegation:\s*([0-9]{14}-[0-9a-f]{6})/)?.[1];
  return { verdict: m[1]!, ...(id ? { id } : {}) };
}
