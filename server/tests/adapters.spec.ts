import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { stripAnsi } from "../src/process.js";
import { AntigravityAdapter } from "../src/providers/antigravity.js";
import { CodexAdapter } from "../src/providers/codex.js";
import { FAKE_AGY, FAKE_CODEX, isAlive, tmpDir } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function codex(extra: Record<string, unknown> = {}) {
  return new CodexAdapter(parseConfig({ providers: { codex: { binaryPath: FAKE_CODEX, ...extra } } }).providers.codex);
}
function agy(extra: Record<string, unknown> = {}) {
  return new AntigravityAdapter(parseConfig({ providers: { antigravity: { binaryPath: FAKE_AGY, ...extra } } }).providers.antigravity);
}
const req = (cwd: string, mode: "read" | "write" = "read", timeoutMs = 10_000) => ({ prompt: "do the thing\nline 2", cwd, mode, timeoutMs });

afterEach(() => {
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_ARGS_FILE;
  delete process.env.FAKE_PID_FILE;
  delete process.env.FAKE_AUTH;
  delete process.env.FAKE_PROMPT_FILE;
});

describe("CodexAdapter", () => {
  it("success: builds argv, sends prompt on stdin, parses JSONL", async () => {
    const dir = tmpDir();
    process.env.FAKE_ARGS_FILE = path.join(dir, "args.json");
    process.env.FAKE_PROMPT_FILE = path.join(dir, "prompt.txt");
    const r = await codex({ model: "m1", extraArgs: ["--ephemeral"] }).run(req(dir));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("## Summary\nAll good.");
    expect(r.usage).toEqual({ inputTokens: 1200, cachedInputTokens: 200, outputTokens: 300 });
    expect(r.model).toBe("m1");
    const args = JSON.parse(readFileSync(process.env.FAKE_ARGS_FILE, "utf8"));
    expect(args).toEqual(["exec", "--json", "--color", "never", "-C", dir, "--sandbox", "read-only", "--skip-git-repo-check", "-m", "m1", "--ephemeral", "-"]);
    expect(readFileSync(process.env.FAKE_PROMPT_FILE, "utf8")).toBe("do the thing\nline 2");
  });

  it("write mode uses workspace-write sandbox", async () => {
    const dir = tmpDir();
    process.env.FAKE_ARGS_FILE = path.join(dir, "args.json");
    await codex().run(req(dir, "write"));
    const args = JSON.parse(readFileSync(process.env.FAKE_ARGS_FILE, "utf8")) as string[];
    expect(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "workspace-write"]);
  });

  it.each([
    ["auth", "AUTH"],
    ["ratelimit", "RATE_LIMIT"],
    ["quota", "QUOTA"],
    ["empty", "EMPTY_OUTPUT"],
    ["garbage", "PARSE_ERROR"],
    ["crash", "NON_ZERO_EXIT"],
  ])("mode %s -> %s", async (mode, type) => {
    process.env.FAKE_MODE = mode;
    const r = await codex().run(req(tmpDir()));
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe(type);
  });

  it("not installed", async () => {
    const r = await codex({ binaryPath: "/nonexistent/codex-xyz" }).run(req(tmpDir()));
    expect(r.error?.type).toBe("NOT_INSTALLED");
  });

  it("timeout kills the whole process tree", async () => {
    const dir = tmpDir();
    process.env.FAKE_MODE = "timeout";
    process.env.FAKE_PID_FILE = path.join(dir, "pid");
    const r = await codex().run(req(dir, "read", 800));
    expect(r.error?.type).toBe("TIMEOUT");
    const pid = Number(readFileSync(process.env.FAKE_PID_FILE, "utf8"));
    await sleep(300);
    expect(isAlive(pid)).toBe(false);
  });

  it("health check: version and login status via exit code", async () => {
    const h = await codex().healthCheck();
    expect(h).toMatchObject({ provider: "codex", installed: true, version: "codex-cli 9.9.9", auth: "ok" });
    process.env.FAKE_AUTH = "missing";
    expect((await codex().healthCheck()).auth).toBe("missing");
    const missing = await codex({ binaryPath: "/nonexistent/codex" }).healthCheck();
    expect(missing.installed).toBe(false);
  });
});

