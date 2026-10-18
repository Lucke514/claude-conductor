import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";
import { parseAcceptance, sddTaskClaim, sddTaskDelegate, sddTaskRelease } from "../src/sdd/task-delegation.js";
import { removeWorktree, readMeta } from "../src/worktree.js";
import { makeRepo, testConfig, tmpDir } from "./helpers.js";
import { PLAN, SPEC, TASKS, writeFeature } from "./sdd-fixtures.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const ENV = ["FAKE_MODE", "FAKE_MESSAGE", "FAKE_WRITE_FILE", "FAKE_ARGS_FILE"];
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
    expect(r.sdd.acceptance.map((a) => [a.id, a.verdict])).toEqual([["A1", "met"], ["R1", "not met"], ["E2", "unverifiable"]]);
    expect(r.sdd.notesDraft).toContain(`T3 delegated to codex (delegation ${r.id})`);
    expect(r.sdd.notesDraft).toContain("acceptance 1/3 met");
    const after = readFileSync(s.tasksFile, "utf8");
    expect(after).not.toContain("- [x] Done\n- **Owner**: codex");
    expect(after.match(/- \*\*Notes\*\*: —/g)).toHaveLength(TASKS.match(/- \*\*Notes\*\*: —/g)!.length);
    expect(r.nextSteps[1]).toContain("delegation_apply");
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

  it("R9: when every provider fails the Owner goes back to — (handback)", async () => {
    const s = setup();
    await claimAndCommit(s);
    process.env.FAKE_MODE = "crash";
    const r = await sddTaskDelegate({ slug: "demo", task: "T3" }, s.ctx);
    expect(r.status).toBe("fallback_to_claude");
    expect(r.sdd.handback).toEqual({ owner: "—", commit: 'git commit -m "demo: release T3" -- specs/demo/tasks.md' });
    expect(readFileSync(s.tasksFile, "utf8")).toBe(TASKS);
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
});
