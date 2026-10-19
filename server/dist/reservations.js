import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { withLock } from "./fsutil.js";
import { isPidAlive } from "./jobs.js";
import { locksDir } from "./paths.js";
export function makeReservationId() {
    return `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}
export function lockFilePath(key, dir = locksDir()) {
    const hash = createHash("sha1").update(key).digest("hex");
    return path.join(dir, `${hash}.json`);
}
/**
 * Acquires an exclusive reservation for `key`.
 * Uses atomic file creation (`wx` flag = O_EXCL).
 * If the file already exists:
 * - if its PID is dead, or its age > maxAgeMs, it is treated as an orphan lock: it is
 *   removed and acquisition is retried with `wx`, so two callers that both see the same
 *   orphan cannot both win; the winner returns { ok: true, note } (E6).
 * - otherwise returns { ok: false, heldBy: record.id }.
 */
export async function reserve(key, opts) {
    const dir = opts.dir ?? locksDir();
    await fs.mkdir(dir, { recursive: true });
    const file = lockFilePath(key, dir);
    const now = opts.now ?? Date.now();
    const startedAt = new Date(now).toISOString();
    const maxAge = opts.maxAgeMs ?? Infinity;
    const content = { key, id: opts.id, pid: process.pid, startedAt };
    const serialized = JSON.stringify(content, null, 2);
    let note;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const handle = await fs.open(file, "wx");
            try {
                await handle.writeFile(serialized, "utf8");
            }
            finally {
                await handle.close();
            }
            return note ? { ok: true, note } : { ok: true };
        }
        catch (err) {
            if (err.code !== "EEXIST")
                throw err;
        }
        // Lock file already exists. Inspect it.
        let record;
        let orphanText;
        try {
            const text = await fs.readFile(file, "utf8");
            orphanText = text;
            record = JSON.parse(text);
        }
        catch (err) {
            if (err.code === "ENOENT") {
                // File was removed concurrently; retry acquisition
                continue;
            }
            // Corrupt or unreadable JSON: treat as orphan
        }
        let isOrphan = false;
        let reason = "";
        const pid = record?.pid;
        if (typeof pid !== "number" || pid <= 0 || !isPidAlive(pid)) {
            isOrphan = true;
            reason = `pid ${pid ?? "unknown"} is dead`;
        }
        else {
            const startedAtMs = record?.startedAt ? Date.parse(record.startedAt) : NaN;
            const age = Number.isFinite(startedAtMs) ? now - startedAtMs : Infinity;
            if (age > maxAge) {
                isOrphan = true;
                reason = `age ${Math.round(age)}ms exceeded max age ${maxAge}ms`;
            }
        }
        if (isOrphan) {
            // Remove the orphan under a short cross-process lock, and only if the file still holds that
            // same orphan; then every caller races for it again through `wx`, so only one can win.
            await withLock(file, async () => {
                const current = await fs.readFile(file, "utf8").catch(() => undefined);
                if (current === undefined || current === orphanText)
                    await fs.rm(file, { force: true });
            });
            note = `Replaced orphan reservation for ${key} (held by ${record?.id ?? "unknown"}: ${reason})`;
            continue;
        }
        return { ok: false, heldBy: record?.id ?? "unknown" };
    }
    return { ok: false, heldBy: "unknown" };
}
/**
 * Releases the exclusive reservation for `key`.
 * Deletes the lock file only if the stored reservation `id` matches `id`.
 */
export async function release(key, id, dir = locksDir()) {
    const file = lockFilePath(key, dir);
    try {
        const text = await fs.readFile(file, "utf8");
        const record = JSON.parse(text);
        if (record.id === id) {
            await fs.rm(file, { force: true });
            return true;
        }
        return false;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=reservations.js.map