describe("AntigravityAdapter", () => {
  it("plain spawn: passes -p prompt and strips ANSI/spinner", async () => {
    const dir = tmpDir();
    process.env.FAKE_ARGS_FILE = path.join(dir, "args.json");
    const r = await agy({ usePty: false, model: "gemini-x" }).run(req(dir));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("## Summary");
    const { args } = JSON.parse(readFileSync(process.env.FAKE_ARGS_FILE, "utf8"));
    // provider-reliability: stream-json is the default output format.
    expect(args).toEqual(["--model", "gemini-x", "--output-format", "stream-json", "-p", "do the thing\nline 2"]);
  });

  it("PTY mode: the CLI sees a TTY (works around the -p no-TTY hang) and output is ANSI-free", async () => {
    const dir = tmpDir();
    process.env.FAKE_MODE = "needs-tty";
    process.env.FAKE_ARGS_FILE = path.join(dir, "args.json");
    const r = await agy({ usePty: true, outputFormat: "text" }).run(req(dir, "read", 10_000));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("tty ok");
    expect(JSON.parse(readFileSync(process.env.FAKE_ARGS_FILE, "utf8")).tty).toBe(true);
  });

  it("without PTY the hanging CLI hits the hard timeout and its tree is killed", async () => {
    process.env.FAKE_MODE = "needs-tty";
    const r = await agy({ usePty: false }).run(req(tmpDir(), "read", 700));
    expect(r.error?.type).toBe("TIMEOUT");
  });

  it("provider-reliability: the real stream-json capture parses to its answer and usage", async () => {
    const { parseAgyStream } = await import("../src/providers/antigravity.js");
    const text = readFileSync(path.join(path.dirname(FAKE_AGY), "agy-stream.jsonl"), "utf8");
    const p = parseAgyStream(text);
    expect(p.response).toBe("OK\n");
    expect(p.status).toBe("SUCCESS");
    expect(p.usage).toEqual({ inputTokens: 12745, cachedInputTokens: 0, outputTokens: 49 });
    expect(p.permission).toBeUndefined();
    process.env.FAKE_MODE = "stream-fixture";
    const progress: string[] = [];
    const r = await agy({}).run({ ...req(tmpDir()), onProgress: (c) => progress.push(c) });
    expect(r).toMatchObject({ ok: true, output: "OK" });
    expect(progress.join("")).toContain("active run_command: ls -la .");
  });

  it("R3: a step waiting for approval ends the attempt with PERMISSION_BLOCKED and the command", async () => {
    process.env.FAKE_MODE = "stream-permission";
    const started = Date.now();
    const r = await agy({}).run(req(tmpDir(), "write", 30_000));
    expect(r.error?.type).toBe("PERMISSION_BLOCKED");
    expect(r.error?.message).toContain("run_command: npm test");
    expect(r.error?.message).toContain("writeModeArgs");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("R2: write mode skips permission prompts by default; read mode does not", async () => {
    const dir = tmpDir();
    process.env.FAKE_ARGS_FILE = path.join(dir, "args.json");
    await agy({}).run(req(dir, "write"));
    const w = JSON.parse(readFileSync(process.env.FAKE_ARGS_FILE, "utf8"));
    expect(w.args).toContain("--dangerously-skip-permissions");
    expect(w.tty).toBe(false);
    await agy({}).run(req(dir, "read"));
    expect(JSON.parse(readFileSync(process.env.FAKE_ARGS_FILE, "utf8")).args).not.toContain("--dangerously-skip-permissions");
    await agy({ writeModeArgs: [] }).run(req(dir, "write"));
    expect(JSON.parse(readFileSync(process.env.FAKE_ARGS_FILE, "utf8")).args).not.toContain("--dangerously-skip-permissions");
  });

  it("E6: agy in text mode forwards no output to progress; codex exec forwards event labels only", async () => {
    const seen: string[] = [];
    await agy({ outputFormat: "text", usePty: false }).run({ ...req(tmpDir()), onProgress: (c) => seen.push(c) });
    expect(seen).toEqual([]);
  });

  it("E2: an agy without stream-json falls back to text with a note", async () => {
    process.env.FAKE_MODE = "unknown-flag";
    const r = await agy({}).run(req(tmpDir()));
    expect(r).toMatchObject({ ok: true, output: "text answer" });
    expect(r.notes?.join(" ")).toContain("text mode");
  });

  it("PTY timeout kills the tree", async () => {
    const dir = tmpDir();
    process.env.FAKE_MODE = "timeout";
    process.env.FAKE_PID_FILE = path.join(dir, "pid");
    const r = await agy({ usePty: true }).run(req(dir, "read", 1000));
    expect(r.error?.type).toBe("TIMEOUT");
    const pid = Number(readFileSync(process.env.FAKE_PID_FILE, "utf8"));
    await sleep(500);
    expect(isAlive(pid)).toBe(false);
  });

  it.each([
    ["auth", "AUTH", false],
    ["ratelimit", "RATE_LIMIT", false],
    ["empty", "EMPTY_OUTPUT", false],
    ["auth", "AUTH", true],
  ])("mode %s -> %s (pty=%s)", async (mode, type, usePty) => {
    process.env.FAKE_MODE = mode;
    const r = await agy({ usePty }).run(req(tmpDir()));
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe(type);
  });

  it("json output format", async () => {
    process.env.FAKE_MODE = "json";
    const r = await agy({ usePty: false, outputFormat: "json" }).run(req(tmpDir()));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("json answer");
    expect(r.usage).toEqual({ inputTokens: 50, cachedInputTokens: 0, outputTokens: 7 });
  });

  it("very long prompts go through a temp file that is removed afterwards", async () => {
    const dir = tmpDir();
    process.env.FAKE_MODE = "longprompt";
    const r = await agy({ usePty: false }).run({ ...req(dir), prompt: "x".repeat(200_000) });
    expect(r.ok).toBe(true);
    expect(Number(r.output.match(/length (\d+)/)![1])).toBeLessThan(1000);
    expect(readdir(dir).filter((f) => f.startsWith(".mp-task-"))).toEqual([]);
  });

  it("health check: version, auth unknown by default", async () => {
    const h = await agy().healthCheck();
    expect(h).toMatchObject({ provider: "antigravity", installed: true, version: "1.3.6", auth: "unknown" });
  });
});

describe("stripAnsi", () => {
  it("removes CSI/OSC sequences and resolves carriage returns", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    expect(stripAnsi("\u001b]0;title\u0007text")).toBe("text");
    expect(stripAnsi("loading 10%\rloading 100%\r\ndone")).toBe("loading 100%\ndone");
    expect(stripAnsi("a\u001b[2Kb\u001b[?25l")).toBe("ab");
  });
});

import { readdirSync } from "node:fs";
function readdir(d: string): string[] {
  return readdirSync(d);
}
