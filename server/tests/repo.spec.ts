import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RepoError, resolveRepo } from "../src/repo.js";
import { makeRepo, makeWorkspace, tmpDir } from "./helpers.js";

const code = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (err) => (err instanceof RepoError ? err.code : `not a RepoError: ${(err as Error).message}`),
  );

describe("resolveRepo (nested-repos R1)", () => {
  it("accepts a nested repo, with or without ./ and a trailing slash", async () => {
    const { root, nested } = makeWorkspace();
    for (const rel of ["backend-monolith", "./backend-monolith/"]) {
      const r = await resolveRepo(root, rel);
      expect(r.rel).toBe("backend-monolith");
      expect(path.basename(r.root)).toBe(path.basename(nested));
    }
  });

  it("rejects '..', absolute paths and symlinks that leave the project", async () => {
    const { root, nested } = makeWorkspace();
    const outside = makeRepo();
    symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    expect(await code(resolveRepo(root, "../x"))).toBe("REPO_INVALID");
    expect(await code(resolveRepo(root, "backend-monolith/../backend-monolith"))).toBe("REPO_INVALID");
    expect(await code(resolveRepo(root, nested))).toBe("REPO_INVALID");
    expect(await code(resolveRepo(root, "escape"))).toBe("REPO_INVALID");
  });

  it("rejects a missing path, a plain directory and a subdirectory of a repo (E2: suggests its root)", async () => {
    const { root, nested } = makeWorkspace();
    mkdirSync(path.join(nested, "src"));
    expect(await code(resolveRepo(root, "missing"))).toBe("REPO_NOT_FOUND");
    // A directory of the root repo is not its own repository.
    mkdirSync(path.join(root, "docs"));
    await expect(resolveRepo(root, "docs")).rejects.toThrow(/its root is '\.'/);
    await expect(resolveRepo(root, "backend-monolith/src")).rejects.toThrow(/its root is 'backend-monolith'/);
    expect(await code(resolveRepo(root, "backend-monolith/src"))).toBe("REPO_NOT_GIT");
  });

  it("rejects a directory that is not inside any git repository", async () => {
    const dir = tmpDir();
    mkdirSync(path.join(dir, "plain"));
    expect(await code(resolveRepo(dir, "plain"))).toBe("REPO_NOT_GIT");
  });
});
