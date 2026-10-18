import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { featureStatus, listFeatureStatus, sddFeatureStatus } from "../src/sdd/pipeline.js";
import { StateStore, registerRepo } from "../src/state.js";
import { createWorktree } from "../src/worktree.js";
import { makeWorkspace, tmpDir } from "./helpers.js";
import { DELEGATION_REPORT, PLAN, SPEC, TASKS, writeFeature } from "./sdd-fixtures.js";

const closed = TASKS.replace(/\[[ !]\]/g, "[x]");
const reportBody = DELEGATION_REPORT.replace("## Verification reports", "");
const report = reportBody.replace("Converged: no", "Converged: yes");
function demo(root: string, spec = SPEC, tasks = TASKS, plan = PLAN) {
  writeFeature(root, "demo", { "spec.md": spec, "plan.md": plan, "tasks.md": tasks });
}
afterEach(() => vi.unstubAllEnvs());

describe("sdd pipeline", () => {
  it("R1/R8/E10/E11: counts every box, preserves owners, is deterministic and read-only without leaking task bodies", async () => {
    const root = tmpDir();
    const tasks = TASKS.replace("[x]", "[~]").replace("[!]", "[>]") + reportBody.replace("| R1 | met |", "| A1 | met | excluded acceptance row |\n| R1 | met |");
    demo(root, SPEC, tasks);
    const before = ["spec", "plan", "tasks"].map((n) => readFileSync(path.join(root, "specs/demo", `${n}.md`), "utf8"));
    const result = await featureStatus(root, "demo", []);
    expect(result).toMatchObject({ depth: "standard", statuses: { spec: "approved", plan: "approved", tasks: "approved" }, tasks: { open: 3, done: 0, blocked: 0, waived: 1, deferred: 1, total: 5 }, verification: { pass: 1, converged: false, verdicts: { met: 19, "partially met": 1 } } });
    expect(result.tasks.openList).toEqual([{ id: "T3", owner: null }, { id: "T4", owner: "codex (multi-provider) since 2026-10-18" }, { id: "G1", owner: null }]);
    expect(await featureStatus(root, "demo", [])).toEqual(result);
    expect(["spec", "plan", "tasks"].map((n) => readFileSync(path.join(root, "specs/demo", `${n}.md`), "utf8"))).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/index\.ts|añadir|process\.exit|Evidence/);
  });

  it.each([
    ["implemented", "draft", TASKS, "Cerrada", "cerrada"],
    ["superseded", "draft", TASKS, "Descartada", "descartada"],
    ["abandoned", "draft", TASKS, "Descartada", "descartada"],
    ["draft", "approved", TASKS, "Spec", "aprobar spec.md"],
    ["approved", "draft", TASKS, "Plan", "aprobar plan.md"],
    ["approved", "approved", TASKS.replace("Status: approved", "Status: draft"), "Tasks", "aprobar tasks.md"],
    ["approved", "approved", TASKS, "Implementación", "/sdd-delegate demo next"],
    ["approved", "approved", closed, "Verificación", "registrar un reporte"],
    ["approved", "approved", closed + reportBody, "Verificación", "converger (awaiting the user's decision on R10/SC1"],
    ["approved", "approved", closed + report, "Verificación", "implemented"],
  ])("R2/R3: stage precedence case %# (%s / %s)", async (specStatus, planStatus, tasks, stage, step) => {
    const root = tmpDir();
    demo(root, SPEC.replace("approved", specStatus), tasks, PLAN.replace("approved", planStatus));
    const result = await featureStatus(root, "demo", []);
    expect(result.stage).toBe(stage);
    expect(result.nextStep).toContain(step);
  });

  it("R2/E8: missing Standard artifacts and blocked tasks; verification substages use the last report", async () => {
    const root = tmpDir();
    writeFeature(root, "demo", { "spec.md": SPEC });
    expect((await featureStatus(root, "demo", [])).stage).toBe("Plan");
    writeFeature(root, "demo", { "plan.md": PLAN });
    expect((await featureStatus(root, "demo", [])).stage).toBe("Tasks");
    demo(root, SPEC, TASKS.replace(/\[ \]/g, "[x]"));
    expect(await featureStatus(root, "demo", [])).toMatchObject({ stage: "Implementación", tasks: { blocked: 1 }, nextStep: "Resolver las tareas bloqueadas." });
    for (const [suffix, substage] of [["", "sin reporte"], [reportBody, "pass 1 no convergido"], [reportBody + report.replace("pass 1", "pass 2").replace("## Verification reports", ""), "convergido"]]) {
      demo(root, SPEC, closed + suffix);
      expect((await featureStatus(root, "demo", [])).substage).toBe(substage);
    }
    demo(root, SPEC, closed.replace("## Verification reports", ""));
    expect((await featureStatus(root, "demo", [])).substage).toBe("sin reporte");
  });

  it("R4/E7: claims, closure, scope and violations ignore obsolete and untagged delegations", async () => {
    const root = tmpDir();
    demo(root);
    writeFeature(root, "scope-only", { "scope.md": "| Slug | Rank | Status |\n|---|---|---|\n| demo | 1 | done |" });
    const recent = [{ sdd: { slug: "demo", taskId: "T4" }, violations: [{ type: "specs_modified", detail: "PRIVATE DIFF" }, { type: "worker_push", detail: "private" }, { type: "spec_drift", detail: "private" }] }, { sdd: { slug: "demo", taskId: "T99" }, violations: [{ type: "obsolete", detail: "" }] }, { violations: [{ type: "untagged", detail: "" }] }];
    const result = await featureStatus(root, "demo", recent);
    expect(result.warnings.map((w) => w.code)).toEqual(["violations", "violations", "violations", "scope_mismatch"]);
    expect(result.warnings.filter((w) => w.code === "violations").every((w) => w.taskId === "T4")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|obsolete|untagged/);
    expect((await featureStatus(root, "demo", [])).warnings).toContainEqual({ code: "orphan_claim", taskId: "T4", detail: "T4: codex (multi-provider) since 2026-10-18" });
    demo(root, SPEC.replace("approved", "implemented"));
    expect((await featureStatus(root, "demo", [])).warnings.map((w) => w.code)).toContain("closed_with_open_tasks");
    demo(root, SPEC, closed + report);
    expect((await featureStatus(root, "demo", [])).warnings.map((w) => w.code)).toContain("ready_to_close");
  });

  it("E1/E2/E4: unknown slug lists draft features; malformed/unreadable artifacts do not stop other features", async () => {
    const root = tmpDir();
    demo(root);
    writeFeature(root, "draft", { "spec.md": SPEC.replace("approved", "draft") });
    writeFeature(root, "bad", { "spec.md": "# Sin estado" });
    writeFeature(root, "unreadable", { "spec.md": SPEC });
    mkdirSync(path.join(root, "specs/unreadable/plan.md"));
    writeFeature(root, "scope-only", { "scope.md": "# Scope" });
    const rows = await listFeatureStatus(root, []);
    expect(rows.map((r) => r.slug)).toEqual(["bad", "demo", "draft", "unreadable"]);
    expect(rows[0]).toMatchObject({ stage: "Desconocida", warnings: [{ code: "malformed", detail: expect.stringContaining("spec.md") }] });
    expect(rows[1]!.stage).toBe("Implementación");
    expect(rows[3]).toMatchObject({ stage: "Desconocida", warnings: [{ code: "malformed", detail: expect.stringContaining("plan.md") }] });
    await expect(featureStatus(root, "missing", [])).rejects.toThrow("Available features: bad, demo, draft, unreadable");
    await expect(featureStatus(root, "../escape", [])).rejects.toMatchObject({ code: "INVALID_SLUG" });
  });

  it("E5: Small skips Plan/Tasks and uses spec Status and nested task anchors", async () => {
    const root = tmpDir();
    writeFeature(root, "small", { "spec.md": SPEC + "\n## Tasks\n### T1 — Única\n- [ ] Done\n- **Owner**: agy — revisión con ñ\n" });
    expect(await featureStatus(root, "small", [])).toMatchObject({ depth: "small", stage: "Implementación", statuses: { spec: "approved", tasks: "approved" }, tasks: { openList: [{ id: "T1", owner: "agy — revisión con ñ" }] } });
  });

  it("E6: absent/corrupt state suppresses orphan checks; valid recent state supplies claims", async () => {
    const root = tmpDir();
    vi.stubEnv("MP_HOME", root);
    demo(root);
    for (const content of [undefined, "{", '{"version":1,"recent":{}}']) {
      if (content) writeFileSync(path.join(root, "state.json"), content);
      const result = await featureStatus(root, "demo");
      expect(result.notes).toEqual(["delegation state unavailable"]);
      expect(result.warnings).toEqual([]);
    }
    writeFileSync(path.join(root, "state.json"), JSON.stringify({ version: 1, recent: [{ sdd: { slug: "demo", taskId: "T4" } }] }));
    expect(await featureStatus(root, "demo")).toMatchObject({ notes: [], warnings: [] });
  });

  it("lists by scope rank then name, excludes scope-only directories, and handles 50 features", async () => {
    const root = tmpDir();
    expect(await listFeatureStatus(root, [])).toEqual([]);
    for (let i = 0; i < 50; i++) writeFeature(root, `f${String(i).padStart(2, "0")}`, { "spec.md": SPEC });
    writeFeature(root, "scope-only", { "scope.md": "| Slug | Rank | Status |\n|---|---|---|\n| f49 | 1 | in-progress |\n| f48 | 1 | in-progress |" });
    const start = performance.now();
    const rows = await listFeatureStatus(root, []);
    expect(rows).toHaveLength(50);
    expect(rows.slice(0, 3).map((r) => r.slug)).toEqual(["f48", "f49", "f00"]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("G1: a live worktree for the task means it is in progress, not orphaned", async () => {
    const root = tmpDir();
    demo(root);
    expect((await featureStatus(root, "demo", [], [{ slug: "demo", taskId: "T4" }])).warnings.map((w) => w.code)).not.toContain("orphan_claim");
    expect((await featureStatus(root, "demo", [], [{ slug: "other", taskId: "T4" }])).warnings.map((w) => w.code)).toContain("orphan_claim");
  });

  it("R6/E3: the tool lists a summary per feature; without specs/ it says so", async () => {
    const root = tmpDir();
    vi.stubEnv("MP_HOME", root);
    writeFileSync(path.join(root, "state.json"), JSON.stringify({ version: 1, recent: [] }));
    expect(await sddFeatureStatus({}, { projectDir: root })).toEqual({ features: [], notes: ["no SDD features"] });
    const nine = TASKS + ["T5", "T6", "T7", "T8"].map((id) => `\n## ${id} — Extra\n\n- [x] Done\n- **Owner**: —\n`).join("");
    writeFeature(root, "a", { "spec.md": SPEC, "plan.md": PLAN, "tasks.md": nine });
    writeFeature(root, "b", { "spec.md": SPEC.replace("approved", "implemented"), "plan.md": PLAN, "tasks.md": closed });
    const r = await sddFeatureStatus({}, { projectDir: root });
    expect("features" in r && r.features.map((f) => [f.slug, f.stage, `${f.closed}/${f.total}`])).toEqual([
      ["a", "Implementación", "5/9"],
      ["b", "Cerrada", "5/5"],
    ]);
    expect("features" in r && r.features[0]!.current).toEqual({ id: "T4", owner: "codex (multi-provider) since 2026-10-18" });
    expect(await sddFeatureStatus({ slug: "b" }, { projectDir: root })).toMatchObject({ slug: "b", stage: "Cerrada" });
  });

  it("nested-repos R11: sdd_feature_status sees the live worktree of a task in a registered nested repo", async () => {
    const { root, nested } = makeWorkspace();
    demo(root);
    const home = tmpDir();
    vi.stubEnv("MP_HOME", home);
    // A recent delegation of another task makes T4's claim look orphaned unless its worktree is found.
    writeFileSync(path.join(home, "state.json"), JSON.stringify({ version: 1, recent: [{ id: "x", sdd: { slug: "demo", taskId: "T3" } }] }));
    await createWorktree({ cwd: nested, provider: "codex", includeUncommitted: false, symlink: [], sdd: { slug: "demo", taskId: "T4" } });
    const codes = async (store?: StateStore) =>
      ((await sddFeatureStatus({ slug: "demo" }, { projectDir: root, ...(store ? { store } : {}) })) as { warnings: { code: string }[] }).warnings.map((w) => w.code);
    expect(await codes()).toContain("orphan_claim");
    const store = new StateStore(path.join(tmpDir(), "state.json"));
    await store.update((st) => registerRepo(st, nested));
    expect(await codes(store)).not.toContain("orphan_claim");
  });
});
