for (const k of Object.keys(process.env)) {
  if (k.startsWith("GIT_CONFIG_")) delete process.env[k];
}

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { logsDir } from "../src/paths.js";
import { applyWorktree, collectChanges, createWorktree, readMeta, removeWorktree } from "../src/worktree.js";
import { makeRepo } from "./helpers.js";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, MP_CLAUDE_COMMIT: "1" } }).trim();

describe("worktree-apply (R5, R6, E4, E5, R8)", () => {
  it("applies cleanly with expectedPatchSha256 and removes worktree", async () => {
    const repo = makeRepo();
    const meta = await createWorktree({ cwd: repo, provider: "codex", includeUncommitted: false, symlink: [], id: "t-clean" });
    writeFileSync(path.join(meta.path, "worker-file.txt"), "worker content\n");
    const changes = await collectChanges(meta, Number.MAX_SAFE_INTEGER, "t-clean-changes");
    const hash = createHash("sha256").update(changes.diff).digest("hex");

    const applied = await applyWorktree(meta.path, "t-clean", { expectedPatchSha256: hash });
    expect(applied.applied).toBe(true);
    expect(applied.files).toEqual(["worker-file.txt"]);
    expect(readFileSync(path.join(repo, "worker-file.txt"), "utf8")).toBe("worker content\n");
    expect(applied.notes).toBeUndefined();
    expect(existsSync(meta.path)).toBe(false);
  });

  it("applies without expectedPatchSha256 and adds note", async () => {
    const repo = makeRepo();
    const meta = await createWorktree({ cwd: repo, provider: "codex", includeUncommitted: false, symlink: [], id: "t-no-hash" });
    writeFileSync(path.join(meta.path, "worker-file.txt"), "content\n");

    const applied = await applyWorktree(meta.path, "t-no-hash");
    expect(applied.applied).toBe(true);
    expect(applied.notes?.[0]).toMatch(/^applied without expectedPatchSha256/);
    expect(readFileSync(path.join(repo, "worker-file.txt"), "utf8")).toBe("content\n");
  });

  it("R5/R8: expectedPatchSha256 mismatch returns PATCH_CHANGED, leaves checkout untouched and writes audit entry", async () => {
    const repo = makeRepo();
    const meta = await createWorktree({ cwd: repo, provider: "codex", includeUncommitted: false, symlink: [], id: "t-patch-changed" });
    writeFileSync(path.join(meta.path, "worker-file.txt"), "content v1\n");
    const changes1 = await collectChanges(meta, Number.MAX_SAFE_INTEGER, "v1");
    const oldHash = createHash("sha256").update(changes1.diff).digest("hex");

    // Modify worktree after review
    writeFileSync(path.join(meta.path, "worker-file.txt"), "content v2 modified\n");

    const statusBefore = git(repo, "status", "--porcelain");
    const applied = await applyWorktree(meta.path, "t-patch-changed", { expectedPatchSha256: oldHash });

    expect(applied.applied).toBe(false);
    expect(applied.code).toBe("PATCH_CHANGED");
    expect(applied.patchSha256).not.toBe(oldHash);
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
    expect(existsSync(path.join(repo, "worker-file.txt"))).toBe(false);

    // Audit log contains PATCH_CHANGED without prompt or diff content
    const log = readdirSync(logsDir()).flatMap((f) => readFileSync(path.join(logsDir(), f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
    const audit = log.find((e) => e.type === "PATCH_CHANGED" && e.id === "t-patch-changed");
    expect(audit).toMatchObject({ type: "PATCH_CHANGED", id: "t-patch-changed", ts: expect.any(String) });
    expect(JSON.stringify(audit)).not.toContain("content v1");
    expect(JSON.stringify(audit)).not.toContain("content v2");

    // Apply with the actual hash succeeds
    const applied2 = await applyWorktree(meta.path, "t-patch-changed", { expectedPatchSha256: applied.patchSha256 });
    expect(applied2.applied).toBe(true);
    expect(readFileSync(path.join(repo, "worker-file.txt"), "utf8")).toBe("content v2 modified\n");
  });

  it("E5: expectedPatchSha256 with discarded worktree returns NOT_FOUND, not PATCH_CHANGED", async () => {
    const repo = makeRepo();
    const meta = await createWorktree({ cwd: repo, provider: "codex", includeUncommitted: false, symlink: [], id: "t-discarded" });
    const wtPath = meta.path;
    await removeWorktree(meta);

    const applied = await applyWorktree(wtPath, "t-discarded", { expectedPatchSha256: "some-hash" });
    expect(applied.applied).toBe(false);
    expect(applied.code).toBe("NOT_FOUND");
  });

  it("R6: conflict without allowConflicts leaves checkout intact and returns conflicts list with patchFile", async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "file.txt"), "line1\nline2\nline3\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-qm", "add file.txt");

    const meta = await createWorktree({ cwd: repo, provider: "codex", includeUncommitted: false, symlink: [], id: "t-conflict" });
    writeFileSync(path.join(meta.path, "file.txt"), "line1\nworker edit\nline3\n");
    const changes = await collectChanges(meta, Number.MAX_SAFE_INTEGER, "t-conflict");
    const hash = createHash("sha256").update(changes.diff).digest("hex");

    // Prepare conflict in checkout
    writeFileSync(path.join(repo, "file.txt"), "line1\nuser edit\nline3\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-qm", "user edit line2");

    const statusBefore = git(repo, "status", "--porcelain");
    const applied = await applyWorktree(meta.path, "t-conflict", { expectedPatchSha256: hash });

    expect(applied.applied).toBe(false);
    expect(applied.conflicts).toEqual(["file.txt"]);
    expect(applied.patchFile && existsSync(applied.patchFile)).toBe(true);
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
    expect(readFileSync(path.join(repo, "file.txt"), "utf8")).not.toContain("<<<<<<<");
    expect(readFileSync(path.join(repo, "file.txt"), "utf8")).toBe("line1\nuser edit\nline3\n");

    await removeWorktree(meta);
  });

  it("R6: conflict with allowConflicts applies 3-way markers and lists conflicted files", async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "file.txt"), "line1\nline2\nline3\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-qm", "add file.txt");

    const meta = await createWorktree({ cwd: repo, provider: "codex", includeUncommitted: false, symlink: [], id: "t-allow-conflicts" });
    writeFileSync(path.join(meta.path, "file.txt"), "line1\nworker edit\nline3\n");
    const changes = await collectChanges(meta, Number.MAX_SAFE_INTEGER, "t-allow");
    const hash = createHash("sha256").update(changes.diff).digest("hex");

    // Conflict in user checkout
    writeFileSync(path.join(repo, "file.txt"), "line1\nuser edit\nline3\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-qm", "user edit line2");

    const applied = await applyWorktree(meta.path, "t-allow-conflicts", { expectedPatchSha256: hash, allowConflicts: true });

    expect(applied.conflicts).toEqual(["file.txt"]);
    const fileContent = readFileSync(path.join(repo, "file.txt"), "utf8");
    expect(fileContent).toContain("<<<<<<<");
    expect(fileContent).toContain("worker edit");
    expect(fileContent).toContain("user edit");

    await removeWorktree(meta);
  });

  it("3-way clean apply resolves cleanly when edits do not overlap", async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "file.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-qm", "initial 10 lines");

    const meta = await createWorktree({ cwd: repo, provider: "codex", includeUncommitted: false, symlink: [], id: "t-3way-clean" });
    writeFileSync(path.join(meta.path, "file.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nworker10\n");
    const changes = await collectChanges(meta, Number.MAX_SAFE_INTEGER, "t-3way");
    const hash = createHash("sha256").update(changes.diff).digest("hex");

    // User edits line 2
    writeFileSync(path.join(repo, "file.txt"), "l1\nuser2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-qm", "user edit line2");

    const applied = await applyWorktree(meta.path, "t-3way-clean", { expectedPatchSha256: hash });
    expect(applied.applied).toBe(true);
    const content = readFileSync(path.join(repo, "file.txt"), "utf8");
    expect(content).toContain("user2");
    expect(content).toContain("worker10");
    expect(content).not.toContain("<<<<<<<");
    expect(existsSync(meta.path)).toBe(false);
  });

  it("E4: corrupt patch returns git error without touching checkout", async () => {
    const repo = makeRepo();
    const meta = await createWorktree({ cwd: repo, provider: "codex", includeUncommitted: false, symlink: [], id: "t-corrupt" });
    writeFileSync(path.join(meta.path, "file.txt"), "content\n");

    const statusBefore = git(repo, "status", "--porcelain");

    const fsPromises = await import("node:fs").then((m) => m.promises);
    const origWriteFile = fsPromises.writeFile;
    const spy = vi.spyOn(fsPromises, "writeFile").mockImplementation(async (file, data, options) => {
      if (typeof file === "string" && file.endsWith("-apply.patch")) {
        return origWriteFile(file, "malformed patch content\nnot a real diff\n", options);
      }
      return origWriteFile(file, data, options);
    });

    try {
      const applied = await applyWorktree(meta.path, "t-corrupt");
      expect(applied.applied).toBe(false);
      expect(applied.conflicts).toBeUndefined();
      expect(applied.output).toMatch(/error:|fatal:/i);
      expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
    } finally {
      spy.mockRestore();
      await removeWorktree(meta);
    }
  });
});
