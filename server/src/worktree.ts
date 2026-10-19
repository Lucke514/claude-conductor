import { createHash, randomBytes } from "node:crypto";
import { existsSync, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { appendAudit } from "./audit.js";
import { writeFileAtomic } from "./fsutil.js";
import { git, gitOk, repoRootOf } from "./git.js";
import { patchesDir, worktreesDir } from "./paths.js";
import { isSensitivePath } from "./prompt-builder.js";
import { scanSecrets } from "./secrets-scan.js";

/**
 * Isolated git worktrees for delegated work.
 *
 * - Each delegation runs on a temporary branch `mp/<provider>/<timestamp>`.
 * - A pre-commit / pre-push hook rejects any commit unless MP_CLAUDE_COMMIT=1
 *   (only Claude Code sets it; it is stripped from worker environments).
 * - HEAD is compared before/after; a worker commit is undone with
 *   `git reset --soft` and reported as a violation.
 * - Nothing is ever merged: Claude applies the diff with `git apply --3way`.
 */

export type LifecycleState = "running" | "verifying" | "awaiting_review" | "recoverable" | "discardable";

export interface WorktreeMeta {
  id?: string;
  state?: LifecycleState;
  updatedAt?: string;
  patchSha256?: string;
  verification?: { result: "pass" | "fail" | "cancelled" | "none"; modifiedFiles?: string[] };
  repoRoot: string;
  path: string;
  branch: string;
  baseCommit: string;
  provider: string;
  createdAt: string;
  hooksDir: string;
  symlinks: string[];
  /** `symlink` entries left out because they name credentials or secrets (nested-repos R3). */
  skippedSymlinks?: string[];
  /** The spec-driven task this worktree works on (sdd_task_delegate). */
  sdd?: { slug: string; taskId: string };
}

export type Violation =
  | { type: "worker_commit"; detail: string; headBefore: string; headAfter: string }
  | { type: "specs_modified"; detail: string; files: string[] };

export interface Changes {
  diff: string;
  truncated: boolean;
  diffBytes: number;
  files: string[];
  patchFile?: string;
  violations: Violation[];
}

const META_FILE = "mp-meta.json";

export const BLOCK_HOOK = `#!/bin/sh
# multi-provider: only Claude Code may commit or push from a delegation worktree.
if [ "$MP_CLAUDE_COMMIT" != "1" ]; then
  echo "multi-provider: commits/pushes are reserved for Claude Code (MP_CLAUDE_COMMIT=1). Leave your changes uncommitted." >&2
  exit 1
fi
exit 0
`;

function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${randomBytes(2).toString("hex")}`
  );
}

/**
 * The worktree's blocking hooks live next to it under the plugin's directory, not in its
 * git dir: inside a worktree that is `<source repo>/.git/worktrees/…`, and `core.hooksPath`
 * would hand the source repo's absolute path to the worker (nested-repos R3).
 */
export const hooksDirFor = (wtPath: string): string => path.join(path.dirname(wtPath), ".hooks", path.basename(wtPath));

/** git -c core.hooksPath=<dir> so the user's hooks don't run on our plumbing. */
const quietHooks = (dir: string) => ["-c", `core.hooksPath=${dir}`];

export async function createWorktree(opts: {
  id?: string;
  cwd: string;
  provider: string;
  includeUncommitted: boolean;
  symlink: string[];
  sdd?: { slug: string; taskId: string };
}): Promise<WorktreeMeta> {
  const repoRoot = await repoRootOf(opts.cwd);
  if (!repoRoot) throw new Error(`not a git repository: ${opts.cwd}`);
  const head = await gitOk(["rev-parse", "--verify", "HEAD"], repoRoot).catch(() => {
    throw new Error(`repository ${path.basename(repoRoot)} has no commits yet; make an initial commit before delegating`);
  });
  let base = head;
  if (opts.includeUncommitted) {
    // Commit object with the current tracked working-tree state; does not touch the stash list.
    const stash = (await git(["stash", "create"], repoRoot)).stdout.trim();
    if (stash) base = stash;
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
  const hooksDir = hooksDirFor(wtPath);
  await fs.mkdir(hooksDir, { recursive: true });
  for (const name of ["pre-commit", "pre-push", "pre-merge-commit", "pre-rebase"]) {
    await fs.writeFile(path.join(hooksDir, name), BLOCK_HOOK, { mode: 0o755 });
  }

  const symlinks: string[] = [];
  const skippedSymlinks: string[] = [];
  for (const rel of opts.symlink) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(wtPath, rel);
    if (await linksSecrets(rel, src)) {
      skippedSymlinks.push(rel);
      continue;
    }
    if (!existsSync(src) || existsSync(dst)) continue;
    await fs.mkdir(path.dirname(dst), { recursive: true });
    const stat = await fs.stat(src);
    await fs.symlink(src, dst, stat.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file");
    symlinks.push(rel);
  }

  const now = new Date().toISOString();
  const meta: WorktreeMeta = {
    ...(opts.id ? { id: opts.id } : {}),
    state: "running",
    updatedAt: now,
    repoRoot,
    path: wtPath,
    branch,
    baseCommit: base,
    provider: opts.provider,
    createdAt: now,
    hooksDir,
    symlinks,
    ...(skippedSymlinks.length ? { skippedSymlinks } : {}),
    ...(opts.sdd ? { sdd: opts.sdd } : {}),
  };
  await writeFileAtomic(path.join(gitDir, META_FILE), JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * Whether a `symlink` entry would hand secrets to the worker (nested-repos R3): its name
 * or its real target is sensitive, or it is a directory holding `.env*` files.
 * Dependency directories (`node_modules`) are not searched: their files are packages.
 */
async function linksSecrets(rel: string, src: string): Promise<boolean> {
  if (isSensitivePath(rel)) return true;
  if (!existsSync(src)) return false;
  const real = realOrResolved(src);
  if (isSensitivePath(real)) return true;
  if (path.basename(rel) === "node_modules" || !(await fs.stat(src)).isDirectory()) return false;
  const scan = await scanSecrets(src);
  return scan.found.length > 0 || scan.truncated;
}

/** `GIT_CONFIG_*` entries appended after any already present in env (git >= 2.31). */
export function gitConfigEnv(entries: [string, string][], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const start = Number.isFinite(n) && n > 0 ? n : 0;
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(start + entries.length) };
  entries.forEach(([key, value], j) => {
    out[`GIT_CONFIG_KEY_${start + j}`] = key;
    out[`GIT_CONFIG_VALUE_${start + j}`] = value;
  });
  return out;
}

export async function readMeta(worktreePath: string): Promise<WorktreeMeta> {
  assertManagedPath(worktreePath);
  const gitDir = await gitOk(["rev-parse", "--absolute-git-dir"], worktreePath);
  const raw = await fs.readFile(path.join(gitDir, META_FILE), "utf8");
  return JSON.parse(raw) as WorktreeMeta;
}

/** Persist lifecycle metadata and audit only the delegation id and state transition. */
export async function setMetaState(
  worktreePath: string,
  state: LifecycleState,
  extra: Pick<WorktreeMeta, "id" | "patchSha256" | "verification"> = {},
): Promise<WorktreeMeta> {
  const meta = await readMeta(worktreePath);
  const id = extra.id ?? meta.id;
  if (!id) throw new Error("a delegation id is required to audit a lifecycle transition");
  const updatedAt = new Date().toISOString();
  const next: WorktreeMeta = { ...meta, ...extra, id, state, updatedAt };
  const gitDir = await gitOk(["rev-parse", "--absolute-git-dir"], worktreePath);
  await writeFileAtomic(path.join(gitDir, META_FILE), JSON.stringify(next, null, 2));
  await appendAudit({ type: "lifecycle", id, ts: updatedAt, from: meta.state ?? null, to: state });
  return next;
}

/** Legacy worktrees with changes must be kept for review. */
export function effectiveState(meta: Pick<WorktreeMeta, "state">, hasChanges: boolean): LifecycleState {
  return meta.state ?? (hasChanges ? "awaiting_review" : "discardable");
}

/** Age since the last metadata update, independent of directory timestamps. */
export function worktreeAgeMs(meta: Pick<WorktreeMeta, "updatedAt" | "createdAt">, now = Date.now()): number {
  return now - Date.parse(meta.updatedAt ?? meta.createdAt);
}

/**
 * Canonical form for comparing paths: resolves symlinks (macOS lists /var as /private/var)
 * and Windows 8.3 short names (RUNNER~1 vs runneradmin) the way `git worktree list` prints them.
 */
export function realOrResolved(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Only worktrees created by this plugin may be applied/removed. */
export function assertManagedPath(p: string): void {
  const root = realOrResolved(worktreesDir());
  const rel = path.relative(root, realOrResolved(p));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`refusing to operate on a worktree outside ${root}`);
  }
}

/**
 * Detect and undo worker commits, then stage everything and return the diff
 * against the base commit.
 */
export async function collectChanges(meta: WorktreeMeta, maxDiffBytes: number, id: string): Promise<Changes> {
  const violations: Violation[] = [];
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
  const specs = await restoreSpecs(meta, noHooks);
  if (specs.length > 0) {
    violations.push({
      type: "specs_modified",
      detail: `worker changed ${specs.length} file(s) under specs/; they were restored and left out of the diff: ${specs.slice(0, 10).join(", ")}`,
      files: specs,
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
  let patchFile: string | undefined;
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

/** Put `specs/` back as it was at the base commit; returns the paths the worker had changed. */
async function restoreSpecs(meta: WorktreeMeta, noHooks: string[]): Promise<string[]> {
  const lines = async (args: string[]) => (await git(args, meta.path)).stdout.split(/\r?\n/).filter(Boolean);
  const changed = new Set([
    ...(await lines(["diff", "--name-only", meta.baseCommit, "--", "specs"])),
    ...(await lines(["ls-files", "--others", "--exclude-standard", "--", "specs"])),
  ]);
  if (changed.size === 0) return [];
  await git([...noHooks, "reset", "-q", meta.baseCommit, "--", "specs"], meta.path);
  if ((await lines(["ls-files", "--", "specs"])).length > 0) await gitOk([...noHooks, "checkout", "--", "specs"], meta.path);
  await gitOk([...noHooks, "clean", "-fdq", "--", "specs"], meta.path);
  return [...changed].sort();
}

export async function removeWorktree(meta: Pick<WorktreeMeta, "repoRoot" | "path" | "branch">): Promise<void> {
  assertManagedPath(meta.path);
  const noHooks = quietHooks(path.join(worktreesDir(), ".no-hooks"));
  await git([...noHooks, "worktree", "remove", "--force", meta.path], meta.repoRoot);
  await fs.rm(meta.path, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(hooksDirFor(meta.path), { recursive: true, force: true }).catch(() => undefined);
  await git(["worktree", "prune"], meta.repoRoot);
  if (meta.branch.startsWith("mp/")) await git(["branch", "-D", meta.branch], meta.repoRoot);
}

/**
 * Apply the worktree's current changes to the user's checkout with
 * `git apply --3way` (no commit — Claude commits with the user's identity),
 * then remove the worktree and its mp/* branch.
 */
export async function applyWorktree(worktreePath: string, id: string): Promise<{ applied: boolean; files: string[]; output: string; patchFile?: string }> {
  const meta = await readMeta(worktreePath);
  const changes = await collectChanges(meta, Number.MAX_SAFE_INTEGER, `${id}-apply`);
  if (!changes.diff) {
    await removeWorktree(meta);
    return { applied: false, files: [], output: "no changes to apply" };
  }
  let r = await git(["apply", "--3way", "--whitespace=nowarn", changes.patchFile!], meta.repoRoot);
  let output = `${r.stdout}${r.stderr}`.trim();
  if (r.code !== 0 && /does not match index|already exists in index/i.test(output)) {
    // --3way implies --index; with unstaged local edits fall back to a working-tree-only apply.
    r = await git(["apply", "--whitespace=nowarn", changes.patchFile!], meta.repoRoot);
    output = `${output}\n(retried without --3way) ${r.stdout}${r.stderr}`.trim();
  }
  if (r.code !== 0) {
    // Leave the worktree in place so the conflict can be inspected.
    return { applied: false, files: changes.files, output, ...(changes.patchFile ? { patchFile: changes.patchFile } : {}) };
  }
  await removeWorktree(meta);
  return { applied: true, files: changes.files, output, ...(changes.patchFile ? { patchFile: changes.patchFile } : {}) };
}

/** Files the worker has changed so far, read-only (no staging): for delegation_status while it runs. */
export async function changedFiles(meta: Pick<WorktreeMeta, "path" | "baseCommit" | "symlinks">): Promise<string[]> {
  const lines = async (args: string[]) => (await git(args, meta.path)).stdout.split(/\r?\n/).filter(Boolean);
  const files = new Set([...(await lines(["diff", "--name-only", meta.baseCommit])), ...(await lines(["ls-files", "--others", "--exclude-standard"]))]);
  for (const link of meta.symlinks) files.delete(link);
  return [...files].sort();
}

/** The repo's mp/* worktrees under the plugin's directory, as `git worktree list` has them. */
async function managedWorktrees(repoRoot: string): Promise<{ path: string; branch: string }[]> {
  const list = (await git(["worktree", "list", "--porcelain"], repoRoot)).stdout;
  let current: { path?: string; branch?: string } = {};
  const blocks: { path?: string; branch?: string }[] = [];
  for (const line of list.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) current = { path: line.slice(9) };
    else if (line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "" && current.path) {
      blocks.push(current);
      current = {};
    }
  }
  if (current.path) blocks.push(current);
  return blocks.filter((b): b is { path: string; branch: string } => {
    if (!b.path || !b.branch?.startsWith("mp/")) return false;
    try {
      assertManagedPath(b.path);
      return true;
    } catch {
      return false;
    }
  });
}

/** The distinct repository roots of the given directories (a spec worktree and its repo stay apart). */
async function repoRoots(dirs: string | string[]): Promise<string[]> {
  const roots = new Map<string, string>();
  for (const dir of typeof dirs === "string" ? [dirs] : dirs) {
    const root = await repoRootOf(dir);
    if (root && !roots.has(realOrResolved(root))) roots.set(realOrResolved(root), root);
  }
  return [...roots.values()];
}

/** Metadata of every live mp/* worktree of the repositories (unreadable ones are skipped). */
export async function listWorktrees(dirs: string | string[]): Promise<WorktreeMeta[]> {
  const metas: WorktreeMeta[] = [];
  const seen = new Set<string>();
  for (const repoRoot of await repoRoots(dirs)) {
    for (const b of await managedWorktrees(repoRoot)) {
      // Worktrees of one repo are listed by each of its checkouts: keep one entry.
      if (seen.has(realOrResolved(b.path))) continue;
      seen.add(realOrResolved(b.path));
      const meta = await readMeta(b.path).catch(() => undefined);
      if (meta) metas.push(meta);
    }
  }
  return metas;
}

export interface CleanupEntry {
  path: string;
  branch: string;
  state: LifecycleState | null;
  ageMs: number | null;
}

export interface CleanupResult {
  removed: CleanupEntry[];
  kept: CleanupEntry[];
}

/** Keep active/reviewable work indefinitely; expire only discardable or unreadable metadata. */
export async function cleanupWorktrees(
  dirs: string | string[],
  { maxAgeMs = 24 * 3600_000, force = false }: { maxAgeMs?: number; force?: boolean } = {},
): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], kept: [] };
  const seen = new Set<string>();
  for (const repoRoot of await repoRoots(dirs)) {
    const cleaned = await cleanupRepo(repoRoot, maxAgeMs, force, seen);
    result.removed.push(...cleaned.removed);
    result.kept.push(...cleaned.kept);
  }
  return result;
}

async function cleanupRepo(repoRoot: string, maxAgeMs: number, force: boolean, seen: Set<string>): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], kept: [] };
  for (const b of await managedWorktrees(repoRoot)) {
    const canonical = realOrResolved(b.path);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const meta = await readMeta(b.path).catch(() => undefined);
    let state: LifecycleState | null = null;
    let ageMs: number | null = null;
    if (meta && typeof meta === "object") {
      // A failed legacy diff check must never make potentially useful work disposable.
      const hasChanges = meta.state === undefined
        ? await changedFiles(meta).then((files) => files.length > 0).catch(() => true)
        : false;
      state = effectiveState(meta, hasChanges);
      const age = worktreeAgeMs(meta);
      if (Number.isFinite(age)) ageMs = age;
    } else {
      // Corrupt metadata still has a last-write time; missing metadata falls back to the directory.
      const gitDir = await gitOk(["rev-parse", "--absolute-git-dir"], b.path).catch(() => undefined);
      const st = (gitDir ? await fs.stat(path.join(gitDir, META_FILE)).catch(() => undefined) : undefined)
        ?? await fs.stat(b.path).catch(() => undefined);
      if (st) ageMs = Date.now() - st.mtimeMs;
    }
    const entry = { ...b, state, ageMs };
    if (force || ((state === "discardable" || state === null) && ageMs !== null && ageMs > maxAgeMs)) {
      await removeWorktree({ repoRoot, ...b });
      result.removed.push(entry);
    } else {
      result.kept.push(entry);
    }
  }
  // Orphan mp/* branches without a worktree.
  const branches = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/mp/"], repoRoot)).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  const live = new Set((await git(["worktree", "list", "--porcelain"], repoRoot)).stdout.match(/refs\/heads\/mp\/\S+/g) ?? []);
  for (const br of branches) {
    if (!live.has(`refs/heads/${br}`) && (force || maxAgeMs === 0)) await git(["branch", "-D", br], repoRoot);
  }
  return result;
}
