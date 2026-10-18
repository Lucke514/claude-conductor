import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Looks for `.env*` files a worker running directly in a directory could open
 * (nested-repos R6), nested repos included. Symlinked directories are followed
 * (the worker can open them too), each real directory once. Bounded: a scan that
 * hits a limit or cannot read a directory reports `truncated`, which callers treat
 * as unsafe.
 */

export interface SecretsScan {
  /** Relative paths (forward slashes), at most `maxFound`. */
  found: string[];
  truncated: boolean;
}

const SKIP = new Set(["node_modules", ".git"]);
/** `.env`, `.env.local`, `.envrc`, `.env-prod`…: every `.env*` name. */
const ENV_FILE = /^\.env/i;

export async function scanSecrets(dir: string, opts: { maxDepth?: number; maxEntries?: number; maxFound?: number } = {}): Promise<SecretsScan> {
  const maxDepth = opts.maxDepth ?? 6;
  const maxEntries = opts.maxEntries ?? 20_000;
  const maxFound = opts.maxFound ?? 5;
  const found: string[] = [];
  let entries = 0;
  let truncated = false;
  const seen = new Set<string>();
  const real = (p: string): string | undefined => {
    try {
      return realpathSync.native(p);
    } catch {
      return undefined;
    }
  };
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: dir, rel: "", depth: 0 }];
  while (queue.length > 0) {
    const { abs, rel, depth } = queue.shift()!;
    const key = real(abs) ?? abs;
    if (seen.has(key)) continue;
    seen.add(key);
    let list;
    try {
      list = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      // Unreadable for us is not proof it is unreadable for the worker.
      truncated = true;
      continue;
    }
    for (const e of list) {
      if (++entries > maxEntries) return { found, truncated: true };
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      const isDir = e.isDirectory() || (e.isSymbolicLink() && (await fs.stat(childAbs).then((st) => st.isDirectory(), () => false)));
      if (ENV_FILE.test(e.name) && !isDir) {
        found.push(childRel);
        // One more than reported is enough to know there are more.
        if (found.length > maxFound) return { found: found.slice(0, maxFound), truncated };
      } else if (isDir && !SKIP.has(e.name)) {
        if (depth + 1 > maxDepth) truncated = true;
        else queue.push({ abs: childAbs, rel: childRel, depth: depth + 1 });
      }
    }
  }
  return { found, truncated };
}
