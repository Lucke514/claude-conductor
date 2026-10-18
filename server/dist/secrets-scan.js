import { promises as fs } from "node:fs";
import path from "node:path";
const SKIP = new Set(["node_modules", ".git"]);
const ENV_FILE = /^\.env(\..*)?$/i;
export async function scanSecrets(dir, opts = {}) {
    const maxDepth = opts.maxDepth ?? 6;
    const maxEntries = opts.maxEntries ?? 20_000;
    const maxFound = opts.maxFound ?? 5;
    const found = [];
    let entries = 0;
    let truncated = false;
    const queue = [{ abs: dir, rel: "", depth: 0 }];
    while (queue.length > 0) {
        const { abs, rel, depth } = queue.shift();
        const list = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
        for (const e of list) {
            if (++entries > maxEntries)
                return { found, truncated: true };
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            if (ENV_FILE.test(e.name) && !e.isDirectory()) {
                found.push(childRel);
                // One more than reported is enough to know there are more.
                if (found.length > maxFound)
                    return { found: found.slice(0, maxFound), truncated };
            }
            else if (e.isDirectory() && !SKIP.has(e.name)) {
                if (depth + 1 > maxDepth)
                    truncated = true;
                else
                    queue.push({ abs: path.join(abs, e.name), rel: childRel, depth: depth + 1 });
            }
        }
    }
    return { found, truncated };
}
//# sourceMappingURL=secrets-scan.js.map