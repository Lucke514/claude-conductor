import { changedFiles, effectiveState, listWorktrees, worktreeAgeMs } from "./worktree.js";
/**
 * delegation-lifecycle R1 / Q1: the diffs that wait for the user (awaiting_review)
 * or were left by a failed worker (recoverable). They are never cleaned up by age,
 * so the card and /mp-doctor point at them, flagging the ones older than 7 days.
 */
export const PENDING_WARN_DAYS = 7;
const DAY_MS = 24 * 3600_000;
export async function pendingWorktrees(dirs, now = Date.now()) {
    const out = [];
    for (const meta of await listWorktrees(dirs)) {
        // Legacy metas (E1) count as pending only when they hold changes; a failed check keeps them.
        const hasChanges = meta.state === undefined ? await changedFiles(meta).then((f) => f.length > 0).catch(() => true) : false;
        const state = effectiveState(meta, hasChanges);
        if (state !== "awaiting_review" && state !== "recoverable")
            continue;
        out.push({ path: meta.path, repoRoot: meta.repoRoot, state, ageMs: worktreeAgeMs(meta, now) });
    }
    return out.sort((a, b) => b.ageMs - a.ageMs);
}
/** What state.json carries for the card: how many diffs wait and how old the oldest is. */
export function pendingSummary(list, now = Date.now()) {
    return { count: list.length, oldestDays: list.length ? Math.floor(list[0].ageMs / DAY_MS) : 0, at: new Date(now).toISOString() };
}
/** Recompute the summary in state.json; never fails the caller. */
export async function refreshPending(store, dirs) {
    try {
        const summary = pendingSummary(await pendingWorktrees(dirs));
        await store.update((s) => {
            s.pending = summary;
        });
    }
    catch {
        // The card just keeps the previous figure.
    }
}
//# sourceMappingURL=pending.js.map