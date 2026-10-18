import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("does not follow symlinks", async () => {
    const outside = tmpDir();
    touch(outside, ".env");
    const root = tmpDir();
    symlinkSync(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(await scanSecrets(root)).toEqual({ found: [], truncated: false });
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
