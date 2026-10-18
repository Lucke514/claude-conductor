import { statePath } from "./paths.js";
import { readJson, withLock, writeFileAtomic } from "./fsutil.js";
import { isAttributable } from "./providers/types.js";
const MAX_SESSIONS = 30;
export const MAX_HISTORY = 10;
export const MAX_RECENT = 8;
export const TASK_LABEL_CHARS = 60;
export function emptyState() {
    return { version: 1, updatedAt: new Date().toISOString(), chain: [], providers: {}, sessions: {} };
}
export const today = (d = new Date()) => d.toISOString().slice(0, 10);
export function emptyMetrics(day = today()) {
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
    file;
    constructor(file = statePath()) {
        this.file = file;
    }
    async read() {
        const s = await readJson(this.file);
        if (!s || s.version !== 1)
            return emptyState();
        s.providers ??= {};
        s.sessions ??= {};
        return s;
    }
    /** Read-modify-write under a lock, persisted atomically (temp + rename). */
    async update(mutator) {
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
function pruneSessions(s) {
    const entries = Object.entries(s.sessions);
    if (entries.length <= MAX_SESSIONS)
        return;
    entries.sort((a, b) => b[1].lastAt.localeCompare(a[1].lastAt));
    s.sessions = Object.fromEntries(entries.slice(0, MAX_SESSIONS));
}
export function recordCall(s, rec, now = new Date()) {
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
    if (rec.error) {
        const entry = { ...rec.error, message: rec.error.message.slice(0, 200), at: now.toISOString() };
        if (isAttributable(rec.error.type))
            m.lastError = entry;
        else
            m.lastNotice = entry;
    }
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
export function taskLabel(task) {
    const oneLine = task.replace(/\s+/g, " ").trim();
    return oneLine.length > TASK_LABEL_CHARS ? `${oneLine.slice(0, TASK_LABEL_CHARS - 1)}…` : oneLine;
}
export function recordRecent(s, d) {
    s.recent = [d, ...(s.recent ?? []).filter((r) => r.id !== d.id)].slice(0, MAX_RECENT);
}
//# sourceMappingURL=state.js.map