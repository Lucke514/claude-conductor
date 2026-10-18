import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("CircuitBreaker", () => {
  it("opens after N consecutive failures and rejects during cooldown", () => {
    const c = clock();
    const b = new CircuitBreaker({ threshold: 3, cooldownMs: 1000, now: c.now });
    b.onFailure("codex");
    b.onFailure("codex");
    expect(b.canRequest("codex")).toBe(true);
    b.onFailure("codex");
    expect(b.snapshot("codex").state).toBe("open");
    expect(b.canRequest("codex")).toBe(false);
    expect(b.remainingCooldownMs("codex")).toBe(1000);
    c.advance(400);
    expect(b.remainingCooldownMs("codex")).toBe(600);
  });

  it("success resets the counter", () => {
    const b = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    b.onFailure("codex");
    b.onSuccess("codex");
    b.onFailure("codex");
    expect(b.snapshot("codex").state).toBe("closed");
  });

  it("half-open after cooldown: success closes, failure re-opens", () => {
    const c = clock();
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 100, now: c.now });
    b.onFailure("agy");
    expect(b.canRequest("agy")).toBe(false);
    c.advance(100);
    expect(b.snapshot("agy").state).toBe("half_open");
    expect(b.canRequest("agy")).toBe(true);
    b.onFailure("agy");
    expect(b.snapshot("agy").state).toBe("open");
    c.advance(100);
    expect(b.canRequest("agy")).toBe(true);
    b.onSuccess("agy");
    expect(b.snapshot("agy")).toEqual({ state: "closed", consecutiveFailures: 0, openedAt: null, cooldownUntil: null });
  });

  it("is independent per provider and loads persisted snapshots", () => {
    const c = clock();
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 500, now: c.now });
    b.load("codex", { state: "open", consecutiveFailures: 4, openedAt: c.now(), cooldownUntil: c.now() + 500 });
    expect(b.canRequest("codex")).toBe(false);
    expect(b.canRequest("antigravity")).toBe(true);
  });
});
