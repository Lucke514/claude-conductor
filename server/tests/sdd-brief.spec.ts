import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/prompt-builder.js";
import { loadFeature, resolveTask } from "../src/sdd/artifacts.js";
import { acceptanceItems, buildTaskBrief } from "../src/sdd/brief.js";
import { tmpDir } from "./helpers.js";
import { PLAN, SPEC, TASKS, writeFeature } from "./sdd-fixtures.js";

async function briefFor(ref: string) {
  const root = tmpDir();
  writeFeature(root, "demo", { "spec.md": SPEC, "plan.md": PLAN, "tasks.md": TASKS });
  writeFileSync(path.join(root, "index.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, ".env"), "SECRET=hunter2\n");
  mkdirSync(path.join(root, "src"));
  const feature = await loadFeature(root, "demo");
  const task = resolveTask(feature, ref);
  const brief = buildTaskBrief(feature, task);
  const built = await buildPrompt({ ...brief, mode: "write", projectDir: root, maxFileBytes: 10_000, maxTotalBytes: 100_000 });
  return { feature, task, brief, built };
}

describe("sdd task brief", () => {
  it("R3: carries Do, Acceptance, Verify, Files and the literal R#/E#/C# texts and gates", async () => {
    const { built } = await briefFor("T3");
    const p = built.prompt;
    expect(p).toContain("Implement task T3 — Construir el brief of the spec-driven feature `demo`.");
    expect(p).toContain("- **Do**: Escribir el brief con acentos: «añadir» y ñ.");
    expect(p).toContain("- **Acceptance**: El brief contiene R1 y E2.");
    expect(p).toContain('- **Verify**: `node -e "process.exit(0)"`');
    expect(p).toContain("- **R1** — La herramienta resuelve la tarea.\n  - Given una tarea, when se delega, then se usa su bloque.");
    expect(p).toContain("- **E2** — Tarea inexistente.");
    expect(p).not.toContain("- **R2** — Segunda regla.");
    expect(p).toContain("#### C2 — Brief\n\n- **Implements**: R2, E2");
    expect(p).toContain('- Tests: `node -e "process.exit(0)"`');
    expect(p).toContain("- Dist: `git diff --exit-code` (CI only)");
    expect(p).not.toContain("- Lint:");
    expect(p).toContain("## Acceptance — one line per item below");
    expect(p).toContain("  - A1: El brief contiene R1 y E2\n  - R1: La herramienta resuelve la tarea.\n  - E2: Tarea inexistente.");
  });

  it("R4/E5: embeds existing files, marks missing ones to be created, never embeds secrets", async () => {
    const { built } = await briefFor("T3");
    expect(built.prompt).toContain("### index.ts\n```ts\nexport const a = 1;\n```");
    expect(built.files).toEqual([
      { path: "index.ts", included: true, bytes: 20, truncated: false },
      { path: "src/nuevo.ts", included: false, reason: "does not exist yet — to be created" },
      { path: ".env", included: false, reason: "sensitive file (credentials/secrets) — never shared" },
    ]);
    expect(built.prompt).toContain("- src/nuevo.ts: does not exist yet — to be created");
    expect(built.prompt).not.toContain("hunter2");
  });

  it("splits the Acceptance field into one item per clause", async () => {
    const { feature, task } = await briefFor("T3");
    task.acceptance = "Uno pasa; dos también.";
    expect(acceptanceItems(feature, task).map((i) => i.id + ":" + i.text)).toEqual(["A1:Uno pasa", "A2:dos también", "R1:La herramienta resuelve la tarea.", "E2:Tarea inexistente."]);
  });
});
