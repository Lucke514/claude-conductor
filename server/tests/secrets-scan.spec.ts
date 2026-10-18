import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanSecrets } from "../src/secrets-scan.js";
import { makeWorkspace, tmpDir } from "./helpers.js";

const touch = (root: string, rel: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), "X=1\n");
};

describe("scanSecrets (nested-repos R6)", () => {
  it("finds .env* in nested repos and skips node_modules and .git", async () => {
    const { root } = makeWorkspace();
    touch(root, "web-app/config/.env.production");
    touch(root, "node_modules/pkg/.env");
    touch(root, "backend-monolith/node_modules/x/.env");
    touch(root, ".git/.env");
    touch(root, "docs/env.md");
    const r = await scanSecrets(root);
    expect(r).toEqual({ found: ["backend-monolith/.env", "web-app/config/.env.production"], truncated: false });
  });

  it("G1: follows symlinked directories (the worker can open them), once each, without looping", async () => {
    const outside = tmpDir();
    touch(outside, ".env");
    const root = tmpDir();
    const kind = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(outside, path.join(root, "config"), kind);
    symlinkSync(root, path.join(root, "loop"), kind);
    expect(await scanSecrets(root)).toEqual({ found: ["config/.env"], truncated: false });
  });

  it("G1: every .env* name counts (.envrc, .env-local, .env_prod)", async () => {
    const root = tmpDir();
    for (const n of [".envrc", ".env-local", ".env_prod"]) touch(root, n);
    expect((await scanSecrets(root)).found.sort()).toEqual([".env-local", ".env_prod", ".envrc"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("G1: a directory it cannot read makes the scan truncated", async () => {
    const root = tmpDir();
    touch(root, "locked/x.txt");
    chmodSync(path.join(root, "locked"), 0o000);
    try {
      expect((await scanSecrets(root)).truncated).toBe(true);
    } finally {
      chmodSync(path.join(root, "locked"), 0o755);
    }
  });

  it("reports at most maxFound paths and truncates on the depth and entry limits", async () => {
    const root = tmpDir();
    for (let i = 0; i < 7; i++) touch(root, `r${i}/.env`);
    const many = await scanSecrets(root);
    expect(many.found).toHaveLength(5);
    touch(root, "a/b/c/d/e/f/g/h/x.txt");
    expect((await scanSecrets(path.join(root, "a"), { maxDepth: 3 })).truncated).toBe(true);
    expect((await scanSecrets(root, { maxEntries: 3 })).truncated).toBe(true);
    expect(await scanSecrets(path.join(root, "a"))).toEqual({ found: [], truncated: true });
  });
});
