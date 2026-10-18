import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { CodexAdapter } from "../src/providers/codex.js";
import { FAKE_CODEX, isAlive, tmpDir } from "./helpers.js";

const codex = (extra: Record<string, unknown> = {}) => new CodexAdapter(parseConfig({ providers: { codex: { binaryPath: FAKE_CODEX, ...extra } } }).providers.codex);
const req = (cwd: string, mode: "read" | "write" = "read", timeoutMs = 10_000) => ({ prompt: "review index.ts", cwd, mode, timeoutMs });

afterEach(() => {
  for (const k of ["FAKE_APPSERVER", "FAKE_RPC_LOG", "FAKE_PID_FILE", "FAKE_MODE"]) delete process.env[k];
});

function rpcLog(file: string): { id?: number; method?: string; params?: Record<string, unknown>; error?: { code: number } }[] {
  return JSON.parse(readFileSync(file, "utf8"));
}

describe("codex app-server transport", () => {
  it("R1: ok → final answer and usage; thread/start carries the sandbox for the mode and approvalPolicy never", async () => {
    const dir = tmpDir();
    process.env.FAKE_APPSERVER = "ok";
    process.env.FAKE_RPC_LOG = path.join(dir, "rpc.json");
    const progress: string[] = [];
    const r = await codex().run({ ...req(dir, "write"), onProgress: (c) => progress.push(c) });
    expect(r).toMatchObject({ ok: true, output: "## Summary\nAll good via app-server." });
    expect(r.usage).toEqual({ inputTokens: 900, cachedInputTokens: 100, outputTokens: 75 });
    const start = rpcLog(process.env.FAKE_RPC_LOG).find((m) => m.method === "thread/start");
    expect(start?.params).toMatchObject({ cwd: dir, sandbox: "workspace-write", approvalPolicy: "never", ephemeral: true });
    expect(progress.join("")).toContain("started command: npm test");
    expect(r.notes ?? []).toEqual([]);

    process.env.FAKE_RPC_LOG = path.join(dir, "rpc2.json");
    await codex().run(req(dir, "read"));
    expect(rpcLog(process.env.FAKE_RPC_LOG).find((m) => m.method === "thread/start")?.params?.sandbox).toBe("read-only");
  });

  it("R1: a server request (approval) is answered -32601 and the turn still completes", async () => {
    const dir = tmpDir();
    process.env.FAKE_APPSERVER = "server-request";
    process.env.FAKE_RPC_LOG = path.join(dir, "rpc.json");
    const r = await codex().run(req(dir));
    expect(r.ok).toBe(true);
    expect(rpcLog(process.env.FAKE_RPC_LOG).find((m) => m.id === 900)?.error?.code).toBe(-32601);
  });

  it("a failed turn maps codexErrorInfo (usageLimitExceeded → QUOTA)", async () => {
    process.env.FAKE_APPSERVER = "error";
    const r = await codex().run(req(tmpDir()));
    expect(r.error?.type).toBe("QUOTA");
  });

  it("R6: cancelling a running turn sends turn/interrupt and the process dies", async () => {
    const dir = tmpDir();
    process.env.FAKE_APPSERVER = "hang";
    process.env.FAKE_RPC_LOG = path.join(dir, "rpc.json");
    process.env.FAKE_PID_FILE = path.join(dir, "pid");
    const ac = new AbortController();
    const run = codex().run({ ...req(dir), signal: ac.signal });
    await new Promise((r) => setTimeout(r, 500));
    ac.abort();
    const r = await run;
    expect(r.error?.type).toBe("CANCELLED");
    expect(rpcLog(process.env.FAKE_RPC_LOG).some((m) => m.method === "turn/interrupt")).toBe(true);
    const pid = Number(readFileSync(process.env.FAKE_PID_FILE, "utf8"));
    for (let i = 0; i < 60 && isAlive(pid); i++) await new Promise((res) => setTimeout(res, 100));
    expect(isAlive(pid)).toBe(false);
  });

  it("R4: a silent turn stalls on the idle timeout", async () => {
    process.env.FAKE_APPSERVER = "hang";
    const r = await codex().run({ ...req(tmpDir()), idleTimeoutMs: 400 });
    expect(r.error?.type).toBe("STALLED");
  });

  it("E1: no app-server (or a failing initialize) falls back to codex exec with a note", async () => {
    const r = await codex().run(req(tmpDir()));
    expect(r).toMatchObject({ ok: true, output: "## Summary\nAll good." });
    expect(r.notes?.[0]).toContain("app-server unavailable");
    process.env.FAKE_APPSERVER = "init-error";
    const r2 = await codex().run(req(tmpDir()));
    expect(r2.ok).toBe(true);
    expect(r2.notes?.[0]).toContain("initialize failed");
  });

  it("transport: exec never starts the app-server", async () => {
    process.env.FAKE_APPSERVER = "ok";
    const r = await codex({ transport: "exec" }).run(req(tmpDir()));
    expect(r.output).toBe("## Summary\nAll good.");
  });
});
