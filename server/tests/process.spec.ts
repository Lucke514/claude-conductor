import { describe, expect, it } from "vitest";
import { runProcess } from "../src/process.js";

const node = (code: string) => ({ command: process.execPath, args: ["-e", code], cwd: process.cwd() });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitGone = async (pid: number) => {
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

// Prints the pid of a grandchild that never exits, then waits forever itself.
const PARENT_WITH_CHILD = `
const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log("child " + c.pid);
setInterval(() => {}, 1000);
`;

describe("runProcess: cancel, live output and idle timeout", () => {
  it("R4: output every 50 ms survives a 200 ms idle timeout and reaches onOutput in order", async () => {
    const chunks: string[] = [];
    const r = await runProcess({
      ...node(`let i = 0; const t = setInterval(() => { process.stdout.write(i + "\\n"); if (++i === 8) { clearInterval(t); } }, 50);`),
      timeoutMs: 10_000,
      idleTimeoutMs: 200,
      onOutput: (c) => chunks.push(c),
    });
    expect(r).toMatchObject({ exitCode: 0, stalled: false, timedOut: false, cancelled: false });
    expect(chunks.join("").trim().split("\n")).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  });

  it("R4: 300 ms of silence with a 200 ms idle timeout stalls and kills the tree", async () => {
    let child = 0;
    const r = await runProcess({
      ...node(PARENT_WITH_CHILD),
      timeoutMs: 10_000,
      idleTimeoutMs: 200,
      onOutput: (c) => (child ||= Number(/child (\d+)/.exec(c)?.[1] ?? 0)),
    });
    expect(r).toMatchObject({ stalled: true, timedOut: false, cancelled: false });
    expect(child).toBeGreaterThan(0);
    expect(await waitGone(child)).toBe(true);
  });

  it("R6: aborting the signal kills the process and its child", async () => {
    const ac = new AbortController();
    let child = 0;
    const run = runProcess({
      ...node(PARENT_WITH_CHILD),
      timeoutMs: 10_000,
      signal: ac.signal,
      onOutput: (c) => {
        child ||= Number(/child (\d+)/.exec(c)?.[1] ?? 0);
        if (child) ac.abort();
      },
    });
    const r = await run;
    expect(r).toMatchObject({ cancelled: true, timedOut: false, stalled: false });
    expect(await waitGone(child)).toBe(true);
  });

  it("R6: an already aborted signal never starts the process", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runProcess({ ...node(`require("node:fs").writeFileSync("should-not-exist", "x")`), timeoutMs: 10_000, signal: ac.signal });
    expect(r).toMatchObject({ cancelled: true, exitCode: null, durationMs: 0 });
  });

  it("the total timeout still applies while output keeps coming", async () => {
    const r = await runProcess({ ...node(`setInterval(() => process.stdout.write("."), 20)`), timeoutMs: 300, idleTimeoutMs: 200 });
    expect(r).toMatchObject({ timedOut: true, stalled: false });
  });
});
