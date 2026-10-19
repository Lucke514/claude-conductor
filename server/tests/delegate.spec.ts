import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { delegate } from "../src/delegate.js";
import { logsDir } from "../src/paths.js";
import { StateStore } from "../src/state.js";
import { knownRepoDirs } from "../src/repo.js";
import { applyWorktree, cleanupWorktrees, createWorktree, effectiveState, listWorktrees, readMeta, removeWorktree, setMetaState, worktreeAgeMs } from "../src/worktree.js";
import { ERROR_TYPES, type ProviderAdapter, type ProviderName } from "../src/providers/types.js";
import { FAKE_CODEX, isAlive, makeRepo, makeWorkspace, testConfig, tmpDir } from "./helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

function ctx(projectDir: string, overrides: Record<string, unknown> = {}) {
  return {
    projectDir,
    config: testConfig(overrides),
    store: new StateStore(path.join(tmpDir(), "state.json")),
    instanceId: "test-instance",
    sleep: async () => undefined,
  };
}

afterEach(() => {
  delete process.env.FAKE_MODE;
});

describe("delegate (integration with fake CLIs)", () => {
  it("read mode: success, prompt embeds files, never includes secrets, audit log written", async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    const promptFile = path.join(tmpDir(), "prompt.txt");
    process.env.FAKE_PROMPT_FILE = promptFile;
    const c = ctx(repo);
    const r = await delegate({ provider: "codex", task: "review index.ts", files: ["index.ts", ".env", "../outside.txt"] }, c);
    delete process.env.FAKE_PROMPT_FILE;
    expect(r.status).toBe("success");
    expect(r.provider).toBe("codex");
    expect(r.output).toContain("All good");
    expect(r.diff).toBeUndefined();
    expect(r.worktreePath).toBeUndefined();
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("export const a = 1;");
    expect(prompt).toContain("READ-ONLY MODE");
    expect(prompt).not.toContain("SECRET=1");
    expect(r.files.find((f) => f.path === ".env")?.reason).toMatch(/sensitive/);
    expect(r.files.find((f) => f.path === "../outside.txt")?.reason).toMatch(/outside/);
    // Read-mode worktree removed and no mp/* branch left.
    expect(git(repo, "branch", "--list", "mp/*")).toBe("");
    // Metrics and audit.
    const state = await c.store.read();
    expect(state.providers.codex?.metrics?.callsToday).toBe(1);
    expect(state.providers.codex?.metrics?.tokensToday).toBe(1500);
    expect(state.sessions["test-instance"]?.providers.codex?.calls).toBe(1);
    // Conductor card data: recent delegations and per-provider call history.
    expect(state.recent?.[0]).toMatchObject({ id: r.id, provider: "codex", mode: "read", status: "success", task: "review index.ts" });
    expect(state.recent?.[0]?.sdd).toBeUndefined();
    expect(state.providers.codex?.history).toHaveLength(1);
    expect(state.providers.codex?.history?.[0]).toMatchObject({ ok: true, tokens: 1500 });
    const log = readdirSync(logsDir()).map((f) => readFileSync(path.join(logsDir(), f), "utf8")).join("");
    const entry = log.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.id === r.id);
    expect(entry).toMatchObject({ provider: "codex", status: "success", mode: "read" });
    expect(entry.sdd).toBeUndefined();
    expect(entry.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entry)).not.toContain("export const a");
  });

  it("write mode: returns the diff and the worktree; apply brings changes without committing", async () => {
    const repo = makeRepo();
    const headBefore = git(repo, "rev-parse", "HEAD");
    process.env.FAKE_MODE = "write";
    const r = await delegate({ provider: "codex", task: "add a file", mode: "write", sessionId: "sess-1" }, ctx(repo));
    expect(r.status).toBe("success");
    expect(r.worktreePath).toBeDefined();
    expect(r.branch).toMatch(/^mp\/codex\/\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(r.diff).toContain("+hello from worker");
    expect(r.filesChanged).toEqual(["added-by-worker.txt"]);
    expect(r.violations).toBeUndefined();
    expect((await readMeta(r.worktreePath!)).state).toBe("verifying");
    expect(existsSync(path.join(repo, "added-by-worker.txt"))).toBe(false);

    const applied = await applyWorktree(r.worktreePath!, "t1");
    expect(applied.applied).toBe(true);
    expect(readFileSync(path.join(repo, "added-by-worker.txt"), "utf8")).toBe("hello from worker\n");
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore); // nothing committed
    expect(git(repo, "branch", "--list", "mp/*")).toBe("");
    expect(existsSync(r.worktreePath!)).toBe(false);
  });

  it("worker commits are undone with reset --soft and reported as a violation", async () => {
    const repo = makeRepo();
    process.env.FAKE_MODE = "commit";
    const c = ctx(repo);
    const r = await delegate({ provider: "codex", task: "add a file", mode: "write" }, c);
    expect(r.status).toBe("success");
    expect((await c.store.read()).recent?.[0]?.violations?.[0]?.type).toBe(r.violations?.[0]?.type);
    expect(r.violations?.[0]?.type).toBe("worker_commit");
    expect(r.diff).toContain("+hello from worker");
    const meta = await readMeta(r.worktreePath!);
    expect(git(r.worktreePath!, "rev-parse", "HEAD")).toBe(meta.baseCommit);
    const log = readdirSync(logsDir()).map((f) => readFileSync(path.join(logsDir(), f), "utf8")).join("");
    expect(log).toContain(`"id":"${r.id}"`);
    expect(log).toMatch(/worker_commit/);
    await removeWorktree(meta);
  });

  it("the worktree pre-commit hook blocks worker commits (MP_CLAUDE_COMMIT not set)", async () => {
    const repo = makeRepo();
    process.env.FAKE_MODE = "try-commit";
    const r = await delegate({ provider: "codex", task: "try to commit", mode: "write" }, ctx(repo));
    expect(r.output).toBe("commit blocked");
    expect(r.violations).toBeUndefined();
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("read mode discards writes and records write_in_read_mode", async () => {
    const repo = makeRepo();
    process.env.FAKE_MODE = "write";
    const r = await delegate({ provider: "codex", task: "look", mode: "read" }, ctx(repo));
    expect(r.violations?.map((v) => v.type)).toEqual(["write_in_read_mode"]);
    expect(r.worktreePath).toBeUndefined();
    expect(git(repo, "branch", "--list", "mp/*")).toBe("");
  });

  it("includes uncommitted tracked changes in the worktree base", async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "index.ts"), "export const a = 2;\n");
    process.env.FAKE_MODE = "write";
    const r = await delegate({ provider: "codex", task: "x", mode: "write" }, ctx(repo));
    expect(readFileSync(path.join(r.worktreePath!, "index.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(r.diff).not.toContain("index.ts");
    const applied = await applyWorktree(r.worktreePath!, "t2");
    expect(applied.applied).toBe(true);
    expect(readFileSync(path.join(repo, "index.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  it("falls back along the chain and finally to claude", async () => {
    const repo = makeRepo();
    process.env.FAKE_MODE = "auth"; // both fake CLIs fail with auth
    const r = await delegate({ provider: "auto", task: "anything" }, ctx(repo));
    expect(r.status).toBe("fallback_to_claude");
    expect(r.attempts.map((a) => [a.provider, a.errorType])).toEqual([
      ["codex", "AUTH"],
      ["antigravity", "AUTH"],
    ]);
    expect(r.summary).toMatch(/codex: AUTH/);
    expect(r.nextSteps[0]).toMatch(/Do it yourself/);
  });

  it("auto routing picks the provider configured for the task type", async () => {
    const repo = makeRepo();
    const r = await delegate(
      { provider: "auto", task: "Refactor the module" },
      ctx(repo, { routing: { refactor: "antigravity" } }),
    );
    expect(r.routing).toEqual({ rule: "refactor", provider: "antigravity" });
    expect(r.provider).toBe("antigravity");
  });

  it("write mode outside a git repo fails cleanly", async () => {
    const r = await delegate({ provider: "codex", task: "x", mode: "write" }, ctx(tmpDir()));
    expect(r.status).toBe("failed");
    expect(r.summary).toMatch(/git repository/);
  });

  it("read mode outside a git repo runs in the directory itself", async () => {
    const dir = tmpDir();
    const r = await delegate({ provider: "codex", task: "x" }, ctx(dir));
    expect(r.status).toBe("success");
  });

  it("persists the circuit breaker across delegations", async () => {
    const repo = makeRepo();
    process.env.FAKE_MODE = "crash";
    const c = ctx(repo, { circuitBreaker: { threshold: 2, cooldownMs: 60_000 }, chain: ["codex", "claude"] });
    await delegate({ provider: "codex", task: "x" }, c);
    await delegate({ provider: "codex", task: "x" }, c);
    const s = await c.store.read();
    expect(s.providers.codex?.breaker?.state).toBe("open");
    const r = await delegate({ provider: "codex", task: "x" }, c);
    expect(r.attempts[0]?.skipped).toBe("circuit_open");
    expect(r.status).toBe("fallback_to_claude");
  });

  it("cleanupWorktrees removes leftover mp/* worktrees", async () => {
    const repo = makeRepo();
    process.env.FAKE_MODE = "write";
    const r = await delegate({ provider: "codex", task: "x", mode: "write" }, ctx(repo));
    expect(existsSync(r.worktreePath!)).toBe(true);
    // git lists canonical paths (macOS /private/var, Windows long names with "/").
    const real = realpathSync.native(r.worktreePath!);
    const { removed } = await cleanupWorktrees(repo, { force: true });
    expect(removed.map((p) => path.resolve(p.path))).toContain(path.resolve(real));
    expect(git(repo, "branch", "--list", "mp/*")).toBe("");
  });

  it("refuses to apply paths outside the managed worktree dir", async () => {
    await expect(applyWorktree(tmpDir(), "x")).rejects.toThrow(/refusing/);
  });

  it("explicit model is passed only to the requested provider", async () => {
    const repo = makeRepo();
    const argsFile = path.join(tmpDir(), "args.json");
    process.env.FAKE_ARGS_FILE = argsFile;
    await delegate({ provider: "codex", task: "x", model: "my-model" }, ctx(repo));
    delete process.env.FAKE_ARGS_FILE;
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toContain("my-model");
    expect(FAKE_CODEX).toBeTruthy();
  });

  it("R5: normal delegate does not record sdd; when sdd is provided, only slug and taskId are recorded", async () => {
    const repo = makeRepo();
    const c = ctx(repo);
    const r1 = await delegate({ provider: "codex", task: "first normal" }, c);
    const state1 = await c.store.read();
    expect(state1.recent?.[0]?.sdd).toBeUndefined();

    const r2 = await delegate(
      {
        provider: "codex",
        task: "with sdd",
        sdd: Object.assign({ slug: "demo", taskId: "T1" }, { extra: "ignored" }),
      },
      c,
    );
    const state2 = await c.store.read();
    expect(state2.recent?.[0]?.sdd).toEqual({ slug: "demo", taskId: "T1" });
    expect(Object.keys(state2.recent?.[0]?.sdd ?? {})).toEqual(["slug", "taskId"]);

    const log = readdirSync(logsDir()).map((f) => readFileSync(path.join(logsDir(), f), "utf8")).join("");
    const lines = log.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const entry1 = lines.find((e) => e.id === r1.id);
    const entry2 = lines.find((e) => e.id === r2.id);
    expect(entry1?.sdd).toBeUndefined();
    expect(entry2?.sdd).toEqual({ slug: "demo", taskId: "T1" });
    expect(Object.keys(entry2?.sdd ?? {})).toEqual(["slug", "taskId"]);
  });
});

/** Resolves once `file` exists (the fake worker is running), then returns its contents. */
async function waitForFile(file: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) return readFileSync(file, "utf8");
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${file}`);
}

describe("delegate cancellation", () => {
  afterEach(() => {
    delete process.env.FAKE_PID_FILE;
  });

  it("R6/E3: aborting a write kills the worker, tries no other provider, keeps the breaker and the partial diff", async () => {
    const repo = makeRepo();
    const pidFile = path.join(tmpDir(), "pid");
    process.env.FAKE_MODE = "hang-write";
    process.env.FAKE_PID_FILE = pidFile;
    const ac = new AbortController();
    const c = { ...ctx(repo), signal: ac.signal };
    const run = delegate({ provider: "codex", task: "long job", mode: "write" }, c);
    const pid = Number(await waitForFile(pidFile));
    ac.abort();
    const r = await run;
    expect(r.status).toBe("cancelled");
    expect(r.attempts).toEqual([expect.objectContaining({ provider: "codex", errorType: "CANCELLED" })]);
    for (let i = 0; i < 40 && isAlive(pid); i++) await new Promise((res) => setTimeout(res, 50));
    expect(isAlive(pid)).toBe(false);
    expect(r.diff).toContain("partial work");
    expect(r.worktreePath && existsSync(r.worktreePath)).toBe(true);
    expect(r.nextSteps[0]).toContain("Cancelled");
    const s = await c.store.read();
    expect(s.providers.codex?.breaker?.consecutiveFailures ?? 0).toBe(0);
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("R6: a signal aborted before the call starts no worker", async () => {
    const repo = makeRepo();
    const ac = new AbortController();
    ac.abort();
    const r = await delegate({ provider: "codex", task: "never", mode: "write" }, { ...ctx(repo), signal: ac.signal });
    expect(r.status).toBe("cancelled");
    expect(r.attempts).toEqual([]);
    expect(git(repo, "branch", "--list", "mp/*")).toBe("");
  });
});

describe("provider-reliability R4/R5: idle timeout and partial results", () => {
  it("R5: a write that stalls after changing files ends as partial, with one attempt and its diff", async () => {
    const repo = makeRepo();
    process.env.FAKE_MODE = "hang-write";
    const c = ctx(repo, { defaults: { idleTimeoutMs: 300 } });
    const r = await delegate({ provider: "codex", task: "big job", mode: "write" }, c);
    expect(r.status).toBe("partial");
    expect(r.attempts).toEqual([expect.objectContaining({ provider: "codex", errorType: "STALLED" })]);
    expect(r.diff).toContain("partial work");
    expect(r.patchFile && existsSync(r.patchFile)).toBe(true);
    expect(r.nextSteps[0]).toContain("failed (STALLED)");
    expect(git(repo, "branch", "--list", "mp/*").split("\n").filter(Boolean)).toHaveLength(1);
    expect((await c.store.read()).providers.codex?.breaker?.consecutiveFailures ?? 0).toBe(0);
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("R5: without changes, a timeout is retried per retryOn and nothing is kept", async () => {
    const repo = makeRepo();
    process.env.FAKE_MODE = "stall";
    const c = ctx(repo, { retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 } });
    const r = await delegate({ provider: "codex", task: "quiet", mode: "write", timeoutMs: 400, fallback: false }, c);
    expect(r.status).toBe("failed");
    expect(r.attempts.map((a) => a.errorType)).toEqual(["TIMEOUT", "TIMEOUT"]);
    expect(git(repo, "branch", "--list", "mp/*")).toBe("");
  });
});

import { gitConfigEnv } from "../src/worktree.js";
describe("nested-repos: delegate with repo", () => {
  /** Adapters that record every call: SC3 needs proof that no worker started. */
  function spyAdapters(): { calls: string[]; adapters: Record<ProviderName, ProviderAdapter> } {
    const calls: string[] = [];
    const make = (name: ProviderName): ProviderAdapter => ({
      name,
      isAvailable: async () => true,
      healthCheck: async () => ({ installed: true, auth: "ok" }) as never,
      run: async () => {
        calls.push(name);
        return { ok: true, output: "ok", exitCode: 0, durationMs: 1 };
      },
    });
    return { calls, adapters: { codex: make("codex"), antigravity: make("antigravity") } };
  }

  it("R1/SC3: a repo that escapes the project or is not a git repo fails before any worktree or worker", async () => {
    const { root } = makeWorkspace();
    const outside = makeRepo();
    for (const repo of ["../x", outside, "missing", ".claude"]) {
      const spy = spyAdapters();
      if (repo === ".claude") execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(path.join(root, ".claude"))})`]);
      await expect(delegate({ provider: "codex", task: "t", mode: "write", repo }, { ...ctx(root), adapters: spy.adapters })).rejects.toMatchObject({
        code: expect.stringMatching(/^REPO_(INVALID|NOT_GIT|NOT_FOUND)$/),
      });
      expect(spy.calls).toEqual([]);
    }
    expect(git(root, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(path.join(root, "backend-monolith"), "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("R2: the worktree comes from the nested repo; files resolve against it, with or without its prefix", async () => {
    const { root, nested } = makeWorkspace();
    const promptFile = path.join(tmpDir(), "prompt.txt");
    process.env.FAKE_PROMPT_FILE = promptFile;
    process.env.FAKE_MODE = "write";
    const r = await delegate(
      { provider: "codex", task: "add a file", mode: "write", repo: "backend-monolith", files: ["package.json", "backend-monolith/index.ts"] },
      ctx(root),
    );
    delete process.env.FAKE_PROMPT_FILE;
    expect(r.status).toBe("success");
    expect(r.repo).toBe("backend-monolith");
    const meta = await readMeta(r.worktreePath!);
    expect(realpathSync.native(meta.repoRoot)).toBe(realpathSync.native(nested));
    expect(existsSync(path.join(r.worktreePath!, "package.json"))).toBe(true);
    expect(existsSync(path.join(r.worktreePath!, ".gitignore"))).toBe(true);
    expect(r.filesChanged).toEqual(["added-by-worker.txt"]);
    expect(r.files.filter((f) => f.included).map((f) => f.path)).toEqual(["package.json", "index.ts"]);
    expect(readFileSync(promptFile, "utf8")).toContain('"name": "backend-monolith"');
    // The branch lives in the nested repo, not in the workspace root.
    expect(git(nested, "branch", "--list", "mp/*")).not.toBe("");
    expect(git(root, "branch", "--list", "mp/*")).toBe("");

    const applied = await applyWorktree(r.worktreePath!, "nested");
    expect(applied.applied).toBe(true);
    expect(existsSync(path.join(nested, "added-by-worker.txt"))).toBe(true);
    expect(existsSync(path.join(root, "added-by-worker.txt"))).toBe(false);
  });

  it("R2: symlinkByRepo links the repo's own entries; other repos fall back to isolation.symlink", async () => {
    const { root, nested } = makeWorkspace();
    execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(path.join(nested, "node_modules", "dep"))}, { recursive: true })`]);
    process.env.FAKE_MODE = "write";
    const r = await delegate(
      { provider: "codex", task: "t", mode: "write", repo: "backend-monolith" },
      ctx(root, { isolation: { symlink: ["nothing-here"], symlinkByRepo: { "backend-monolith": ["node_modules"] } } }),
    );
    const meta = await readMeta(r.worktreePath!);
    expect(meta.symlinks).toEqual(["node_modules"]);
    expect(existsSync(path.join(r.worktreePath!, "node_modules", "dep"))).toBe(true);
    expect(r.filesChanged).toEqual(["added-by-worker.txt"]);
    await removeWorktree(meta);
  });

  it("R3/SC1: the worker sees the nested repo's tracked files, never its .env, nor the workspace's path", async () => {
    const { root, nested } = makeWorkspace();
    const probeFile = path.join(tmpDir(), "probe.json");
    const promptFile = path.join(tmpDir(), "prompt.txt");
    const pwd = process.env.PWD;
    Object.assign(process.env, {
      FAKE_MODE: "probe-secrets",
      FAKE_PROBE_FILE: probeFile,
      FAKE_PROMPT_FILE: promptFile,
      FAKE_FORBIDDEN_PATH: [root, realpathSync.native(root)].join(","),
      CLAUDE_PROJECT_DIR: root,
      MP_PROJECT_DIR: root,
      PWD: nested,
    });
    try {
      const r = await delegate({ provider: "codex", task: "review backend-monolith", repo: "backend-monolith", files: ["package.json", ".env"] }, ctx(root));
      expect(r.status).toBe("success");
      const probe = JSON.parse(readFileSync(probeFile, "utf8"));
      expect(probe.cwd).toContain("package.json");
      expect(probe.cwd).not.toContain(".env");
      expect(probe.packageJson.ok).toBe(true);
      expect(probe.env).toEqual({ ok: false, code: "ENOENT" });
      expect(probe.leaks).toEqual([]);
      const prompt = readFileSync(promptFile, "utf8");
      expect(prompt).not.toContain("prod-secret");
      expect(prompt).not.toContain(root);
      expect(prompt).not.toContain(realpathSync.native(root));
      expect(r.files.find((f) => f.path === ".env")?.reason).toMatch(/sensitive/);
    } finally {
      for (const k of ["FAKE_PROBE_FILE", "FAKE_PROMPT_FILE", "FAKE_FORBIDDEN_PATH", "CLAUDE_PROJECT_DIR", "MP_PROJECT_DIR"]) delete process.env[k];
      if (pwd === undefined) delete process.env.PWD;
      else process.env.PWD = pwd;
    }
  });

  it("R3: a symlink entry naming secrets is skipped and noted; the hooks live outside the source repo's .git", async () => {
    const { root, nested } = makeWorkspace();
    process.env.FAKE_MODE = "write";
    const r = await delegate(
      { provider: "codex", task: "t", mode: "write", repo: "backend-monolith" },
      ctx(root, { isolation: { symlinkByRepo: { "backend-monolith": [".env", "config/.env.production"] } } }),
    );
    const meta = await readMeta(r.worktreePath!);
    expect(meta.symlinks).toEqual([]);
    expect(meta.skippedSymlinks).toEqual([".env", "config/.env.production"]);
    expect(existsSync(path.join(r.worktreePath!, ".env"))).toBe(false);
    expect(r.notes?.some((n) => n.includes("symlink skipped") && n.includes(".env"))).toBe(true);
    const rel = path.relative(realpathSync.native(nested), realpathSync.native(meta.hooksDir));
    expect(rel.startsWith("..") || path.isAbsolute(rel)).toBe(true);
    expect(existsSync(path.join(meta.hooksDir, "pre-commit"))).toBe(true);
    await removeWorktree(meta);
    expect(existsSync(meta.hooksDir)).toBe(false);
  });

  it("R3: a worker in a nested repo's worktree still cannot commit", async () => {
    const { root, nested } = makeWorkspace();
    process.env.FAKE_MODE = "try-commit";
    const r = await delegate({ provider: "codex", task: "t", mode: "write", repo: "backend-monolith" }, ctx(root));
    expect(r.output).toContain("commit blocked");
    expect(git(nested, "log", "--oneline").split("\n")).toHaveLength(2);
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("E4: a tracked .env named in files stays out of the prompt", async () => {
    const { root, nested } = makeWorkspace();
    writeFileSync(path.join(nested, ".gitignore"), "");
    git(nested, "add", "-A");
    git(nested, "commit", "-qm", "track .env");
    const promptFile = path.join(tmpDir(), "prompt.txt");
    process.env.FAKE_PROMPT_FILE = promptFile;
    const r = await delegate({ provider: "codex", task: "t", repo: "backend-monolith", files: ["backend-monolith/.env"] }, ctx(root));
    delete process.env.FAKE_PROMPT_FILE;
    expect(r.files[0]?.reason).toMatch(/sensitive/);
    expect(readFileSync(promptFile, "utf8")).not.toContain("prod-secret");
  });

  it("R11: a nested repo is registered; listing and cleanup reach its mp/* worktrees, foreign registrations are ignored", async () => {
    const { root, nested } = makeWorkspace();
    const c = ctx(root);
    process.env.FAKE_MODE = "write";
    const r = await delegate({ provider: "codex", task: "t", mode: "write", repo: "backend-monolith", sdd: { slug: "demo", taskId: "T3" } }, c);
    const state = await c.store.read();
    expect(state.repos?.map((p) => realpathSync.native(p))).toEqual([realpathSync.native(nested)]);
    // The root alone does not see it; with the registry it does.
    expect(await listWorktrees(root)).toEqual([]);
    const outside = makeRepo();
    const dirs = knownRepoDirs(root, [...state.repos!, outside, path.join(root, "gone")]);
    expect(dirs).toHaveLength(2);
    expect((await listWorktrees(dirs)).map((m) => m.sdd)).toEqual([{ slug: "demo", taskId: "T3" }]);
    expect((await cleanupWorktrees(dirs, { force: true })).removed.map((p) => path.basename(p.path))).toEqual([path.basename(r.worktreePath!)]);
    expect(existsSync(r.worktreePath!)).toBe(false);
    expect(git(nested, "branch", "--list", "mp/*")).toBe("");
  });

  it("R6/SC4: readMode cwd with a reachable .env is refused before any worker; allowCwdWithSecrets runs it with a note", async () => {
    const { root } = makeWorkspace();
    const spy = spyAdapters();
    const cfg = { isolation: { readMode: "cwd" } };
    const err = await delegate({ provider: "codex", task: "t" }, { ...ctx(root, cfg), adapters: spy.adapters }).catch((e) => e);
    expect(err).toMatchObject({ code: "UNSAFE_READ_MODE" });
    expect(err.message).toContain("backend-monolith/.env");
    expect(spy.calls).toEqual([]);
    // The same through repo: the scan covers the repo's own tree.
    await expect(delegate({ provider: "codex", task: "t", repo: "backend-monolith" }, { ...ctx(root, cfg), adapters: spy.adapters })).rejects.toMatchObject({
      code: "UNSAFE_READ_MODE",
    });
    expect(spy.calls).toEqual([]);
    const ok = await delegate({ provider: "codex", task: "t" }, { ...ctx(root, { isolation: { readMode: "cwd", allowCwdWithSecrets: true } }), adapters: spy.adapters });
    expect(ok.status).toBe("success");
    expect(spy.calls).toEqual(["codex"]);
    expect(ok.notes?.some((n) => n.includes("allowCwdWithSecrets") && n.includes("backend-monolith/.env"))).toBe(true);
    // A tree without .env files runs in cwd as before.
    expect((await delegate({ provider: "codex", task: "t" }, { ...ctx(makeRepo(), cfg), adapters: spyAdapters().adapters })).status).toBe("success");
  });

  it("G2: an empty repo is rejected; a repo prefix is stripped once, from files and scopeFiles alike", async () => {
    const { root, nested } = makeWorkspace();
    await expect(delegate({ provider: "codex", task: "t", repo: "" }, ctx(root))).rejects.toMatchObject({ code: "REPO_INVALID" });
    execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(path.join(nested, "backend-monolith"))})`]);
    writeFileSync(path.join(nested, "backend-monolith", "inner.ts"), "export const inner = 1;\n");
    git(nested, "add", "-A");
    git(nested, "commit", "-qm", "inner dir named like the repo");
    process.env.FAKE_MODE = "write";
    const r = await delegate(
      {
        provider: "codex",
        task: "t",
        mode: "write",
        repo: "backend-monolith",
        files: ["backend-monolith/backend-monolith/inner.ts"],
        scopeFiles: ["backend-monolith/added-by-worker.txt"],
      },
      ctx(root),
    );
    expect(r.files.find((f) => f.included)?.path).toBe("backend-monolith/inner.ts");
    expect(r.violations).toBeUndefined();
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("G4: secrets reached through symlinks never get in: files, symlink entries; PATH loses the source paths", async () => {
    const { root, nested } = makeWorkspace();
    const kind = process.platform === "win32" ? "junction" : "dir";
    // A tracked-looking file that points at the .env, and a directory holding an ignored secret.
    symlinkSync(path.join(nested, ".env"), path.join(nested, "settings.txt"));
    mkdirSync(path.join(nested, "config"));
    writeFileSync(path.join(nested, "config", ".env.production"), "PROD=1\n");
    symlinkSync(path.join(nested, "config"), path.join(nested, "conf-link"), kind);
    mkdirSync(path.join(nested, "node_modules", "dotenv-example"), { recursive: true });
    writeFileSync(path.join(nested, "node_modules", "dotenv-example", ".env"), "EXAMPLE=1\n");
    const promptFile = path.join(tmpDir(), "prompt.txt");
    const probeFile = path.join(tmpDir(), "probe.json");
    const pathKeyName = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const pathBefore = process.env[pathKeyName];
    Object.assign(process.env, {
      FAKE_PROMPT_FILE: promptFile,
      FAKE_MODE: "probe-secrets",
      FAKE_PROBE_FILE: probeFile,
      FAKE_FORBIDDEN_PATH: [root, realpathSync.native(root)].join(","),
      [pathKeyName]: [path.join(nested, "node_modules", ".bin"), pathBefore].join(path.delimiter),
    });
    try {
      const r = await delegate(
        { provider: "codex", task: "t", repo: "backend-monolith", files: ["settings.txt"] },
        ctx(root, { isolation: { symlinkByRepo: { "backend-monolith": ["config", "conf-link", "node_modules"] } } }),
      );
      expect(r.files[0]).toMatchObject({ included: false, reason: expect.stringMatching(/sensitive/) });
      expect(readFileSync(promptFile, "utf8")).not.toContain("prod-secret");
      expect(r.notes?.find((n) => n.startsWith("symlink skipped"))).toContain("config, conf-link");
      const probe = JSON.parse(readFileSync(probeFile, "utf8"));
      expect(probe.cwd).toContain("node_modules");
      expect(probe.cwd).not.toContain("config");
      expect(probe.leaks).toEqual([]);
    } finally {
      process.env[pathKeyName] = pathBefore;
      for (const k of ["FAKE_PROMPT_FILE", "FAKE_PROBE_FILE", "FAKE_FORBIDDEN_PATH"]) delete process.env[k];
    }
  });

  it("E1: a nested repo without commits names the repo", async () => {
    const root = makeRepo();
    const empty = path.join(root, "fresh");
    execFileSync("git", ["init", "-q", empty]);
    process.env.FAKE_MODE = "write";
    await expect(delegate({ provider: "codex", task: "t", mode: "write", repo: "fresh" }, ctx(root))).rejects.toThrow(/repository fresh has no commits yet/);
  });

  it("E6: two repos get two worktree directories", async () => {
    const { root } = makeWorkspace();
    const other = path.join(root, "web-app");
    execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(other)})`]);
    makeRepo(other);
    process.env.FAKE_MODE = "write";
    const a = await delegate({ provider: "codex", task: "t", mode: "write", repo: "backend-monolith" }, ctx(root));
    const b = await delegate({ provider: "codex", task: "t", mode: "write", repo: "web-app" }, ctx(root));
    expect(path.dirname(a.worktreePath!)).not.toBe(path.dirname(b.worktreePath!));
    await removeWorktree(await readMeta(a.worktreePath!));
    await removeWorktree(await readMeta(b.worktreePath!));
  });
});

describe("nested-repos R8: chainByMode", () => {
  /** Codex fails with AUTH; antigravity answers. Records who was called. */
  function adapters() {
    const calls: string[] = [];
    const make = (name: ProviderName, ok: boolean): ProviderAdapter => ({
      name,
      isAvailable: async () => true,
      healthCheck: async () => ({}) as never,
      run: async () => {
        calls.push(name);
        return ok
          ? { ok: true, output: "## Summary\nok", exitCode: 0, durationMs: 1 }
          : { ok: false, output: "", exitCode: 1, durationMs: 1, error: { type: "AUTH", message: "401 Unauthorized" } };
      },
    });
    return { calls, adapters: { codex: make("codex", false), antigravity: make("antigravity", true) } };
  }
  const byMode = { chainByMode: { read: ["codex", "claude"] } };

  it("SC5: with chainByMode.read [codex, claude] and codex down, read falls back to claude and never calls agy", async () => {
    const a = adapters();
    const r = await delegate({ provider: "codex", task: "t" }, { ...ctx(makeRepo(), byMode), adapters: a.adapters });
    expect(r.status).toBe("fallback_to_claude");
    expect(a.calls).toEqual(["codex"]);
  });

  it("the write chain stays `chain`; a read chain without claude ends failed; no chainByMode keeps today's order", async () => {
    let a = adapters();
    const w = await delegate({ provider: "codex", task: "t", mode: "write" }, { ...ctx(makeRepo(), byMode), adapters: a.adapters });
    expect(a.calls).toEqual(["codex", "antigravity"]);
    expect(w.provider).toBe("antigravity");
    a = adapters();
    const f = await delegate({ provider: "codex", task: "t" }, { ...ctx(makeRepo(), { chainByMode: { read: ["codex"] } }), adapters: a.adapters });
    expect(f.status).toBe("failed");
    a = adapters();
    await delegate({ provider: "codex", task: "t" }, { ...ctx(makeRepo()), adapters: a.adapters });
    expect(a.calls).toEqual(["codex", "antigravity"]);
  });

  it("R9/SC6: a fallback answer carries requestedProvider and an explicit note; a direct one carries no note", async () => {
    const a = adapters();
    const r = await delegate({ provider: "codex", task: "t" }, { ...ctx(makeRepo()), adapters: a.adapters });
    expect(r).toMatchObject({ requestedProvider: "codex", provider: "antigravity", status: "success" });
    expect(r.notes).toContain("requested codex, answered by antigravity (fallback after codex: AUTH)");
    const auto = await delegate({ provider: "auto", task: "t" }, { ...ctx(makeRepo()), adapters: adapters().adapters });
    expect(auto.requestedProvider).toBe("auto");
    expect(auto.notes).toContain("requested codex, answered by antigravity (fallback after codex: AUTH)");
    const direct = await delegate({ provider: "antigravity", task: "t" }, { ...ctx(makeRepo()), adapters: adapters().adapters });
    expect(direct.requestedProvider).toBe("antigravity");
    expect(direct.notes ?? []).not.toContainEqual(expect.stringContaining("answered by"));
  });

  it("an explicit provider outside the mode's chain is tried first; an auto route outside it is ignored with a note", async () => {
    let a = adapters();
    const r = await delegate({ provider: "antigravity", task: "t" }, { ...ctx(makeRepo(), byMode), adapters: a.adapters });
    expect(a.calls).toEqual(["antigravity"]);
    expect(r.status).toBe("success");
    a = adapters();
    const auto = await delegate(
      { provider: "auto", task: "refactor this", taskType: "refactor" },
      { ...ctx(makeRepo(), { ...byMode, routing: { refactor: "antigravity" } }), adapters: a.adapters },
    );
    expect(a.calls).toEqual(["codex"]);
    expect(auto.routing).toBeUndefined();
    expect(auto.notes?.some((n) => n.includes("not in the read chain"))).toBe(true);
  });
});

describe("gitConfigEnv", () => {
  it("appends to existing GIT_CONFIG_* entries", () => {
    const hooks: [string, string][] = [["core.hooksPath", "/h"]];
    expect(gitConfigEnv(hooks, { GIT_CONFIG_COUNT: "3" })).toEqual({ GIT_CONFIG_COUNT: "4", GIT_CONFIG_KEY_3: "core.hooksPath", GIT_CONFIG_VALUE_3: "/h" });
    expect(gitConfigEnv(hooks, {})).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/h" });
  });
});

describe("delegation-lifecycle metadata", () => {
  it("creates running metadata and persists audited transitions without content", async () => {
    const meta = await createWorktree({ cwd: makeRepo(), provider: "codex", includeUncommitted: false, symlink: [], id: "lifecycle-test" });
    try {
      expect(await readMeta(meta.path)).toEqual(meta);
      expect(meta.state).toBe("running");
      expect(meta.updatedAt).toBe(meta.createdAt);
      const before = Date.now();
      const extra = { patchSha256: "a".repeat(64), verification: { result: "pass" as const, modifiedFiles: ["private-file.ts"] } };
      const updated = await setMetaState(meta.path, "verifying", extra);
      expect(Date.parse(updated.updatedAt!)).toBeGreaterThanOrEqual(before);
      expect(updated).toMatchObject({ ...meta, ...extra, state: "verifying", updatedAt: expect.any(String) });
      expect(await readMeta(meta.path)).toEqual(updated);
      await setMetaState(meta.path, "awaiting_review");
      const entries = readdirSync(logsDir()).flatMap((f) => readFileSync(path.join(logsDir(), f), "utf8").trim().split("\n").map((l) => JSON.parse(l)))
        .filter((e) => e.id === "lifecycle-test");
      expect(entries).toEqual([
        { type: "lifecycle", id: meta.id, ts: updated.updatedAt, from: "running", to: "verifying" },
        { type: "lifecycle", id: meta.id, ts: expect.any(String), from: "verifying", to: "awaiting_review" },
      ]);
    } finally {
      await removeWorktree(meta);
    }
  });

  it("resolves legacy states and honors every explicit state", () => {
    expect(effectiveState({}, true)).toBe("awaiting_review");
    expect(effectiveState({}, false)).toBe("discardable");
    for (const state of ["running", "verifying", "awaiting_review", "recoverable", "discardable"] as const) {
      expect(effectiveState({ state }, true)).toBe(state);
      expect(effectiveState({ state }, false)).toBe(state);
    }
  });

  it("uses updatedAt with a createdAt fallback regardless of directory mtime", async () => {
    const meta = await createWorktree({ cwd: makeRepo(), provider: "codex", includeUncommitted: false, symlink: [] });
    try {
      const now = Date.parse(meta.createdAt) + 1000;
      utimesSync(meta.path, new Date(0), new Date(0));
      expect(worktreeAgeMs(await readMeta(meta.path), now)).toBe(1000);
      expect(worktreeAgeMs({ createdAt: new Date(0).toISOString(), updatedAt: meta.updatedAt }, now)).toBe(1000);
      expect(worktreeAgeMs({ createdAt: meta.createdAt }, now)).toBe(1000);
      await expect(setMetaState(meta.path, "recoverable")).rejects.toThrow(/delegation id/);
      expect(await readMeta(meta.path)).toEqual(meta);
      expect((await setMetaState(meta.path, "recoverable", { id: "legacy-id" })).id).toBe("legacy-id");
    } finally {
      await removeWorktree(meta);
    }
  });
});

describe("delegation-lifecycle cleanup", () => {
  it("preserves protected states regardless of age and expires only old disposable work", async () => {
    const repo = makeRepo();
    const old = new Date(Date.now() - 72 * 3600_000).toISOString();
    const states = ["running", "verifying", "awaiting_review", "recoverable", "discardable"] as const;
    for (const state of states) {
      const meta = await createWorktree({ cwd: repo, provider: "codex", includeUncommitted: false, symlink: [] });
      writeFileSync(path.join(git(meta.path, "rev-parse", "--absolute-git-dir"), "mp-meta.json"),
        JSON.stringify({ ...meta, state, updatedAt: old }));
    }
    const recent = await createWorktree({ cwd: repo, provider: "codex", includeUncommitted: false, symlink: [] });
    writeFileSync(path.join(git(recent.path, "rev-parse", "--absolute-git-dir"), "mp-meta.json"),
      JSON.stringify({ ...recent, state: "discardable", createdAt: old }));
    utimesSync(recent.path, new Date(0), new Date(0));
    git(repo, "branch", "mp/orphan");
    const result = await cleanupWorktrees([repo, repo]);
    expect(result.removed).toEqual([expect.objectContaining({ state: "discardable", ageMs: expect.any(Number) })]);
    expect(result.removed[0]!.ageMs).toBeGreaterThan(24 * 3600_000);
    expect(result.kept.map((e) => e.state).sort()).toEqual([...states].sort());
    expect(existsSync(recent.path)).toBe(true);
    expect(git(repo, "branch", "--list", "mp/orphan")).toContain("mp/orphan");
    const forced = await cleanupWorktrees(repo, { force: true, maxAgeMs: Number.MAX_SAFE_INTEGER });
    expect(forced.removed).toHaveLength(5);
    expect(forced.kept).toEqual([]);
    expect(git(repo, "branch", "--list", "mp/*")).toBe("");
  });

  it("classifies legacy changes and uses corrupt metadata mtime or missing metadata directory age", async () => {
    const repo = makeRepo();
    const old = new Date(Date.now() - 72 * 3600_000);
    for (const kind of ["legacy-clean", "legacy-dirty", "corrupt-old", "corrupt-new", "missing"]) {
      const meta = await createWorktree({ cwd: repo, provider: "codex", includeUncommitted: false, symlink: [] });
      const file = path.join(git(meta.path, "rev-parse", "--absolute-git-dir"), "mp-meta.json");
      if (kind.startsWith("legacy")) {
        const { state, updatedAt, ...legacy } = meta;
        writeFileSync(file, JSON.stringify({ ...legacy, createdAt: old.toISOString() }));
        if (kind === "legacy-dirty") writeFileSync(path.join(meta.path, "pending.txt"), "keep");
      } else if (kind === "missing") {
        unlinkSync(file);
        utimesSync(meta.path, old, old);
      } else {
        writeFileSync(file, "{broken");
        if (kind === "corrupt-old") utimesSync(file, old, old);
        else utimesSync(meta.path, old, old);
      }
    }
    const result = await cleanupWorktrees(repo);
    expect(result.removed.map((e) => e.state).sort()).toEqual(["discardable", null, null].sort());
    expect(result.kept.map((e) => e.state).sort()).toEqual(["awaiting_review", null].sort());
    git(repo, "branch", "mp/orphan");
    const immediate = await cleanupWorktrees(repo, { maxAgeMs: 0 });
    expect(immediate.kept.map((e) => e.state)).toEqual(["awaiting_review"]);
    expect(git(repo, "branch", "--list", "mp/orphan")).toBe("");
    await cleanupWorktrees(repo, { force: true });
  });
});

describe("delegation-lifecycle failed write fallback", () => {
  it.each(ERROR_TYPES)("preserves changes after %s and never retries or starts another provider", async (errorType) => {
    const repo = makeRepo();
    const calls: ProviderName[] = [];
    const make = (name: ProviderName): ProviderAdapter => ({
      name,
      isAvailable: async () => true,
      healthCheck: async () => ({}) as never,
      run: async ({ cwd }) => {
        calls.push(name);
        writeFileSync(path.join(cwd, "pending.txt"), "partial work\n");
        return { ok: false, output: "", exitCode: 1, durationMs: 1, error: { type: errorType, message: "failed" } };
      },
    });
    const r = await delegate({ provider: "codex", task: "t", mode: "write" }, {
      ...ctx(repo, { retry: { maxRetries: 2, retryOn: ["RATE_LIMIT", "TIMEOUT"] } }),
      adapters: { codex: make("codex"), antigravity: make("antigravity") },
    });
    try {
      expect(calls).toEqual(["codex"]);
      expect(r.status).toBe(errorType === "CANCELLED" ? "cancelled" : "partial");
      expect(r.errorType).toBe(errorType);
      expect(r.attempts).toEqual([expect.objectContaining({ provider: "codex", errorType })]);
      expect(r.diff).toContain("+partial work");
      expect(r.filesChanged).toEqual(["pending.txt"]);
      expect(await readMeta(r.worktreePath!)).toMatchObject({ id: r.id, state: "recoverable" });
      if (errorType !== "CANCELLED") {
        expect(r.nextSteps.join(" ")).toContain("`delegation_apply`");
        expect(r.nextSteps.join(" ")).toContain("`delegation_discard` with the worktreePath, then a new `delegate`");
      }
    } finally {
      await removeWorktree(await readMeta(r.worktreePath!));
    }
  });

  it.each(["crash-write", "crash"])("real CLI %s preserves only writes and otherwise falls back", async (mode) => {
    const repo = makeRepo();
    process.env.FAKE_MODE = mode;
    const r = await delegate({ provider: "codex", task: "t", mode: "write" }, ctx(repo));
    if (mode === "crash-write") {
      expect(r.status).toBe("partial");
      expect(r.errorType).toBe("NON_ZERO_EXIT");
      expect(r.attempts).toHaveLength(1);
      expect(r.diff).toContain("+partial work");
      const meta = await readMeta(r.worktreePath!);
      expect(meta.state).toBe("recoverable");
      await removeWorktree(meta);
    } else {
      expect(r.status).toBe("fallback_to_claude");
      expect(r.attempts.map((a) => a.provider)).toContain("antigravity");
      expect(r.worktreePath).toBeUndefined();
      expect(git(repo, "branch", "--list", "mp/*")).toBe("");
    }
  });
});
