import { changedFiles, readMeta, setMetaState } from "./worktree.js";
/**
 * Delegations in flight, so they can be watched (`delegation_status`) and stopped
 * (`delegation_cancel`) while the `delegate` call that started them is still
 * running. Lives in the MCP server's memory; `state.json → jobs` mirrors the
 * running ones for the conductor card. Progress lines are the worker's own
 * output, trimmed: never the prompt, file contents or environment.
 */
export const MAX_PROGRESS_LINES = 20;
export const MAX_PROGRESS_CHARS = 200;
/** state.json is rewritten at most this often for progress alone. */
const PERSIST_EVERY_MS = 1000;
const MAX_LOST = 10;
export function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        // EPERM: the process exists but belongs to someone else.
        return err.code === "EPERM";
    }
}
/** One progress line as shown: single-spaced, at most MAX_PROGRESS_CHARS (E6). */
export function progressLine(raw) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line)
        return undefined;
    return line.length > MAX_PROGRESS_CHARS ? `${line.slice(0, MAX_PROGRESS_CHARS - 1)}…` : line;
}
export class JobRegistry {
    store;
    jobs = new Map();
    constructor(store) {
        this.store = store;
    }
    /** Register a delegation; aborting `signal` (the MCP request's) cancels it too. */
    start(info, signal) {
        const controller = new AbortController();
        if (signal?.aborted)
            controller.abort();
        else
            signal?.addEventListener("abort", () => controller.abort(), { once: true });
        const job = {
            info: { ...info, phase: "running", startedAt: new Date().toISOString(), pid: process.pid },
            progress: [],
            controller,
            partial: "",
            persistedAt: 0,
        };
        this.jobs.set(info.id, job);
        void this.persist(job, true);
        return controller;
    }
    /** A new attempt started: its provider and, when isolated, its worktree. */
    setProvider(id, provider, worktree) {
        const job = this.jobs.get(id);
        if (!job)
            return;
        job.info.provider = provider;
        job.worktree = worktree;
        job.info.worktreePath = worktree?.path;
        void this.persist(job, true);
    }
    setPhase(id, phase, detail) {
        const job = this.jobs.get(id);
        if (!job || job.controller.signal.aborted)
            return;
        job.info.phase = phase;
        job.info.detail = detail ? progressLine(detail) : undefined;
        void this.persist(job, true);
    }
    /** A chunk of worker output: split into lines, trimmed, last MAX_PROGRESS_LINES kept. */
    progress(id, chunk) {
        const job = this.jobs.get(id);
        if (!job)
            return;
        const text = job.partial + chunk;
        const parts = text.split(/\r?\n/);
        job.partial = (parts.pop() ?? "").slice(-4 * MAX_PROGRESS_CHARS);
        for (const raw of parts) {
            const line = progressLine(raw);
            if (line)
                job.progress.push(line);
        }
        if (job.progress.length > MAX_PROGRESS_LINES)
            job.progress.splice(0, job.progress.length - MAX_PROGRESS_LINES);
        const last = job.progress.at(-1);
        if (last)
            job.info.lastProgress = last;
        void this.persist(job, false);
    }
    setFilesChanged(id, n) {
        const job = this.jobs.get(id);
        if (job)
            job.info.filesChanged = n;
    }
    /** The delegation returned: drop it from the registry and from state.json. */
    async finish(id) {
        const job = this.jobs.get(id);
        if (!job)
            return;
        this.jobs.delete(id);
        await this.store?.update((s) => {
            s.jobs = (s.jobs ?? []).filter((j) => j.id !== id);
        }).catch(() => undefined);
    }
    /** E4: a second cancel answers instead of failing. */
    cancel(id) {
        const job = this.jobs.get(id);
        if (!job)
            return { cancelled: false, id, reason: "no running delegation with that id (finished, lost or never started)" };
        if (job.info.phase === "cancelled")
            return { cancelled: false, id, reason: "already cancelled" };
        job.info.phase = "cancelled";
        job.controller.abort();
        void this.persist(job, true);
        return { cancelled: true, id };
    }
    async status(id) {
        const now = Date.now();
        const out = [];
        for (const j of this.jobs.values()) {
            if (id && j.info.id !== id)
                continue;
            const files = j.worktree ? await changedFiles(j.worktree).catch(() => undefined) : undefined;
            out.push({ ...j.info, progress: [...j.progress], elapsedMs: now - Date.parse(j.info.startedAt), ...(files ? { files, filesChanged: files.length } : {}) });
        }
        return out;
    }
    /** E5: jobs left in state.json by a server that is gone are marked lost; returns them. */
    async reconcile() {
        if (!this.store)
            return [];
        let lost = [];
        await this.store.update((s) => {
            const jobs = s.jobs ?? [];
            lost = jobs.filter((j) => (j.phase === "running" || j.phase === "verifying") && j.pid !== process.pid && !isPidAlive(j.pid)).map((j) => ({ ...j, phase: "lost" }));
            // Keep the last few lost jobs for delegation_status; running ones stay as they are.
            const kept = jobs.filter((j) => !lost.some((l) => l.id === j.id));
            const oldLost = kept.filter((j) => j.phase === "lost");
            s.jobs = [...kept.filter((j) => j.phase !== "lost"), ...[...oldLost, ...lost].slice(-MAX_LOST)];
        }).catch(() => undefined);
        for (const job of lost) {
            if (!job.worktreePath)
                continue;
            await readMeta(job.worktreePath).then(async (meta) => {
                if (meta.id === job.id && (meta.state === "running" || meta.state === "verifying")) {
                    await setMetaState(job.worktreePath, "recoverable");
                }
            }).catch(() => undefined);
        }
        return lost;
    }
    async persist(job, force) {
        if (!this.store)
            return;
        const now = Date.now();
        if (!force && now - job.persistedAt < PERSIST_EVERY_MS)
            return;
        job.persistedAt = now;
        const id = job.info.id;
        await this.store.update((s) => {
            // A write queued before finish() must not bring a finished job back.
            if (!this.jobs.has(id))
                return;
            // The lock does not keep call order: write the job as it is now, so an older write
            // that lands last cannot roll back a newer phase or detail.
            s.jobs = [...(s.jobs ?? []).filter((j) => j.id !== id), { ...job.info }];
        }).catch(() => undefined);
    }
}
//# sourceMappingURL=jobs.js.map