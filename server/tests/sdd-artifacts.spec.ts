import { describe, expect, it } from "vitest";
import { checkReferences, loadFeature, parseGates, resolveTask, SddError } from "../src/sdd/artifacts.js";
import { tmpDir } from "./helpers.js";
import { PLAN, SPEC, TASKS, writeFeature } from "./sdd-fixtures.js";

describe("sdd artifacts", () => {
  it("R1: resolves T3 with its fields, verbatim text (E8) and parallel flag", async () => {
    const root = tmpDir();
    writeFeature(root, "demo", { "spec.md": SPEC, "plan.md": PLAN, "tasks.md": TASKS });
    const f = await loadFeature(root, "demo");
    expect(f.depth).toBe("standard");
    expect(f.tasksFile).toBe("specs/demo/tasks.md");
    expect(f.statuses).toEqual({ spec: "approved", plan: "approved", tasks: "approved" });
    const t = resolveTask(f, "t3");
    expect(t).toMatchObject({
      id: "T3",
      title: "Construir el brief",
      parallel: true,
      box: "open",
      owner: null,
      component: "C2",
      implements: ["R1", "E2"],
      files: ["index.ts", "src/nuevo.ts", ".env"],
      do: "Escribir el brief con acentos: «añadir» y ñ.",
      acceptance: "El brief contiene R1 y E2.",
      verifyCommands: ['node -e "process.exit(0)"'],
    });
    expect(f.requirements.get("R1")).toBe("- **R1** — La herramienta resuelve la tarea.\n  - Given una tarea, when se delega, then se usa su bloque.");
    expect(f.components.get("C2")).toContain("- **Implements**: R2, E2");
    expect(f.tasks.map((x) => [x.id, x.box])).toEqual([["T1", "done"], ["T2", "blocked"], ["T3", "open"], ["T4", "open"], ["G1", "open"]]);
    expect(resolveTask(f, "T4").owner).toBe("codex (multi-provider) since 2026-10-18");
    expect(resolveTask(f, "T4").verifyCommands).toEqual([]);
  });

  it("R2: next skips done, blocked and claimed tasks", async () => {
    const root = tmpDir();
    writeFeature(root, "demo", { "spec.md": SPEC, "plan.md": PLAN, "tasks.md": TASKS });
    const f = await loadFeature(root, "demo");
    expect(resolveTask(f, "next").id).toBe("T3");
    f.tasks.find((t) => t.id === "T3")!.owner = "claude";
    expect(resolveTask(f, "next").id).toBe("G1");
  });

  it("E1: an unknown slug lists the available features", async () => {
    const root = tmpDir();
    writeFeature(root, "demo", { "spec.md": SPEC, "plan.md": PLAN, "tasks.md": TASKS });
    writeFeature(root, "draft-only", { "spec.md": SPEC });
    await expect(loadFeature(root, "nope")).rejects.toThrow(/Available features: demo$/);
    await expect(loadFeature(root, "draft-only")).rejects.toThrow(/has no tasks\.md/);
    await expect(loadFeature(root, "../etc")).rejects.toMatchObject({ code: "INVALID_SLUG" });
  });

  it("E2: an unknown task or an empty next lists open tasks and owners", async () => {
    const root = tmpDir();
    writeFeature(root, "demo", { "spec.md": SPEC, "plan.md": PLAN, "tasks.md": TASKS });
    const f = await loadFeature(root, "demo");
    expect(() => resolveTask(f, "T9")).toThrow("Open tasks: T3 (owner: —), T4 (owner: codex (multi-provider) since 2026-10-18), G1 (owner: —)");
    for (const t of f.tasks) t.owner = "x";
    let err: unknown;
    try {
      resolveTask(f, "next");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SddError);
    expect((err as SddError).code).toBe("NO_OPEN_TASK");
  });

  it("E4: a cited R#/E# or C# missing from the artifacts is rejected by id", async () => {
    const root = tmpDir();
    writeFeature(root, "demo", { "spec.md": SPEC, "plan.md": PLAN, "tasks.md": TASKS.replace("**Component**: C2 · **Implements**: R1, E2", "**Component**: C7 · **Implements**: R1, E2") });
    const f = await loadFeature(root, "demo");
    expect(() => checkReferences(f, resolveTask(f, "G1"))).toThrow(/G1 cites R9, which does not exist/);
    expect(() => checkReferences(f, resolveTask(f, "T3"))).toThrow(/T3 cites C7/);
    expect(() => checkReferences(f, resolveTask(f, "T1"))).not.toThrow();
  });

  it("E7: a Small feature reads tasks, gates and Status from spec.md", async () => {
    const root = tmpDir();
    const small = `${SPEC}\n## Tasks\n\n${PLAN.slice(PLAN.indexOf("| Gate"), PLAN.indexOf("## Components"))}\n### T1 — Única\n\n- [ ] Done\n- **Owner**: —\n- **Implements**: R1\n- **Files**: \`index.ts\`\n- **Verify**: \`node -e "1"\`\n- **Notes**: —\n`;
    writeFeature(root, "chica", { "spec.md": small });
    const f = await loadFeature(root, "chica");
    expect(f.depth).toBe("small");
    expect(f.tasksFile).toBe("specs/chica/spec.md");
    expect(f.statuses).toEqual({ spec: "approved", tasks: "approved" });
    expect(resolveTask(f, "next")).toMatchObject({ id: "T1", implements: ["R1"] });
    expect(f.gates.map((g) => g.gate)).toEqual(["Tests", "Dist", "Lint"]);
    expect(() => checkReferences(f, resolveTask(f, "T1"))).not.toThrow();
  });

  it("parses the Quality gates table, CRLF included", () => {
    const gates = parseGates(PLAN.replace(/\n/g, "\r\n"));
    expect(gates).toEqual([
      { gate: "Tests", commands: ['node -e "process.exit(0)"'], where: "`here`", pipelineOnly: false, baseline: "3 passed, 0 failed" },
      { gate: "Dist", commands: ["git diff --exit-code"], where: "`pipeline-only`", pipelineOnly: true, baseline: "—" },
      { gate: "Lint", commands: [], where: "—", pipelineOnly: false, baseline: "—" },
    ]);
  });
});
