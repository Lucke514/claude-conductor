import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { parseConfig } from "../src/config.js";
import { backoffDelay, classifyFailure, resolveOrder, routeTask, runChain } from "../src/fallback.js";
import { effectiveErrorPatterns } from "../src/config.js";
import type { ErrorType, ProviderAdapter, ProviderName, ProviderResult } from "../src/providers/types.js";

const ok = (output = "fine"): ProviderResult => ({ ok: true, output, exitCode: 0, durationMs: 5 });
const err = (type: ErrorType): ProviderResult => ({ ok: false, output: "", exitCode: 1, durationMs: 5, error: { type, message: type } });

function fakeAdapter(name: ProviderName): ProviderAdapter {
  return { name, isAvailable: async () => true, healthCheck: async () => ({}) as never, run: async () => ok() };
}

function setup(script: Record<ProviderName, ProviderResult[]>, cfgOverrides: Record<string, unknown> = {}) {
  const config = parseConfig({ retry: { maxRetries: 2, baseDelayMs: 10 }, ...cfgOverrides });
  const breaker = new CircuitBreaker({ threshold: 10, cooldownMs: 1000 });
  const calls: string[] = [];
  const sleep = vi.fn(async (_ms: number) => undefined);
  const deps = {
    adapters: { codex: fakeAdapter("codex"), antigravity: fakeAdapter("antigravity") },
    breaker,
    config,
    sleep,
    execute: async (p: ProviderName) => {
      calls.push(p);
      return script[p].shift() ?? ok();
    },
  };
  return { deps, calls, sleep, breaker };
}

describe("classifyFailure", () => {
  const patterns = effectiveErrorPatterns("codex", parseConfig({}).providers.codex);
  it.each([
    [{ exitCode: null, timedOut: false, spawnError: { code: "ENOENT", message: "nf" } }, "", "NOT_INSTALLED"],
    [{ exitCode: null, timedOut: true }, "", "TIMEOUT"],
    [{ exitCode: 127, timedOut: false }, "", "NOT_INSTALLED"],
    [{ exitCode: 1, timedOut: false }, "Error: 401 Unauthorized", "AUTH"],
    [{ exitCode: 1, timedOut: false }, "429 Too Many Requests", "RATE_LIMIT"],
    [{ exitCode: 1, timedOut: false }, "429: quota exceeded", "QUOTA"],
    [{ exitCode: 1, timedOut: false }, "You’ve hit your usage limit", "QUOTA"],
    [{ exitCode: 2, timedOut: false }, "panic", "NON_ZERO_EXIT"],
    [{ exitCode: 0, timedOut: false }, "Not logged in", "AUTH"],
  ] as const)("%j + %s -> %s", (run, text, expected) => {
    expect(classifyFailure(run, text, patterns)?.type).toBe(expected);
  });
  it("exit 0 with a rate-limit-looking line is not a failure", () => {
    expect(classifyFailure({ exitCode: 0, timedOut: false }, "rate limit mentioned in passing", patterns)).toBeUndefined();
  });
});

