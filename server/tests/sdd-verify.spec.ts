import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runVerify } from "../src/verify-commands.js";
import { describe, expect, it } from "vitest";
import type { QualityGate, SddTask } from "../src/sdd/artifacts.js";
import { baselineIsClean, shellSyntax, verifyTask } from "../src/sdd/verify.js";
import { parseTasks } from "../src/sdd/artifacts.js";
import { isAlive, testConfig, tmpDir } from "./helpers.js";

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
  it("nested-repos R10/SC7: a Verify with two backticked commands runs both, one item each; one backtick with && stays manual", async () => {
    const [t] = parseTasks('## T1 — x\n\n- [ ] Open\n- **Verify**: `node -e "process.exit(0)"` y `node -e "console.log(2)"`\n');
    expect(t!.verifyCommands).toEqual(['node -e "process.exit(0)"', 'node -e "console.log(2)"']);
    const items = await verifyTask(tmpDir(), t!, [], 30_000);
    expect(items.map((i) => [i.kind, i.result])).toEqual([
      ["verify", "pass"],
      ["verify", "pass"],
    ]);
    const [chained] = await verifyTask(tmpDir(), task(['node -e "1" && node -e "2"']), [], 30_000);
    expect(chained).toMatchObject({ kind: "verify", result: "manual", reason: expect.stringContaining("&&") });
  });

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

  it("E3: an unavailable executable is a manual check", async () => {
    const items = await verifyTask(tmpDir(), task(["missing-verifier-binary-xyz"]), [], 30000);
    expect(items).toEqual([expect.objectContaining({ result: "manual", reason: expect.stringContaining("not found") })]);
  });

  it("an already cancelled signal starts neither Verify nor gates", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await verifyTask(tmpDir(), task(["node -e 'process.exit(0)'"]),
      [gate("Tests", "node -e 'process.exit(0)'", "exit 0")], 30000, {}, { signal: controller.signal })).toEqual([]);
  });

  it.each(["configured", "sdd"] as const)("R4: %s verification kills the active process and skips the next check", async (kind) => {
    const dir = tmpDir();
    const pidFile = path.join(dir, "pid");
    const marker = path.join(dir, "next");
    const command = `node "${fileURLToPath(new URL("./fixtures/sleep.mjs", import.meta.url))}" 30 "${pidFile}"`;
    const next = `node -e "require('fs').writeFileSync('next', 'ran')"`;
    const controller = new AbortController();
    const seen: string[] = [];
    const onCommand = (c: string) => { seen.push(c); };
    const pending = kind === "configured"
      ? runVerify(dir, testConfig({ verify: { commands: [command, next] } }), controller.signal, onCommand).then(r => r.items)
      : verifyTask(dir, task([command]), [gate("Tests", next, "exit 0")], 30000, {}, { signal: controller.signal, onCommand });
    try {
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 20));
      expect(existsSync(pidFile)).toBe(true);
      const start = Date.now();
      controller.abort();
      const items = await pending;
      expect(Date.now() - start).toBeLessThan(5000);
      expect(items).toEqual([expect.objectContaining({ result: "cancelled" })]);
      expect(seen).toEqual([command]);
      expect(existsSync(marker)).toBe(false);
      expect(isAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    } finally {
      controller.abort();
      await pending;
    }
  });

  it("only a baseline that records zero failures makes a failure new", () => {
    expect(baselineIsClean("Test Files 11 passed (11) · Tests 154 passed (154)")).toBe(true);
    expect(baselineIsClean("√ Validation passed · 7 pass, 0 fail")).toBe(true);
    expect(baselineIsClean("84 selected, 82 passed, 2 failed")).toBe(false);
    expect(baselineIsClean("0 failed, flaky: LedgerIT")).toBe(false);
    expect(baselineIsClean("—")).toBe(false);
  });
});
