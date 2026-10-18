import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { delegate } from "../src/delegate.js";
import { logsDir } from "../src/paths.js";
import { StateStore } from "../src/state.js";
import { applyWorktree, cleanupWorktrees, readMeta, removeWorktree } from "../src/worktree.js";
import { FAKE_CODEX, isAlive, makeRepo, testConfig, tmpDir } from "./helpers.js";

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
    const removed = await cleanupWorktrees(repo);
    expect(removed.map((p) => path.resolve(p))).toContain(path.resolve(real));
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
    expect(r.nextSteps[0]).toContain("ran out of time");
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
describe("gitConfigEnv", () => {
  it("appends to existing GIT_CONFIG_* entries", () => {
    const hooks: [string, string][] = [["core.hooksPath", "/h"]];
    expect(gitConfigEnv(hooks, { GIT_CONFIG_COUNT: "3" })).toEqual({ GIT_CONFIG_COUNT: "4", GIT_CONFIG_KEY_3: "core.hooksPath", GIT_CONFIG_VALUE_3: "/h" });
    expect(gitConfigEnv(hooks, {})).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/h" });
  });
});