describe("runChain", () => {
  it("returns on the first success", async () => {
    const { deps, calls } = setup({ codex: [ok("A")], antigravity: [] });
    const r = await runChain(["codex", "antigravity", "claude"], deps);
    expect(r.status).toBe("success");
    expect(r.provider).toBe("codex");
    expect(r.result?.output).toBe("A");
    expect(calls).toEqual(["codex"]);
  });

  it("skips straight to the next provider on AUTH and NOT_INSTALLED", async () => {
    const { deps, calls, sleep } = setup({ codex: [err("AUTH")], antigravity: [err("NOT_INSTALLED")] });
    const r = await runChain(["codex", "antigravity", "claude"], deps);
    expect(r.status).toBe("fallback_to_claude");
    expect(calls).toEqual(["codex", "antigravity"]);
    expect(sleep).not.toHaveBeenCalled();
    expect(r.attempts.map((a) => a.errorType)).toEqual(["AUTH", "NOT_INSTALLED"]);
    expect(r.summary).toContain("codex: AUTH");
  });

  it("retries RATE_LIMIT and TIMEOUT with exponential backoff", async () => {
    const { deps, calls, sleep } = setup({ codex: [err("RATE_LIMIT"), err("TIMEOUT"), ok("third")], antigravity: [] });
    const r = await runChain(["codex", "claude"], deps);
    expect(r.status).toBe("success");
    expect(calls).toEqual(["codex", "codex", "codex"]);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
    expect(r.attempts.at(-1)).toMatchObject({ provider: "codex", retry: 2 });
  });

  it("stops retrying after maxRetries and falls through", async () => {
    const { deps, calls } = setup({ codex: [err("RATE_LIMIT"), err("RATE_LIMIT"), err("RATE_LIMIT")], antigravity: [ok("B")] });
    const r = await runChain(["codex", "antigravity", "claude"], deps);
    expect(calls).toEqual(["codex", "codex", "codex", "antigravity"]);
    expect(r.provider).toBe("antigravity");
  });

  it("does not retry NON_ZERO_EXIT, EMPTY_OUTPUT, PARSE_ERROR or QUOTA", async () => {
    for (const t of ["NON_ZERO_EXIT", "EMPTY_OUTPUT", "PARSE_ERROR", "QUOTA"] as const) {
      const { deps, calls } = setup({ codex: [err(t)], antigravity: [ok()] });
      await runChain(["codex", "antigravity"], deps);
      expect(calls).toEqual(["codex", "antigravity"]);
    }
  });

  it("respects retry.retryOn from config", async () => {
    const { deps, calls } = setup({ codex: [err("TIMEOUT")], antigravity: [ok()] }, { retry: { retryOn: ["RATE_LIMIT"] } });
    await runChain(["codex", "antigravity"], deps);
    expect(calls).toEqual(["codex", "antigravity"]);
  });

  it("skips providers with an open breaker or disabled in config", async () => {
    const { deps, calls, breaker } = setup({ codex: [], antigravity: [ok()] }, { providers: { codex: { enabled: true }, antigravity: { enabled: false } } });
    for (let i = 0; i < 10; i++) breaker.onFailure("codex");
    const r = await runChain(["codex", "antigravity", "claude"], deps);
    expect(calls).toEqual([]);
    expect(r.status).toBe("fallback_to_claude");
    expect(r.attempts.map((a) => a.skipped)).toEqual(["circuit_open", "disabled"]);
  });

  it("opens the breaker after threshold consecutive failures", async () => {
    const { deps } = setup({ codex: [err("NON_ZERO_EXIT"), err("NON_ZERO_EXIT")], antigravity: [] });
    const b = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    deps.breaker = b;
    await runChain(["codex"], deps);
    await runChain(["codex"], deps);
    expect(b.snapshot("codex").state).toBe("open");
    const r = await runChain(["codex", "claude"], deps);
    expect(r.attempts[0]?.skipped).toBe("circuit_open");
  });

  it("returns failed when the chain has no claude entry", async () => {
    const { deps } = setup({ codex: [err("AUTH")], antigravity: [err("AUTH")] });
    const r = await runChain(["codex", "antigravity"], deps);
    expect(r.status).toBe("failed");
  });
});

describe("order, backoff and routing", () => {
  it("puts the explicit provider first", () => {
    expect(resolveOrder(["codex", "antigravity", "claude"], "antigravity")).toEqual(["antigravity", "codex", "claude"]);
    expect(resolveOrder(["codex", "antigravity", "claude"], "antigravity", false)).toEqual(["antigravity"]);
    expect(resolveOrder(["codex", "claude"])).toEqual(["codex", "claude"]);
  });

  it("caps backoff at maxDelayMs", () => {
    const retry = parseConfig({ retry: { baseDelayMs: 1000, factor: 2, maxDelayMs: 3000 } }).retry;
    expect([0, 1, 2, 3].map((a) => backoffDelay(retry, a))).toEqual([1000, 2000, 3000, 3000]);
  });

  it("routes by keyword and explicit taskType", () => {
    const routing = parseConfig({
      routing: { review: "codex", refactor: { provider: "antigravity", keywords: ["refactor", "refactoriza"] } },
    }).routing;
    expect(routeTask("Please review the auth module", routing)).toEqual({ provider: "codex", rule: "review" });
    expect(routeTask("Refactoriza el servicio de pagos", routing)).toEqual({ provider: "antigravity", rule: "refactor" });
    expect(routeTask("write docs", routing)).toBeUndefined();
    expect(routeTask("anything", routing, "refactor")?.provider).toBe("antigravity");
    // Word-start match only: "preview" must not hit "review".
    expect(routeTask("show a preview", routing)).toBeUndefined();
  });
});
