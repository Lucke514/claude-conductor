import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { delegate } from "../src/delegate.js";
import { JobRegistry, MAX_PROGRESS_CHARS, progressLine } from "../src/jobs.js";
import { StateStore } from "../src/state.js";
import { readMeta, removeWorktree } from "../src/worktree.js";
import { isAlive, makeRepo, testConfig, tmpDir } from "./helpers.js";

afterEach(() => {
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_PID_FILE;
});

async function until<T>(probe: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 120; i++) {
    const v = await probe();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function setup() {
  const repo = makeRepo();
  const store = new StateStore(path.join(tmpDir(), "state.json"));
  const jobs = new JobRegistry(store);
  const ctx = { projectDir: repo, config: testConfig(), store, instanceId: "t", sleep: async () => undefined, jobs };
  return { repo, store, jobs, ctx };
}

describe("delegation jobs", () => {
  it("R8/E4: a running delegation is listed with progress and files, mirrored in state.json, and cancelled once", async () => {
    const { store, jobs, ctx } = setup();
    const pidFile = path.join(tmpDir(), "pid");
    process.env.FAKE_MODE = "hang-write";
    process.env.FAKE_PID_FILE = pidFile;
    const run = delegate({ provider: "codex", task: "long refactor of the payments module", mode: "write" }, ctx);
    await until(() => (existsSync(pidFile) ? true : undefined), "the fake worker");
    const [job] = await until(async () => {
      const s = await jobs.status();
      return s[0]?.progress.length && s[0].files?.length ? s : undefined;
    }, "progress and files");
    expect(job).toMatchObject({ provider: "codex", mode: "write", phase: "running", files: ["added-by-worker.txt"], filesChanged: 1 });
    // Event labels only: the worker's message text never reaches progress (E6).
    expect(job!.progress.join("\n")).toContain("item.completed reasoning");
    expect(job!.progress.join("\n")).not.toContain("working");
    const mirrored = (await store.read()).jobs ?? [];
    expect(mirrored).toEqual([expect.objectContaining({ id: job!.id, provider: "codex", task: "long refactor of the payments module", pid: process.pid })]);

    expect(jobs.cancel(job!.id)).toEqual({ cancelled: true, id: job!.id });
    expect(jobs.cancel(job!.id)).toEqual({ cancelled: false, id: job!.id, reason: "already cancelled" });
    const r = await run;
    expect(r.status).toBe("cancelled");
    expect(r.id).toBe(job!.id);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await until(() => (isAlive(pid) ? undefined : true), "the worker to die");
    expect(await jobs.status()).toEqual([]);
    expect((await store.read()).jobs ?? []).toEqual([]);
    await removeWorktree(await readMeta(r.worktreePath!));
  });

  it("E5: a job left by a server that is gone is marked lost", async () => {
    const store = new StateStore(path.join(tmpDir(), "state.json"));
    await store.update((s) => {
      s.jobs = [{ id: "old-1", provider: "agy", mode: "write", task: "x", phase: "running", startedAt: new Date().toISOString(), pid: 999_999_999 }];
    });
    const lost = await new JobRegistry(store).reconcile();
    expect(lost.map((j) => [j.id, j.phase])).toEqual([["old-1", "lost"]]);
    expect((await store.read()).jobs?.[0]?.phase).toBe("lost");
  });

  it("E6: progress lines are trimmed to 200 characters and only the worker's output is kept", async () => {
    const jobs = new JobRegistry();
    jobs.start({ id: "j", provider: "codex", mode: "read", task: "t" });
    jobs.progress("j", `${"a".repeat(1000)}\nsecond`);
    jobs.progress("j", " line\n");
    const [s] = await jobs.status("j");
    expect(s!.progress).toEqual([`${"a".repeat(MAX_PROGRESS_CHARS - 1)}…`, "second line"]);
    expect(progressLine("   ")).toBeUndefined();
    for (let i = 0; i < 30; i++) jobs.progress("j", `l${i}\n`);
    expect((await jobs.status("j"))[0]!.progress).toHaveLength(20);
    expect(jobs.cancel("nope")).toMatchObject({ cancelled: false });
  });

  it("the prompt never reaches progress", async () => {
    const { jobs, ctx } = setup();
    process.env.FAKE_MODE = "success";
    const seen: string[] = [];
    const orig = jobs.progress.bind(jobs);
    jobs.progress = (id: string, chunk: string) => {
      seen.push(chunk);
      orig(id, chunk);
    };
    await delegate({ provider: "codex", task: "SECRET-PROMPT-MARKER review index.ts" }, ctx);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join("")).not.toContain("SECRET-PROMPT-MARKER");
  });
});
