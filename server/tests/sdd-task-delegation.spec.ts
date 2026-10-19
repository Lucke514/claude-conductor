import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { JobRegistry, progressLine } from "../src/jobs.js";
import { logsDir } from "../src/paths.js";
import { lockFilePath } from "../src/reservations.js";
import { StateStore } from "../src/state.js";
import { parseAcceptance, sddTaskClaim, sddTaskDelegate, sddTaskRelease, taskReservationKey } from "../src/sdd/task-delegation.js";
import { applyWorktree, removeWorktree, readMeta } from "../src/worktree.js";
import type { ProviderAdapter, ProviderName } from "../src/providers/types.js";
import { isAlive, makeRepo, makeWorkspace, testConfig, tmpDir } from "./helpers.js";
import { PLAN, SPEC, TASKS, writeFeature } from "./sdd-fixtures.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const ENV = ["FAKE_MODE", "FAKE_MESSAGE", "FAKE_WRITE_FILE", "FAKE_ARGS_FILE", "FAKE_PROBE_FILE"];
const WORKER = "## Summary\nDone.\n\n## Acceptance\n- [met] A1 — sdd-brief.spec.ts passes\n- [not met] R1 — the brief misses the plan\n";

afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

function setup(tasks = TASKS, overrides: Record<string, unknown> = {}) {
  const repo = makeRepo();
  writeFeature(repo, "demo", { "spec.md": SPEC, "plan.md": PLAN, "tasks.md": tasks });
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "demo: artifacts");
  const ctx = {
    projectDir: repo,
    config: testConfig({ chain: ["codex", "claude"], ...overrides }),
    store: new StateStore(path.join(tmpDir(), "state.json")),
    instanceId: "test",
    sleep: async () => undefined,
  };
  const tasksFile = path.join(repo, "specs/demo/tasks.md");
  return { repo, ctx, tasksFile };
}

async function claimAndCommit(s: ReturnType<typeof setup>) {
  const claim = await sddTaskClaim({ slug: "demo", task: "next", provider: "codex" }, s.ctx);
  git(s.repo, "commit", "-qm", "demo: claim T3", "--", "specs/demo/tasks.md");
  return claim;
}

