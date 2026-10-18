import { statePath } from "./paths.js";
import { readJson, withLock, writeFileAtomic } from "./fsutil.js";
import type { AuthState, ErrorType, ProviderName, TokenUsage } from "./providers/types.js";

/**
 * Shared on-disk state (~/.claude/multi-provider/state.json). Read by the
 * status line (never by invoking CLIs), written atomically by the MCP server
 * after every delegation and every health check.
 */

export type BreakerStateName = "closed" | "open" | "half_open";

export interface BreakerSnapshot {
  state: BreakerStateName;
  consecutiveFailures: number;
  openedAt: number | null;
  cooldownUntil: number | null;
}

export interface HealthSnapshot {
  installed: boolean;
  enabled: boolean;
  version?: string;
  auth: AuthState;
  checkedAt: string;
}

export interface ProviderMetrics {
  day: string;
  callsToday: number;
  tokensToday: number;
  durationMsToday: number;
  callsTotal: number;
  tokensTotal: number;
  durationMsTotal: number;
  lastError: { type: ErrorType | "CIRCUIT_OPEN"; message: string; at: string } | null;
  lastCallAt: string | null;
}

export interface SessionMetrics {
  lastAt: string;
  providers: Partial<Record<ProviderName, { calls: number; tokens: number; durationMs: number }>>;
}

/** One call, newest last (sparkline in the conductor card). */
export interface CallPoint {
  at: string;
  ok: boolean;
  tokens: number;
  durationMs: number;
}

export interface ProviderState {
  breaker?: BreakerSnapshot;
  health?: HealthSnapshot;
  metrics?: ProviderMetrics;
  history?: CallPoint[];
}

/** One delegation as the conductor card lists it, newest first. */
export interface RecentDelegation {
  id: string;
  at: string;
  requested: string;
  provider: ProviderName | null;
  mode: "read" | "write";
  status: string;
  /** First characters of the task, for the card only (never in the audit log). */
  task: string;
  filesChanged?: number;
  durationMs: number;
  sdd?: { slug: string; taskId: string };
  /** Guardrail violations of this delegation, for the SDD pipeline's warnings. */
  violations?: { type: string; detail: string }[];
}

export interface MpState {
  version: 1;
  updatedAt: string;
  chain: string[];
  providers: Partial<Record<ProviderName, ProviderState>>;
  /** Keyed by Claude Code session_id when known, else by MCP server instance id. */
  sessions: Record<string, SessionMetrics>;
  recent?: RecentDelegation[];
}

const MAX_SESSIONS = 30;
export const MAX_HISTORY = 10;
export const MAX_RECENT = 8;
export const TASK_LABEL_CHARS = 60;

export function emptyState(): MpState {
  return { version: 1, updatedAt: new Date().toISOString(), chain: [], providers: {}, sessions: {} };
}

export const today = (d = new Date()): string => d.toISOString().slice(0, 10);

export function emptyMetrics(day = today()): ProviderMetrics {
  return {
    day,
    callsToday: 0,
    tokensToday: 0,
    durationMsToday: 0,
    callsTotal: 0,
    tokensTotal: 0,
    durationMsTotal: 0,
    lastError: null,
    lastCallAt: null,
  };
}

export class StateStore {
  constructor(private readonly file: string = statePath()) {}

  async read(): Promise<MpState> {
    const s = await readJson<MpState>(this.file);
    if (!s || s.version !== 1) return emptyState();
    s.providers ??= {};
    s.sessions ??= {};
    return s;
  }

  /** Read-modify-write under a lock, persisted atomically (temp + rename). */
  async update(mutator: (s: MpState) => void): Promise<MpState> {
    return withLock(this.file, async () => {
      const s = await this.read();
      mutator(s);
      s.updatedAt = new Date().toISOString();
      pruneSessions(s);
      await writeFileAtomic(this.file, JSON.stringify(s, null, 2));
      return s;
    });
  }
}

function pruneSessions(s: MpState): void {
  const entries = Object.entries(s.sessions);
  if (entries.length <= MAX_SESSIONS) return;
  entries.sort((a, b) => b[1].lastAt.localeCompare(a[1].lastAt));
  s.sessions = Object.fromEntries(entries.slice(0, MAX_SESSIONS));
}

export interface CallRecord {
  provider: ProviderName;
  durationMs: number;
  usage?: TokenUsage;
  error?: { type: ErrorType | "CIRCUIT_OPEN"; message: string };
  sessionKey: string;
}

export function recordCall(s: MpState, rec: CallRecord, now = new Date()): void {
  const p = (s.providers[rec.provider] ??= {});
  let m = p.metrics ?? emptyMetrics(today(now));
  if (m.day !== today(now)) {
    m = { ...m, day: today(now), callsToday: 0, tokensToday: 0, durationMsToday: 0 };
  }
  const tokens = rec.usage ? rec.usage.inputTokens + rec.usage.outputTokens : 0;
  m.callsToday++;
  m.callsTotal++;
  m.tokensToday += tokens;
  m.tokensTotal += tokens;
  m.durationMsToday += rec.durationMs;
  m.durationMsTotal += rec.durationMs;
  m.lastCallAt = now.toISOString();
  if (rec.error) m.lastError = { ...rec.error, message: rec.error.message.slice(0, 200), at: now.toISOString() };
  p.metrics = m;
  const hist = p.history ?? [];
  hist.push({ at: now.toISOString(), ok: !rec.error, tokens, durationMs: rec.durationMs });
  p.history = hist.slice(-MAX_HISTORY);

  const sess = (s.sessions[rec.sessionKey] ??= { lastAt: now.toISOString(), providers: {} });
  sess.lastAt = now.toISOString();
  const sp = (sess.providers[rec.provider] ??= { calls: 0, tokens: 0, durationMs: 0 });
  sp.calls++;
  sp.tokens += tokens;
  sp.durationMs += rec.durationMs;
}

export function taskLabel(task: string): string {
  const oneLine = task.replace(/\s+/g, " ").trim();
  return oneLine.length > TASK_LABEL_CHARS ? `${oneLine.slice(0, TASK_LABEL_CHARS - 1)}…` : oneLine;
}

export function recordRecent(s: MpState, d: RecentDelegation): void {
  s.recent = [d, ...(s.recent ?? []).filter((r) => r.id !== d.id)].slice(0, MAX_RECENT);
}
