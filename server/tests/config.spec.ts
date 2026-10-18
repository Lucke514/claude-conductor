import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, deepMerge, effectiveErrorPatterns, loadConfig, parseConfig } from "../src/config.js";
import { tmpDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("config validation", () => {
  it("applies defaults to an empty config", () => {
    const c = parseConfig({});
    expect(c.chain).toEqual(["codex", "antigravity", "claude"]);
    expect(c.defaults).toMatchObject({ mode: "read", timeoutMs: 600000, maxFileBytes: 65536 });
    expect(c.circuitBreaker).toEqual({ threshold: 3, cooldownMs: 300000 });
    expect(c.retry.retryOn).toEqual(["RATE_LIMIT", "TIMEOUT"]);
    expect(c.providers.codex).toMatchObject({ enabled: true, extraArgs: [], errorPatterns: {} });
    expect(c.statusline.mode).toBe("compact");
    expect(c.card.placement).toBe("side");
    expect(c.guardrails.checkRemotePush).toBe(true);
  });

  it("rejects unknown providers in the chain", () => {
    expect(() => parseConfig({ chain: ["codex", "gpt"] })).toThrow(ConfigError);
  });

  it("rejects bad types with the offending path", () => {
    expect(() => parseConfig({ defaults: { timeoutMs: -1 } })).toThrow(/defaults\.timeoutMs/);
    expect(() => parseConfig({ providers: { codex: { extraArgs: "x" } } })).toThrow(/providers\.codex\.extraArgs/);
    expect(() => parseConfig({ providers: { codex: { errorPatterns: { FOO: ["x"] } } } })).toThrow(ConfigError);
    expect(() => parseConfig({ retry: { retryOn: ["AUTH"] } })).toThrow(ConfigError);
  });

  it("accepts routing as string or object", () => {
    const c = parseConfig({ routing: { review: "codex", refactor: { provider: "antigravity", keywords: ["refactor"] } } });
    expect(c.routing.review).toBe("codex");
    expect(() => parseConfig({ routing: { x: "nope" } })).toThrow(ConfigError);
  });

  it("validates the shipped example config", () => {
    const example = JSON.parse(readFileSync(path.join(here, "..", "..", "config", "multiprovider.example.json"), "utf8"));
    expect(() => parseConfig(example)).not.toThrow();
  });
});

describe("deepMerge", () => {
  it("merges objects and replaces arrays", () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: 2 })).toEqual({ a: { b: 1, c: [3] }, d: 1, e: 2 });
  });
});

describe("loadConfig", () => {
  const userFile = process.env.MP_USER_CONFIG!;
  afterEach(() => rmSync(userFile, { force: true }));

  it("merges project then user (user wins)", async () => {
    const proj = tmpDir();
    mkdirSync(path.join(proj, ".claude"));
    writeFileSync(path.join(proj, ".claude", "multiprovider.json"), JSON.stringify({ defaults: { timeoutMs: 1000, mode: "write" }, chain: ["antigravity", "claude"] }));
    writeFileSync(userFile, JSON.stringify({ defaults: { timeoutMs: 2000 } }));
    const { config, sources } = await loadConfig(proj);
    expect(config.defaults.timeoutMs).toBe(2000);
    expect(config.defaults.mode).toBe("write");
    expect(config.chain).toEqual(["antigravity", "claude"]);
    expect(sources.map((s) => s.loaded)).toEqual([true, true]);
  });

  it("reports which file is invalid", async () => {
    const proj = tmpDir();
    writeFileSync(userFile, "{ not json");
    await expect(loadConfig(proj)).rejects.toThrow(/JSON parse error/);
    writeFileSync(userFile, JSON.stringify({ chain: [] }));
    await expect(loadConfig(proj)).rejects.toThrow(new RegExp(path.basename(userFile)));
  });

  it("works with no files at all", async () => {
    const { config, sources } = await loadConfig(tmpDir());
    expect(config.chain[0]).toBe("codex");
    expect(sources.every((s) => !s.loaded)).toBe(true);
  });
});

describe("error patterns", () => {
  it("uses defaults and lets config replace a type", () => {
    const c = parseConfig({ providers: { codex: { errorPatterns: { AUTH: ["custom-auth"], RATE_LIMIT: ["[invalid"] } } } });
    const p = effectiveErrorPatterns("codex", c.providers.codex);
    expect(p.AUTH!.some((r) => r.test("CUSTOM-AUTH failure"))).toBe(true);
    expect(p.AUTH!.some((r) => r.test("401"))).toBe(false);
    // Invalid regex is treated as a literal.
    expect(p.RATE_LIMIT![0]!.test("x [invalid y")).toBe(true);
    expect(p.QUOTA!.some((r) => r.test("You’ve hit your usage limit"))).toBe(true);
  });
});
