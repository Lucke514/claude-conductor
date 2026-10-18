import { existsSync } from "node:fs";
import path from "node:path";
import { repoRootOf } from "./git.js";
import { realOrResolved } from "./worktree.js";

/**
 * The code repository a delegation works on (nested-repos R1): a path under the
 * project directory that is the root of its own git repository, e.g. a repo
 * nested and ignored inside a configuration workspace. Validated before any
 * worktree or worker exists.
 */

export type RepoErrorCode = "REPO_INVALID" | "REPO_NOT_GIT" | "REPO_NOT_FOUND";

export class RepoError extends Error {
  constructor(
    readonly code: RepoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RepoError";
  }
}

export interface ResolvedRepo {
  /** As given, normalized to forward slashes (relative to projectDir). */
  rel: string;
  /** Absolute repository root. */
  root: string;
}

const inside = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export async function resolveRepo(projectDir: string, repo: string): Promise<ResolvedRepo> {
  const rel = repo.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!rel || path.isAbsolute(repo) || path.win32.isAbsolute(repo) || rel.split("/").includes("..")) {
    throw new RepoError("REPO_INVALID", `repo '${repo}' must be a path relative to the project directory, without '..'`);
  }
  const abs = path.join(projectDir, ...rel.split("/"));
  if (!existsSync(abs)) throw new RepoError("REPO_NOT_FOUND", `repo '${rel}' does not exist under the project directory`);
  const project = realOrResolved(projectDir);
  const real = realOrResolved(abs);
  if (!inside(project, real)) {
    throw new RepoError("REPO_INVALID", `repo '${rel}' resolves outside the project directory (symlink to ${real})`);
  }
  const top = await repoRootOf(abs);
  if (!top) throw new RepoError("REPO_NOT_GIT", `repo '${rel}' is not a git repository`);
  const realTop = realOrResolved(top);
  if (realTop !== real) {
    const hint = inside(project, realTop) ? path.relative(project, realTop).split(path.sep).join("/") || "." : realTop;
    throw new RepoError("REPO_NOT_GIT", `repo '${rel}' is not the root of a git repository; its root is '${hint}'`);
  }
  return { rel, root: top };
}
