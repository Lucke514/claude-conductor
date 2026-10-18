import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatDoctor, runDoctor, type DoctorReport } from "../src/doctor.js";
import { StateStore } from "../src/state.js";
import { FAKE_AGY, FAKE_CODEX, tmpDir } from "./helpers.js";

function project(config: unknown = { providers: { codex: { binaryPath: FAKE_CODEX }, antigravity: { binaryPath: FAKE_AGY, usePty: false } } }): string {
  const dir = tmpDir("mp-doctor-proj-");
  mkdirSync(path.join(dir, ".claude"));
  writeFileSync(path.join(dir, ".claude", "multiprovider.json"), typeof config === "string" ? config : JSON.stringify(config));
  return dir;
}

const check = (r: DoctorReport, name: string) => r.checks.find((c) => c.name === name);

afterEach(() => {
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_AUTH;
});

describe("doctor", () => {
  it("passes end to end with working providers", async () => {
    const r = await runDoctor({ projectDir: project(), store: new StateStore(), live: true, liveTimeoutMs: 10_000 });
    expect(r.ok).toBe(true);
    expect(check(r, "config")?.level).toBe("ok");
    expect(check(r, "codex: install & auth")).toMatchObject({ level: "ok" });
    expect(check(r, "codex: install & auth")?.detail).toContain("codex-cli 9.9.9");
    // agy has no auth-status command: only the live run proves it works.
    expect(check(r, "antigravity: install & auth")?.level).toBe("warn");
    expect(check(r, "codex: live run")).toMatchObject({ level: "ok" });
    expect(check(r, "antigravity: live run")).toMatchObject({ level: "ok" });
  });

  it("reports missing auth with its fix and skips the live run", async () => {
    process.env.FAKE_AUTH = "missing";
    const r = await runDoctor({ projectDir: project(), store: new StateStore(), live: true, liveTimeoutMs: 10_000 });
    expect(r.ok).toBe(false);
    expect(check(r, "codex: install & auth")).toMatchObject({ level: "fail", fix: "codex login" });
    expect(check(r, "codex: live run")?.level).toBe("skip");
  });

  it("classifies a failing live run", async () => {
    process.env.FAKE_MODE = "ratelimit";
    const r = await runDoctor({ projectDir: project(), store: new StateStore(), live: true, liveTimeoutMs: 10_000 });
    expect(r.ok).toBe(false);
    expect(check(r, "codex: live run")?.detail).toMatch(/^RATE_LIMIT/);
    expect(check(r, "codex: live run")?.fix).toMatch(/limit to reset/);
  });

  it("reports a missing binary and an invalid config", async () => {
    const missing = await runDoctor({
      projectDir: project({ providers: { codex: { binaryPath: "/nonexistent/codex" }, antigravity: { enabled: false } } }),
      store: new StateStore(),
      live: false,
    });
    expect(check(missing, "codex: install & auth")).toMatchObject({ level: "fail" });
    expect(check(missing, "antigravity: install & auth")?.level).toBe("skip");
    expect(check(missing, "codex: live run")?.level).toBe("skip");

    const invalid = await runDoctor({ projectDir: project({ chain: [] }), store: new StateStore(), live: false });
    expect(invalid.ok).toBe(false);
    expect(check(invalid, "config")?.level).toBe("fail");
  });

  it("formats a readable report", () => {
    const text = formatDoctor({
      ok: false,
      checks: [
        { name: "node", level: "ok", detail: "v20.0.0" },
        { name: "codex: live run", level: "fail", detail: "AUTH", fix: "codex login" },
      ],
    });
    expect(text).toContain("✓ node");
    expect(text).toContain("✗ codex: live run");
    expect(text).toContain("fix: codex login");
    expect(text).toMatch(/some checks failed$/);
  });
});

describe("resolveCommand", () => {
  it("runs a .js/.mjs entry point with the current node", async () => {
    const { resolveCommand } = await import("../src/process.js");
    expect(resolveCommand(FAKE_CODEX)).toEqual({ command: process.execPath, prefixArgs: [FAKE_CODEX], resolvedPath: FAKE_CODEX });
  });
});