describe("sdd_task_* tools", () => {
  it("R6/SC2: claim writes the Owner; delegate refuses to start a worker until the claim is committed", async () => {
    const s = setup();
    const claim = await sddTaskClaim({ slug: "demo", task: "next", provider: "codex" }, s.ctx);
    expect(claim).toMatchObject({ taskId: "T3", provider: "codex", commit: 'git commit -m "demo: claim T3" -- specs/demo/tasks.md' });
    expect(claim.owner).toMatch(/^codex \(multi-provider\) since \d{4}-\d{2}-\d{2}$/);
    expect(readFileSync(s.tasksFile, "utf8")).toContain(`- **Owner**: ${claim.owner}`);

    process.env.FAKE_ARGS_FILE = path.join(tmpDir(), "args.json");
    await expect(sddTaskDelegate({ slug: "demo", task: "T3" }, s.ctx)).rejects.toMatchObject({ code: "CLAIM_NOT_COMMITTED" });
    expect(existsSync(process.env.FAKE_ARGS_FILE)).toBe(false);
    await expect(sddTaskClaim({ slug: "demo", task: "T3" }, s.ctx)).rejects.toMatchObject({ code: "TASK_CLAIMED" });
  });

  it("R8: write mode returns the diff, the verification, per-item verdicts and a Notes draft; tasks.md is not ticked", async () => {
    const s = setup();
    await claimAndCommit(s);
    process.env.FAKE_MODE = "message";
    process.env.FAKE_MESSAGE = WORKER;
    process.env.FAKE_WRITE_FILE = "index.ts";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, s.ctx);
    expect(r.status).toBe("success");
    expect(r.mode).toBe("write");
    expect(r.filesChanged).toEqual(["index.ts"]);
    expect(r.sdd.verification.map((v) => [v.kind, v.gate ?? "", v.result])).toEqual([
      ["verify", "", "pass"],
      ["gate", "Tests", "pass"],
      ["gate", "Dist", "manual"],
    ]);
    expect(r.sdd.verified).toBe(true);
    expect(r.sdd.drift).toEqual([]);
    expect(r.sdd.acceptance.map((a) => [a.id, a.verdict])).toEqual([["A1", "met"], ["R1", "not met"], ["E2", "unverifiable"]]);
    expect(r.sdd.notesDraft).toContain(`T3 delegated to codex (delegation ${r.id})`);
    expect(r.sdd.notesDraft).toContain("acceptance 1/3 met");
    const after = readFileSync(s.tasksFile, "utf8");
    expect(after).not.toContain("- [x] Done\n- **Owner**: codex");
    expect(after.match(/- \*\*Notes\*\*: —/g)).toHaveLength(TASKS.match(/- \*\*Notes\*\*: —/g)!.length);
    expect(r.nextSteps[1]).toContain("delegation_apply");

    const state = await s.ctx.store.read();
    expect(state.recent?.[0]?.sdd).toEqual({ slug: "demo", taskId: "T3" });
    const log = readdirSync(logsDir()).map((f) => readFileSync(path.join(logsDir(), f), "utf8")).join("");
    const lines = log.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const lastLine = lines[lines.length - 1];
    expect(lastLine?.id).toBe(r.id);
    expect(lastLine?.sdd).toEqual({ slug: "demo", taskId: "T3" });
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("R5: sdd_task_delegate records sdd: { slug, taskId } in the audit log and state.recent[0]", async () => {
    const s = setup();
    await claimAndCommit(s);
    process.env.FAKE_MODE = "message";
    process.env.FAKE_MESSAGE = WORKER;
    process.env.FAKE_WRITE_FILE = "index.ts";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, s.ctx);
    const state = await s.ctx.store.read();
    expect(state.recent?.[0]?.sdd).toEqual({ slug: "demo", taskId: "T3" });

    const log = readdirSync(logsDir()).map((f) => readFileSync(path.join(logsDir(), f), "utf8")).join("");
    const lines = log.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const lastLine = lines[lines.length - 1];
    expect(lastLine?.id).toBe(r.id);
    expect(lastLine?.sdd).toEqual({ slug: "demo", taskId: "T3" });
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("sdd-guardrails R7/E3: files outside the task's Files are drift and leave it unverified", async () => {
    const s = setup();
    await claimAndCommit(s);
    process.env.FAKE_MODE = "probe";
    process.env.FAKE_MESSAGE = WORKER;
    process.env.FAKE_WRITE_FILE = "index.ts,otro.ts,src/nuevo.ts";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, s.ctx);
    expect(r.filesChanged).toEqual(["index.ts", "otro.ts", "src/nuevo.ts"]);
    expect(r.sdd.drift).toEqual(["otro.ts"]);
    expect(r.sdd.verified).toBe(false);
    expect(r.violations).toContainEqual(expect.objectContaining({ type: "outside_task_files", files: ["otro.ts"] }));
    expect(r.nextSteps[0]).toContain("SPEC DRIFT");
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("E9: a failing Verify keeps the worktree and the claim", async () => {
    const s = setup(TASKS.replace('- **Verify**: `node -e "process.exit(0)"`', '- **Verify**: `node -e "process.exit(4)"`'));
    const claim = await claimAndCommit(s);
    process.env.FAKE_MODE = "message";
    process.env.FAKE_MESSAGE = WORKER;
    process.env.FAKE_WRITE_FILE = "index.ts";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, s.ctx);
    expect(r.sdd.verified).toBe(false);
    expect(r.sdd.verification[0]).toMatchObject({ kind: "verify", result: "fail", exitCode: 4 });
    expect(existsSync(r.worktreePath!)).toBe(true);
    expect(readFileSync(s.tasksFile, "utf8")).toContain(`- **Owner**: ${claim.owner}`);
    expect(r.nextSteps[0]).toContain("NOT VERIFIED");
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("R4: SDD Verify runs in the job and cancellation skips gates, retaining the claim", async () => {
    const pidFile = path.join(tmpDir(), "sdd-verify-pid");
    const fixture = fileURLToPath(new URL("./fixtures/sleep.mjs", import.meta.url));
    const command = `node "${fixture}" 30 "${pidFile}"`;
    const s = setup(TASKS.replace('node -e "process.exit(0)"', command));
    const claim = await claimAndCommit(s);
    process.env.FAKE_MODE = "message";
    process.env.FAKE_MESSAGE = WORKER;
    process.env.FAKE_WRITE_FILE = "index.ts";
    const jobs = new JobRegistry(s.ctx.store);
    const pending = sddTaskDelegate({ slug: "demo", task: "T3" }, { ...s.ctx, jobs });
    for (let i = 0; i < 120 && !existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 50));
    const [job] = await jobs.status();
    expect(job).toMatchObject({ phase: "verifying", detail: progressLine(command) });
    expect(existsSync(pidFile)).toBe(true);
    jobs.cancel(job!.id);
    const r = await pending;
    expect(r.verification?.result).toBe("cancelled");
    expect(r.sdd.verification).toEqual([expect.objectContaining({ kind: "verify", result: "cancelled" })]);
    expect(r.sdd.verified).toBe(false);
    expect(r.sdd.handback).toBeUndefined();
    expect(readFileSync(s.tasksFile, "utf8")).toContain(claim.owner);
    expect(isAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    expect((await readMeta(r.worktreePath!)).state).toBe("awaiting_review");
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("R9: when every provider fails the Owner goes back to — (handback)", async () => {
    const s = setup();
    await claimAndCommit(s);
    process.env.FAKE_MODE = "crash";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, s.ctx);
    expect(r.status).toBe("fallback_to_claude");
    expect(r.sdd.handback).toEqual({ owner: "—", commit: 'git commit -m "demo: release T3" -- specs/demo/tasks.md' });
    expect(readFileSync(s.tasksFile, "utf8")).toBe(TASKS);
  });

  it("provider-reliability R6: a cancelled task keeps its Owner and names sdd_task_release", async () => {
    const s = setup();
    const claim = await claimAndCommit(s);
    process.env.FAKE_MODE = "hang-write";
    const ac = new AbortController();
    const run = sddTaskDelegate({ slug: "demo", task: "T3" }, { ...s.ctx, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 700));
    ac.abort();
    const r = await run;
    expect(r.status).toBe("cancelled");
    expect(r.sdd.handback).toBeUndefined();
    expect(r.sdd.verification).toEqual([]);
    expect(readFileSync(s.tasksFile, "utf8")).toContain(`- **Owner**: ${claim.owner}`);
    expect(r.nextSteps.join("\n")).toContain("sdd_task_release");
    if (r.worktreePath) await removeWorktree(await readMeta(r.worktreePath));
  });

  it("R9: sdd_task_release frees a claimed task; delegate rejects next and foreign owners", async () => {
    const s = setup();
    await claimAndCommit(s);
    expect(await sddTaskRelease({ slug: "demo", task: "T3" }, s.ctx)).toMatchObject({ released: true, commit: 'git commit -m "demo: release T3" -- specs/demo/tasks.md' });
    expect(readFileSync(s.tasksFile, "utf8")).toBe(TASKS);
    expect(await sddTaskRelease({ slug: "demo", task: "T3" }, s.ctx)).toMatchObject({ released: false });
    await expect(sddTaskDelegate({ slug: "demo", task: "next" }, s.ctx)).rejects.toThrow(/not 'next'/);
    await expect(sddTaskDelegate({ slug: "demo", task: "T3" }, s.ctx)).rejects.toThrow(/owned by '—'/);
  });

  it("nested-repos R9/SC6: the task claimed for codex but answered by antigravity says so", async () => {
    const s = setup(TASKS, { chain: ["codex", "antigravity", "claude"] });
    await claimAndCommit(s);
    const make = (name: ProviderName, ok: boolean): ProviderAdapter => ({
      name,
      isAvailable: async () => true,
      healthCheck: async () => ({}) as never,
      run: async () =>
        ok
          ? { ok: true, output: WORKER, exitCode: 0, durationMs: 1 }
          : { ok: false, output: "", exitCode: 1, durationMs: 1, error: { type: "AUTH", message: "401 Unauthorized" } },
    });
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, { ...s.ctx, adapters: { codex: make("codex", false), antigravity: make("antigravity", true) } });
    expect(r).toMatchObject({ requestedProvider: "codex", provider: "antigravity" });
    expect(r.notes).toContain("requested codex, answered by antigravity (fallback after codex: AUTH)");
  });

  it("auto claims for the routed provider, else the first of the chain", async () => {
    const s = setup(TASKS, { chain: ["antigravity", "codex", "claude"], routing: {} });
    expect((await sddTaskClaim({ slug: "demo", task: "T3" }, s.ctx)).provider).toBe("antigravity");
  });

  it("parses verdict lines loosely and ignores unknown ids", () => {
    const v = parseAcceptance("* [MET] a1: ok\n- [unverifiable] E2 — no test\n- [met] Z9 — x", [
      { id: "A1", text: "uno" },
      { id: "E2", text: "dos" },
      { id: "R1", text: "tres" },
    ]);
    expect(v.map((x) => [x.id, x.verdict, x.evidence])).toEqual([
      ["A1", "met", "ok"],
      ["E2", "unverifiable", "no test"],
      ["R1", "unverifiable", "no line for this item in the worker's ## Acceptance section"],
    ]);
  });

  it("SC4/R7/R8: two simultaneous sdd_task_delegate calls: one runs, other fails with TASK_IN_FLIGHT, adapter called once, rejection audited", async () => {
    const s = setup();
    await claimAndCommit(s);
    let adapterCalls = 0;
    const slowAdapter: ProviderAdapter = {
      name: "codex",
      isAvailable: async () => true,
      healthCheck: async () => ({}) as never,
      run: async () => {
        adapterCalls++;
        await new Promise((r) => setTimeout(r, 150));
        return { ok: true, output: WORKER, exitCode: 0, durationMs: 150 };
      },
    };
    const ctx = {
      ...s.ctx,
      adapters: {
        codex: slowAdapter,
        antigravity: {
          name: "antigravity" as const,
          isAvailable: async () => false,
          healthCheck: async () => ({}) as never,
          run: async () => ({ ok: false, output: "", exitCode: 1, durationMs: 0 }),
        },
      },
    };

    const p1 = sddTaskDelegate({ slug: "demo", task: "T3" }, ctx);
    // Yield to let p1 acquire the lock and start delegate
    await new Promise((r) => setTimeout(r, 20));
    const p2 = sddTaskDelegate({ slug: "demo", task: "T3" }, ctx);

    const err = await p2.catch((e) => e);
    expect(err).toMatchObject({ code: "TASK_IN_FLIGHT" });
    expect(err.message).toContain("T3 of demo is already being delegated");

    const r1 = await p1;
    expect(r1.status).toBe("success");
    expect(adapterCalls).toBe(1);

    // Audit log records TASK_IN_FLIGHT
    const log = readdirSync(logsDir()).map((f) => readFileSync(path.join(logsDir(), f), "utf8")).join("");
    const lines = log.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rejectedEntry = lines.find((l) => l.type === "TASK_IN_FLIGHT");
    expect(rejectedEntry).toBeDefined();
    expect(rejectedEntry?.sdd).toEqual({ slug: "demo", taskId: "T3" });
    expect(rejectedEntry?.heldBy).toBeDefined();

    // Lock file is removed after completion
    const lock = lockFilePath(await taskReservationKey(s.repo, "demo", "T3"));
    expect(existsSync(lock)).toBe(false);
  });

  it("R7: lock file is released on completion, error, or cancellation", async () => {
    const s1 = setup();
    await claimAndCommit(s1);
    const lock1 = lockFilePath(await taskReservationKey(s1.repo, "demo", "T3"));

    // On crash (error)
    process.env.FAKE_MODE = "crash";
    await sddTaskDelegate({ slug: "demo", task: "T3" }, s1.ctx);
    expect(existsSync(lock1)).toBe(false);

    // On cancellation
    const s2 = setup();
    await claimAndCommit(s2);
    const lock2 = lockFilePath(await taskReservationKey(s2.repo, "demo", "T3"));

    process.env.FAKE_MODE = "hang-write";
    const ac = new AbortController();
    const run = sddTaskDelegate({ slug: "demo", task: "T3" }, { ...s2.ctx, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 700));
    ac.abort();
    const r = await run;
    expect(r.status).toBe("cancelled");
    expect(existsSync(lock2)).toBe(false);
    if (r.worktreePath) await removeWorktree(await readMeta(r.worktreePath));
  });

  it("R7/E6: orphan lock with dead PID is replaced with a note in notes", async () => {
    const s = setup();
    await claimAndCommit(s);
    const key = await taskReservationKey(s.repo, "demo", "T3");
    const lock = lockFilePath(key);
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(
      lock,
      JSON.stringify({ key, id: "stale-dead-pid", pid: 99999999, startedAt: new Date().toISOString() }),
    );

    process.env.FAKE_MODE = "message";
    process.env.FAKE_MESSAGE = WORKER;
    process.env.FAKE_WRITE_FILE = "index.ts";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, s.ctx);
    expect(r.status).toBe("success");
    expect(r.notes?.some((n) => /orphan|huérfano/i.test(n) && n.includes("stale-dead-pid"))).toBe(true);
    expect(existsSync(lock)).toBe(false);
    if (r.worktreePath) await removeWorktree(await readMeta(r.worktreePath));
  });

  it("E6: orphan lock with living PID but older than writeTimeoutMs + verify.timeoutMs is replaced with a note", async () => {
    const s = setup();
    await claimAndCommit(s);
    const key = await taskReservationKey(s.repo, "demo", "T3");
    const lock = lockFilePath(key);
    mkdirSync(path.dirname(lock), { recursive: true });
    // Started 3 hours ago (> default writeTimeoutMs 30m + verify.timeoutMs 5m = 35m)
    const oldTime = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    writeFileSync(
      lock,
      JSON.stringify({ key, id: "stale-alive-pid", pid: process.pid, startedAt: oldTime }),
    );

    process.env.FAKE_MODE = "message";
    process.env.FAKE_MESSAGE = WORKER;
    process.env.FAKE_WRITE_FILE = "index.ts";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, s.ctx);
    expect(r.status).toBe("success");
    expect(r.notes?.some((n) => /orphan|huérfano/i.test(n) && n.includes("stale-alive-pid"))).toBe(true);
    expect(existsSync(lock)).toBe(false);
    if (r.worktreePath) await removeWorktree(await readMeta(r.worktreePath));
  });
});

describe("nested-repos: **Repo** in sdd_task_*", () => {
  const REPO_TASKS = TASKS.replace("- **Component**: C2 · **Implements**: R1, E2\n", "- **Component**: C2 · **Implements**: R1, E2\n- **Repo**: backend-monolith\n");

  /** A workspace whose specs/ live in the root and whose code lives in backend-monolith/ (optionally a spec worktree of it). */
  function workspace(opts: { specWorktree?: boolean; plan?: string } = {}) {
    const { root, nested } = makeWorkspace();
    writeFeature(root, "demo", { "spec.md": SPEC, "plan.md": opts.plan ?? PLAN, "tasks.md": REPO_TASKS });
    git(root, "add", "-A");
    git(root, "commit", "-qm", "demo: artifacts");
    let specWt: string | undefined;
    if (opts.specWorktree) {
      specWt = path.join(root, ".claude", "worktrees", "demo", "backend-monolith");
      mkdirSync(path.dirname(specWt), { recursive: true });
      git(nested, "worktree", "add", "-q", "-b", "feat/demo", specWt);
      execFileSync(process.execPath, ["-e", `require("fs").writeFileSync("spec-branch.txt", "on feat/demo\\n")`], { cwd: specWt });
      git(specWt, "add", "-A");
      git(specWt, "commit", "-qm", "work on the spec branch");
    }
    const ctx = {
      projectDir: root,
      config: testConfig({ chain: ["codex", "claude"] }),
      store: new StateStore(path.join(tmpDir(), "state.json")),
      instanceId: "test",
      sleep: async () => undefined,
    };
    return { root, nested, specWt, ctx };
  }

  async function claim(w: ReturnType<typeof workspace>) {
    const c = await sddTaskClaim({ slug: "demo", task: "T3", provider: "codex" }, w.ctx);
    git(w.root, "commit", "-qm", "demo: claim T3", "--", "specs/demo/tasks.md");
    return c;
  }

  it("SC2: works on the spec's worktree: mp/* from its branch, Verify there, apply lands there only", async () => {
    const w = workspace({ specWorktree: true });
    const c = await claim(w);
    expect(c.repo).toBe(".claude/worktrees/demo/backend-monolith");
    process.env.FAKE_MODE = "message";
    process.env.FAKE_MESSAGE = WORKER;
    process.env.FAKE_WRITE_FILE = "index.ts";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, w.ctx);
    expect(r.status).toBe("success");
    expect(r.repo).toBe(".claude/worktrees/demo/backend-monolith");
    const meta = await readMeta(r.worktreePath!);
    expect(realpathSync.native(meta.repoRoot)).toBe(realpathSync.native(w.specWt!));
    expect(meta.baseCommit).toBe(git(w.specWt!, "rev-parse", "HEAD"));
    expect(existsSync(path.join(r.worktreePath!, "spec-branch.txt"))).toBe(true);
    expect(r.sdd.verification.find((v) => v.kind === "verify")).toMatchObject({ result: "pass" });
    expect(r.sdd.drift).toEqual([]);
    expect(r.sdd.verified).toBe(true);

    const applied = await applyWorktree(r.worktreePath!, "sc2");
    expect(applied.applied).toBe(true);
    expect(readFileSync(path.join(w.specWt!, "index.ts"), "utf8")).toBe("from worker\n");
    expect(git(w.nested, "status", "--porcelain")).toBe("");
    expect(git(w.root, "status", "--porcelain")).toBe("");
  });

  it("R4: without a spec worktree it uses the repo at the root; the claim is still checked in the root's HEAD", async () => {
    const w = workspace();
    const c = await sddTaskClaim({ slug: "demo", task: "T3", provider: "codex" }, w.ctx);
    expect(c.repo).toBe("backend-monolith");
    await expect(sddTaskDelegate({ slug: "demo", task: "T3" }, w.ctx)).rejects.toMatchObject({ code: "CLAIM_NOT_COMMITTED" });
    git(w.root, "commit", "-qm", "demo: claim T3", "--", "specs/demo/tasks.md");
    process.env.FAKE_MODE = "message";
    process.env.FAKE_MESSAGE = WORKER;
    process.env.FAKE_WRITE_FILE = "backend-monolith-only.txt";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, w.ctx);
    expect(realpathSync.native((await readMeta(r.worktreePath!)).repoRoot)).toBe(realpathSync.native(w.nested));
    // Outside the task's Files, relative to the repo: drift is computed there, not against the root.
    expect(r.sdd.drift).toEqual(["backend-monolith-only.txt"]);
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("R4: an unknown **Repo** fails with REPO_NOT_FOUND before writing the Owner", async () => {
    const w = workspace();
    const tasksFile = path.join(w.root, "specs/demo/tasks.md");
    const text = REPO_TASKS.replace("- **Repo**: backend-monolith", "- **Repo**: web-app");
    execFileSync(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(tasksFile)}, ${JSON.stringify(text)})`]);
    const err = await sddTaskClaim({ slug: "demo", task: "T3", provider: "codex" }, w.ctx).catch((e) => e);
    expect(err).toMatchObject({ code: "REPO_NOT_FOUND" });
    expect(err.message).toContain(".claude/worktrees/demo/web-app, web-app");
    expect(readFileSync(tasksFile, "utf8")).toBe(text);
  });

  it("E3: a spec worktree that is not a git repo falls back to the root repo, with a note", async () => {
    const w = workspace();
    mkdirSync(path.join(w.root, ".claude", "worktrees", "demo", "backend-monolith"), { recursive: true });
    const c = await claim(w);
    expect(c.repo).toBe("backend-monolith");
    process.env.FAKE_MODE = "message";
    process.env.FAKE_MESSAGE = WORKER;
    process.env.FAKE_WRITE_FILE = "index.ts";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, w.ctx);
    expect(r.notes?.some((n) => n.startsWith(".claude/worktrees/demo/backend-monolith was skipped"))).toBe(true);
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("G2: on the spec worktree, symlinkByRepo is keyed by the task's **Repo** name", async () => {
    const w = workspace({ specWorktree: true });
    mkdirSync(path.join(w.specWt!, "node_modules", "dep"), { recursive: true });
    w.ctx.config = testConfig({ chain: ["codex", "claude"], isolation: { symlinkByRepo: { "backend-monolith": ["node_modules"] } } });
    await claim(w);
    process.env.FAKE_MODE = "message";
    process.env.FAKE_MESSAGE = WORKER;
    process.env.FAKE_WRITE_FILE = "index.ts";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, w.ctx);
    expect((await readMeta(r.worktreePath!)).symlinks).toEqual(["node_modules"]);
    expect(existsSync(path.join(r.worktreePath!, "node_modules", "dep"))).toBe(true);
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("G3: a task without **Repo** still runs a gate whose Where names a nested repo", async () => {
    const s = setup(TASKS, {});
    const plan = PLAN.replace("| Tests | `node -e \"process.exit(0)\"` | `here` |", "| Tests | `node -e \"process.exit(0)\"` | `backend` |");
    writeFeature(s.repo, "demo", { "spec.md": SPEC, "plan.md": plan, "tasks.md": TASKS });
    mkdirSync(path.join(s.repo, "backend"));
    makeRepo(path.join(s.repo, "backend"));
    git(s.repo, "add", "specs");
    git(s.repo, "commit", "-qm", "plan with a backend gate");
    await claimAndCommit(s);
    process.env.FAKE_MODE = "message";
    process.env.FAKE_MESSAGE = WORKER;
    process.env.FAKE_WRITE_FILE = "index.ts";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, s.ctx);
    expect(r.sdd.verification.find((v) => v.gate === "Tests")).toMatchObject({ result: "pass" });
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("R5: a gate whose Where names another repo of the workspace stays manual", async () => {
    const plan = PLAN.replace("| Tests | `node -e \"process.exit(0)\"` | `here` |", "| Tests | `node -e \"process.exit(0)\"` | `here` |\n| Web | `node -e \"process.exit(0)\"` | `web-app` | `exit 0` |");
    const w = workspace({ plan });
    mkdirSync(path.join(w.root, "web-app"));
    makeRepo(path.join(w.root, "web-app"));
    await claim(w);
    process.env.FAKE_MODE = "message";
    process.env.FAKE_MESSAGE = WORKER;
    process.env.FAKE_WRITE_FILE = "index.ts";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, w.ctx);
    expect(r.sdd.verification.find((v) => v.gate === "Web")).toMatchObject({ result: "manual", reason: expect.stringMatching(/^runs in web-app/) });
    expect(r.sdd.verification.find((v) => v.gate === "Tests")).toMatchObject({ result: "pass" });
    await removeWorktree(await readMeta(r.worktreePath!));
  });
});
