import { createHash, randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { git, gitOk, repoRootOf } from "./git.js";
import { patchesDir, worktreesDir } from "./paths.js";
const META_FILE = "mp-meta.json";
export const BLOCK_HOOK = `#!/bin/sh
# multi-provider: only Claude Code may commit or push from a delegation worktree.
if [ "$MP_CLAUDE_COMMIT" != "1" ]; then
  echo "multi-provider: commits/pushes are reserved for Claude Code (MP_CLAUDE_COMMIT=1). Leave your changes uncommitted." >&2
  exit 1
fi
exit 0
`;
function stamp(d = new Date()) {
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return (`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
        `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${randomBytes(2).toString("hex")}`);
}
/** git -c core.hooksPath=<dir> so the user's hooks don't run on our plumbing. */
const quietHooks = (dir) => ["-c", `core.hooksPath=${dir}`];
export async function createWorktree(opts) {
    const repoRoot = await repoRootOf(opts.cwd);
    if (!repoRoot)
        throw new Error(`not a git repository: ${opts.cwd}`);
    const head = await gitOk(["rev-parse", "--verify", "HEAD"], repoRoot).catch(() => {
        throw new Error("repository has no commits yet; make an initial commit before delegating");
    });
    let base = head;
    if (opts.includeUncommitted) {
        // Commit object with the current tracked working-tree state; does not touch the stash list.
        const stash = (await git(["stash", "create"], repoRoot)).stdout.trim();
        if (stash)
            base = stash;
    }
    const ts = stamp();
    const safeProvider = opts.provider.replace(/[^\w-]/g, "_");
    const branch = `mp/${safeProvider}/${ts}`;
    const repoKey = `${path.basename(repoRoot)}-${createHash("sha1").update(repoRoot).digest("hex").slice(0, 8)}`;
    const wtPath = path.join(worktreesDir(), repoKey, `${safeProvider}-${ts}`);
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    const emptyHooks = path.join(worktreesDir(), ".no-hooks");
    await fs.mkdir(emptyHooks, { recursive: true });
    await gitOk([...quietHooks(emptyHooks), "worktree", "add", "-b", branch, wtPath, base], repoRoot);
    const gitDir = await gitOk(["rev-parse", "--absolute-git-dir"], wtPath);
    const hooksDir = path.join(gitDir, "mp-hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    for (const name of ["pre-commit", "pre-push", "pre-merge-commit", "pre-rebase"]) {
        await fs.writeFile(path.join(hooksDir, name), BLOCK_HOOK, { mode: 0o755 });
    }
    const symlinks = [];
    for (const rel of opts.symlink) {
        const src = path.join(repoRoot, rel);
        const dst = path.join(wtPath, rel);
        if (!existsSync(src) || existsSync(dst))
            continue;
        await fs.mkdir(path.dirname(dst), { recursive: true });
        const stat = await fs.stat(src);
        await fs.symlink(src, dst, stat.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file");
        symlinks.push(rel);
    }
    const meta = {
        repoRoot,
        path: wtPath,
        branch,
        baseCommit: base,
        provider: opts.provider,
        createdAt: new Date().toISOString(),
        hooksDir,
        symlinks,
    };
    await fs.writeFile(path.join(gitDir, META_FILE), JSON.stringify(meta, null, 2));
    return meta;
}
/** Env forcing our hooks for every git process the worker starts (git >= 2.31). */
export function workerGitEnv(meta, env = process.env) {
    // Append to any GIT_CONFIG_* entries already present instead of clobbering them.
    const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
    const i = Number.isFinite(n) && n > 0 ? n : 0;
    return {
        GIT_CONFIG_COUNT: String(i + 1),
        [`GIT_CONFIG_KEY_${i}`]: "core.hooksPath",
        [`GIT_CONFIG_VALUE_${i}`]: meta.hooksDir,
    };
}
export async function readMeta(worktreePath) {
    assertManagedPath(worktreePath);
    const gitDir = await gitOk(["rev-parse", "--absolute-git-dir"], worktreePath);
    const raw = await fs.readFile(path.join(gitDir, META_FILE), "utf8");
    return JSON.parse(raw);
}
/** Only worktrees created by this plugin may be applied/removed. */
export function assertManagedPath(p) {
    const root = path.resolve(worktreesDir());
    const rel = path.relative(root, path.resolve(p));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`refusing to operate on a worktree outside ${root}`);
    }
}
/**
 * Detect and undo worker commits, then stage everything and return the diff
 * against the base commit.
 */
export async function collectChanges(meta, maxDiffBytes, id) {
    const violations = [];
    const noHooks = quietHooks(path.join(worktreesDir(), ".no-hooks"));
    const headAfter = await gitOk(["rev-parse", "HEAD"], meta.path);
    if (headAfter !== meta.baseCommit) {
        // Keep the worker's changes, drop its commits.
        await gitOk([...noHooks, "reset", "--soft", meta.baseCommit], meta.path);
        violations.push({
            type: "worker_commit",
            detail: "worker created commit(s); HEAD was reset --soft to the original base and changes kept as a diff",
            headBefore: meta.baseCommit,
            headAfter,
        });
    }
    await gitOk([...noHooks, "add", "-A"], meta.path);
    if (meta.symlinks.length > 0) {
        await git([...noHooks, "reset", "-q", "--", ...meta.symlinks], meta.path);
    }
    const diff = (await git(["diff", "--cached", "--binary", meta.baseCommit], meta.path)).stdout;
    const files = (await git(["diff", "--cached", "--name-only", meta.baseCommit], meta.path)).stdout
        .split(/\r?\n/)
        .filter(Boolean);
    const diffBytes = Buffer.byteLength(diff);
    let patchFile;
    if (diff) {
        await fs.mkdir(patchesDir(), { recursive: true });
        patchFile = path.join(patchesDir(), `${id}.patch`);
        await fs.writeFile(patchFile, diff, { mode: 0o600 });
    }
    const truncated = diffBytes > maxDiffBytes;
    return {
        diff: truncated ? `${diff.slice(0, maxDiffBytes)}\n… [diff truncated: ${diffBytes} bytes total, full patch at ${patchFile}]\n` : diff,
        truncated,
        diffBytes,
        files,
        ...(patchFile ? { patchFile } : {}),
        violations,
    };
}
export async function removeWorktree(meta) {
    assertManagedPath(meta.path);
    const noHooks = quietHooks(path.join(worktreesDir(), ".no-hooks"));
    await git([...noHooks, "worktree", "remove", "--force", meta.path], meta.repoRoot);
    await fs.rm(meta.path, { recursive: true, force: true }).catch(() => undefined);
    await git(["worktree", "prune"], meta.repoRoot);
    if (meta.branch.startsWith("mp/"))
        await git(["branch", "-D", meta.branch], meta.repoRoot);
}
/**
 * Apply the worktree's current changes to the user's checkout with
 * `git apply --3way` (no commit — Claude commits with the user's identity),
 * then remove the worktree and its mp/* branch.
 */
export async function applyWorktree(worktreePath, id) {
    const meta = await readMeta(worktreePath);
    const changes = await collectChanges(meta, Number.MAX_SAFE_INTEGER, `${id}-apply`);
    if (!changes.diff) {
        await removeWorktree(meta);
        return { applied: false, files: [], output: "no changes to apply" };
    }
    let r = await git(["apply", "--3way", "--whitespace=nowarn", changes.patchFile], meta.repoRoot);
    let output = `${r.stdout}${r.stderr}`.trim();
    if (r.code !== 0 && /does not match index|already exists in index/i.test(output)) {
        // --3way implies --index; with unstaged local edits fall back to a working-tree-only apply.
        r = await git(["apply", "--whitespace=nowarn", changes.patchFile], meta.repoRoot);
        output = `${output}\n(retried without --3way) ${r.stdout}${r.stderr}`.trim();
    }
    if (r.code !== 0) {
        // Leave the worktree in place so the conflict can be inspected.
        return { applied: false, files: changes.files, output, ...(changes.patchFile ? { patchFile: changes.patchFile } : {}) };
    }
    await removeWorktree(meta);
    return { applied: true, files: changes.files, output, ...(changes.patchFile ? { patchFile: changes.patchFile } : {}) };
}
/** Remove every mp/* worktree of a repository (optionally only older than maxAgeMs). */
export async function cleanupWorktrees(cwd, maxAgeMs = 0) {
    const repoRoot = await repoRootOf(cwd);
    if (!repoRoot)
        return [];
    const list = (await git(["worktree", "list", "--porcelain"], repoRoot)).stdout;
    const removed = [];
    let current = {};
    const blocks = [];
    for (const line of list.split(/\r?\n/)) {
        if (line.startsWith("worktree "))
            current = { path: line.slice(9) };
        else if (line.startsWith("branch "))
            current.branch = line.slice(7).replace(/^refs\/heads\//, "");
        else if (line === "" && current.path) {
            blocks.push(current);
            current = {};
        }
    }
    if (current.path)
        blocks.push(current);
    for (const b of blocks) {
        if (!b.path || !b.branch?.startsWith("mp/"))
            continue;
        try {
            assertManagedPath(b.path);
        }
        catch {
            continue;
        }
        if (maxAgeMs > 0) {
            const st = await fs.stat(b.path).catch(() => undefined);
            if (st && Date.now() - st.mtimeMs < maxAgeMs)
                continue;
        }
        await removeWorktree({ repoRoot, path: b.path, branch: b.branch });
        removed.push(b.path);
    }
    // Orphan mp/* branches without a worktree.
    const branches = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/mp/"], repoRoot)).stdout
        .split(/\r?\n/)
        .filter(Boolean);
    const live = new Set((await git(["worktree", "list", "--porcelain"], repoRoot)).stdout.match(/refs\/heads\/mp\/\S+/g) ?? []);
    for (const br of branches) {
        if (!live.has(`refs/heads/${br}`) && maxAgeMs === 0)
            await git(["branch", "-D", br], repoRoot);
    }
    return removed;
}
//# sourceMappingURL=worktree.js.map