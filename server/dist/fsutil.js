import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Write to a temp file in the same directory, then rename over the target. */
export async function writeFileAtomic(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
    // Windows may refuse the rename while a reader holds the file open; retry briefly.
    for (let i = 0;; i++) {
        try {
            await fs.rename(tmp, file);
            return;
        }
        catch (err) {
            const code = err.code;
            if (i < 10 && (code === "EPERM" || code === "EACCES" || code === "EBUSY")) {
                await sleep(20 * (i + 1));
                continue;
            }
            await fs.rm(tmp, { force: true });
            throw err;
        }
    }
}
/**
 * Cross-process lock based on mkdir (atomic on all platforms). Stale locks
 * (older than staleMs) are broken.
 */
export async function withLock(target, fn, staleMs = 5000) {
    const lock = `${target}.lock`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    for (let i = 0;; i++) {
        try {
            await fs.mkdir(lock);
            break;
        }
        catch (err) {
            if (err.code !== "EEXIST")
                throw err;
            try {
                const st = await fs.stat(lock);
                if (Date.now() - st.mtimeMs > staleMs) {
                    await fs.rm(lock, { recursive: true, force: true });
                    continue;
                }
            }
            catch {
                continue;
            }
            if (i > 200)
                throw new Error(`could not acquire lock ${lock}`);
            await sleep(15);
        }
    }
    try {
        return await fn();
    }
    finally {
        await fs.rm(lock, { recursive: true, force: true }).catch(() => undefined);
    }
}
export async function readJson(file) {
    try {
        return JSON.parse(await fs.readFile(file, "utf8"));
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=fsutil.js.map