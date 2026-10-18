import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { delegate } from "../src/delegate.js";
import { StateStore } from "../src/state.js";
import { CREDENTIAL_ENV, GH_SHIM_MESSAGE, pathKey, shimDir, workerEnv } from "../src/worker-env.js";
import { removeWorktree, readMeta } from "../src/worktree.js";
import { makeRepo, testConfig, tmpDir } from "./helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const FAKE = ["FAKE_MODE", "FAKE_PROBE_FILE", "FAKE_PUSH", "FAKE_WRITE_FILE", "FAKE_MESSAGE"];
const SECRET = "secret-value-do-not-leak";

afterEach(() => {
  for (const k of [...FAKE, ...CREDENTIAL_ENV]) delete process.env[k];
});

export function ctx(projectDir: string, overrides: Record<string, unknown> = {}) {
  return {
    projectDir,
    config: testConfig({ chain: ["codex", "claude"], ...overrides }),
    store: new StateStore(path.join(tmpDir(), "state.json")),
    instanceId: "test",
    sleep: async () => undefined,
  };
}

interface Probe {
  env: Record<string, string>;
  credentialHelper: { code: number; out: string };
  gh: { code: number; out: string };
  push: { code: number; out: string } | null;
}

async function probe(repo: string, mode: "read" | "write" = "write", overrides: Record<string, unknown> = {}) {
  process.env.FAKE_MODE = "probe";
  process.env.FAKE_PROBE_FILE = path.join(tmpDir(), "probe.json");
  const r = await delegate({ provider: "codex", task: "probe", mode }, ctx(repo, overrides));
  const p = JSON.parse(readFileSync(process.env.FAKE_PROBE_FILE, "utf8")) as Probe;
  return { r, p };
}

describe("sealed worker environment (R4, R5)", () => {
  it("strips git/GitHub credentials, limits git to local transports and refuses pushes over https", async () => {
    const repo = makeRepo();
    git(repo, "remote", "add", "origin", "https://127.0.0.1:9/x.git");
    for (const k of CREDENTIAL_ENV) process.env[k] = SECRET;
    process.env.FAKE_PUSH = "origin";
    const { r, p } = await probe(repo);
    for (const k of CREDENTIAL_ENV) expect(p.env[k]).toBeUndefined();
    expect(p.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(p.env.GIT_ALLOW_PROTOCOL).toBe("file");
    expect(existsSync(p.env.GH_CONFIG_DIR!)).toBe(true);
    expect(p.credentialHelper.out).toBe("");
    expect(p.push!.code).not.toBe(0);
    expect(p.push!.out).toMatch(/transport 'https' not allowed/);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("puts a gh that always refuses first on PATH, in read mode without a worktree too", async () => {
    const repo = makeRepo();
    const { p } = await probe(repo, "read", { isolation: { readMode: "cwd" } });
    expect(p.gh.code).toBe(1);
    expect(p.gh.out).toContain(GH_SHIM_MESSAGE);
    expect(p.env[pathKey(p.env)]!.split(path.delimiter)[0]).toBe(shimDir());
    expect(existsSync(path.join(shimDir(), "gh.cmd"))).toBe(true);
    expect(p.env.GIT_ALLOW_PROTOCOL).toBe("file");
  });

  it("E5/E8: appends GIT_CONFIG_* entries and reuses the PATH key's own case", () => {
    const env = workerEnv({ hooksDir: "/h" }, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x", Path: "C:\\bin" });
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: "/h",
      Path: `${shimDir()}${path.delimiter}C:\\bin`,
    });
    expect(env).not.toHaveProperty("GIT_CONFIG_KEY_0");
    expect(env).not.toHaveProperty("PATH");
  });

  it("the worktree is still cleaned up after a probe", async () => {
    const repo = makeRepo();
    process.env.FAKE_WRITE_FILE = "added.txt";
    const { r } = await probe(repo);
    expect(r.filesChanged).toEqual(["added.txt"]);
    await removeWorktree(await readMeta(r.worktreePath!));
  });
});
