import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { delegate } from "../src/delegate.js";
import { StateStore } from "../src/state.js";
import { CREDENTIAL_ENV, GH_SHIM_MESSAGE, pathKey, shimDir, workerEnv } from "../src/worker-env.js";
import { applyWorktree, removeWorktree, readMeta } from "../src/worktree.js";
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

function sddRepo() {
  const repo = makeRepo();
  mkdirSync(path.join(repo, "specs", "demo"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "demo", "tasks.md"), "# Tasks\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "specs");
  return repo;
}

describe("specs/ is off limits (R3, E2)", () => {
  it("restores the worker's specs/ edits, keeps them out of the diff and of delegation_apply", async () => {
    const repo = sddRepo();
    process.env.FAKE_WRITE_FILE = "specs/demo/tasks.md,index.ts,specs/new/spec.md";
    const { r } = await probe(repo);
    expect(r.filesChanged).toEqual(["index.ts"]);
    expect(r.diff).not.toContain("specs/");
    expect(r.violations).toContainEqual(expect.objectContaining({ type: "specs_modified", files: ["specs/demo/tasks.md", "specs/new/spec.md"] }));
    const applied = await applyWorktree(r.worktreePath!, "t");
    expect(applied).toMatchObject({ applied: true, files: ["index.ts"] });
    expect(readFileSync(path.join(repo, "specs/demo/tasks.md"), "utf8")).toBe("# Tasks\n");
    expect(existsSync(path.join(repo, "specs/new"))).toBe(false);
    expect(git(repo, "status", "--porcelain").replace(/^.. /, "")).toBe("index.ts");
  });

  it("read mode reports specs_modified next to write_in_read_mode", async () => {
    const repo = sddRepo();
    process.env.FAKE_WRITE_FILE = "specs/demo/tasks.md,index.ts";
    const { r } = await probe(repo, "read");
    expect(r.violations?.map((v) => v.type).sort()).toEqual(["specs_modified", "write_in_read_mode"]);
  });
});

describe("remote push check (R6, E6, E7)", () => {
  function withBareRemote() {
    const repo = makeRepo();
    const bare = tmpDir("mp-bare-");
    git(bare, "init", "-q", "--bare");
    git(repo, "remote", "add", "origin", bare);
    return { repo, bare };
  }

  it("flags a branch the worker pushed past the hooks and says how to delete it", async () => {
    const { repo, bare } = withBareRemote();
    process.env.FAKE_PUSH = "origin";
    process.env.FAKE_WRITE_FILE = "added.txt";
    const { r, p } = await probe(repo);
    expect(p.push!.code).toBe(0);
    const pushed = r.violations?.find((v) => v.type === "worker_push");
    expect(pushed).toMatchObject({ type: "worker_push", remote: "origin", branch: r.branch });
    expect(git(bare, "branch", "--list", "mp/*")).toContain(r.branch!);
    expect(r.nextSteps.join("\n")).toContain(`git push origin --delete ${r.branch}`);
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("guardrails.checkRemotePush=false skips the check", async () => {
    const { repo } = withBareRemote();
    process.env.FAKE_PUSH = "origin";
    const { r } = await probe(repo, "write", { guardrails: { checkRemotePush: false } });
    expect(r.violations?.some((v) => v.type === "worker_push") ?? false).toBe(false);
  });

  it("an unreachable remote is a note, not a violation; no remotes means no note", async () => {
    const repo = makeRepo();
    git(repo, "remote", "add", "origin", "http://127.0.0.1:9/x.git");
    const { r } = await probe(repo);
    expect(r.violations ?? []).toEqual([]);
    expect(r.notes?.some((n) => n.startsWith("push check skipped: origin:"))).toBe(true);
    const { r: none } = await probe(makeRepo());
    expect(none.notes?.some((n) => n.startsWith("push check")) ?? false).toBe(false);
  });
});
