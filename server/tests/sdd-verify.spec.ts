import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { QualityGate, SddTask } from "../src/sdd/artifacts.js";
import { baselineIsClean, shellSyntax, verifyTask } from "../src/sdd/verify.js";
import { tmpDir } from "./helpers.js";

const task = (verify: string[], text = verify.map((v) => `\`${v}\``).join(" · ")): SddTask => ({
  id: "T1",
  title: "x",
  parallel: false,
  box: "open",
  owner: "codex",
  implements: [],
  files: [],
  verify: text,
  verifyCommands: verify,
});
const gate = (name: string, command: string, baseline: string, where = "`here`"): QualityGate => ({
  gate: name,
  commands: [command],
  where,
  pipelineOnly: where.includes("pipeline-only"),
  baseline,
});

describe("sdd verification", () => {
  it("R7: runs Verify and gates without a shell, with output and new-failure verdicts", async () => {
    const dir = tmpDir();
    const items = await verifyTask(
      dir,
      task(['node -e "console.log(\'verify ok\')"']),
      [
        gate("Tests", 'node -e "process.exit(0)"', "Tests 3 passed (3)"),
        gate("Types", 'node -e "console.error(\'boom\'); process.exit(2)"', "exit 0, 0 errores"),
        gate("Lint", 'node -e "process.exit(1)"', "8 pre-existing warnings"),
        gate("Dist", "git diff --exit-code", "—", "`pipeline-only`"),
      ],
      30_000,
    );
    expect(items.map((i) => [i.kind, i.gate ?? "", i.result, i.newFailure ?? ""])).toEqual([
      ["verify", "", "pass", ""],
      ["gate", "Tests", "pass", false],
      ["gate", "Types", "fail", true],
      ["gate", "Lint", "fail", "compare"],
      ["gate", "Dist", "manual", ""],
    ]);
    expect(items[0]!.outputTail).toBe("verify ok");
    expect(items[2]).toMatchObject({ exitCode: 2, outputTail: "boom", baseline: "exit 0, 0 errores" });
    expect(items[3]!.baseline).toBe("8 pre-existing warnings");
  });

  it("E3: a command with shell syntax is never run and stays a manual check", async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "x"), "keep\n");
    const items = await verifyTask(dir, task(["npm test && rm -rf x"]), [], 30_000);
    expect(items).toEqual([{ kind: "verify", command: "npm test && rm -rf x", result: "manual", reason: expect.stringContaining("shell syntax (&&)") }]);
    expect(existsSync(path.join(dir, "x"))).toBe(true);
    for (const [cmd, token] of [["a | b", "|"], ["a; b", ";"], ["a > f", ">"], ["echo $HOME", "$"], ['echo "$HOME"', "$"], ["ls *.ts", "*"], ["a `b`", "`"]]) {
      expect(shellSyntax(cmd!)).toBe(token);
    }
    expect(shellSyntax("echo '$HOME | x'")).toBeUndefined();
    expect(shellSyntax('node -e "process.exit(0)"')).toBeUndefined();
    expect(shellSyntax("npm --prefix server test -- sdd-verify")).toBeUndefined();
  });

  it("E9: a failing Verify is reported and the worktree is left in place; manual Verify is reported as such", async () => {
    const dir = tmpDir();
    const [failed] = await verifyTask(dir, task(['node -e "process.exit(3)"']), [], 30_000);
    expect(failed).toMatchObject({ result: "fail", exitCode: 3 });
    expect(existsSync(dir)).toBe(true);
    const [manual] = await verifyTask(dir, task([], "revisión manual"), [], 30_000);
    expect(manual).toMatchObject({ result: "manual", command: "revisión manual" });
  });

  it("only a baseline that records zero failures makes a failure new", () => {
    expect(baselineIsClean("Test Files 11 passed (11) · Tests 154 passed (154)")).toBe(true);
    expect(baselineIsClean("√ Validation passed · 7 pass, 0 fail")).toBe(true);
    expect(baselineIsClean("84 selected, 82 passed, 2 failed")).toBe(false);
    expect(baselineIsClean("0 failed, flaky: LedgerIT")).toBe(false);
    expect(baselineIsClean("—")).toBe(false);
  });
});
