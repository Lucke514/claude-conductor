import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tmpDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "..", "statusline", "index.js");
const sl = createRequire(import.meta.url)(SCRIPT) as {
  render: (input: object, raw: string, state: object | undefined, cfg: object, now: number) => string;
};

const NOW = Date.parse("2026-10-18T12:00:00Z");
const input = {
  session_id: "sess-1",
  model: { id: "claude-opus-5-5", display_name: "Opus" },
  context_window: { used_percentage: 42 },
  cost: { total_cost_usd: 0.5 },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1 } },
};
const state = {
  version: 1,
  chain: ["codex", "antigravity", "claude"],
  providers: {
    codex: {
      health: { installed: true, enabled: true, auth: "ok", checkedAt: "x" },
      breaker: { state: "closed", consecutiveFailures: 0, openedAt: null, cooldownUntil: null },
      metrics: { day: "2026-10-18", callsToday: 5, tokensToday: 12_000, durationMsToday: 90_000, lastError: null, lastCallAt: "2026-10-18T11:00:00Z" },
    },
    antigravity: {
      health: { installed: true, enabled: true, auth: "unknown", checkedAt: "x" },
      breaker: { state: "open", consecutiveFailures: 3, openedAt: NOW - 1000, cooldownUntil: NOW + 120_000 },
    },
  },
  sessions: { "sess-1": { lastAt: "x", providers: { codex: { calls: 3, tokens: 12_000, durationMs: 1 } } } },
};
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("status line", () => {
  it("compact mode matches the documented shape", () => {
    expect(strip(sl.render(input, "", state, { mode: "compact" }, NOW))).toBe(
      "Opus · ctx 42% · $0.50 · 5h 24% │ codex ✓ 3 · 12k │ agy ⏸ 2m │ codex→agy→claude",
    );
  });

  it("full mode prints one line per provider", () => {
    const lines = strip(sl.render(input, "", state, { mode: "full" }, NOW)).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^codex\s+✓ ok · sesión 3 · hoy 5 · 12k tok · 2m/);
    expect(lines[2]).toMatch(/^agy\s+⏸ 2m circuito abierto/);
    expect(lines[3]).toBe("cadena codex→agy→claude");
  });

  it("off mode prints only the Claude line", () => {
    expect(strip(sl.render(input, "", state, { mode: "off" }, NOW))).toBe("Opus · ctx 42% · $0.50 · 5h 24%");
  });

  it("shows not installed / no auth in red", () => {
    const s = {
      providers: {
        codex: { health: { installed: false, enabled: true, auth: "unknown" } },
        antigravity: { health: { installed: true, enabled: true, auth: "missing" } },
      },
      sessions: {},
    };
    const out = sl.render({}, "", s, { mode: "compact" }, NOW);
    expect(out).toContain("\u001b[31m✗\u001b[0m");
    expect(out).toContain("\u001b[31m🔒\u001b[0m");
  });

  it("composes with a previous status line command", () => {
    const out = strip(sl.render(input, "{}", state, { mode: "compact", compose: "echo previous-line" }, NOW));
    expect(out.startsWith("previous-line │ codex")).toBe(true);
  });

  it("runs as a process in well under 100ms and tolerates missing state", () => {
    const home = tmpDir();
    mkdirSync(path.join(home, "mp"), { recursive: true });
    writeFileSync(path.join(home, "mp", "state.json"), JSON.stringify(state));
    const env = { ...process.env, MP_HOME: path.join(home, "mp"), MP_USER_CONFIG: path.join(home, "none.json") };
    // Warm-up, then measure.
    spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(input), env });
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(input), env, encoding: "utf8" });
    const ms = performance.now() - t0;
    expect(r.status).toBe(0);
    expect(strip(r.stdout)).toContain("codex ✓");
    expect(ms).toBeLessThan(100);
    const empty = spawnSync(process.execPath, [SCRIPT], { input: "garbage", env: { ...env, MP_HOME: path.join(home, "nope") }, encoding: "utf8" });
    expect(empty.status).toBe(0);
    expect(strip(empty.stdout)).toContain("Claude Code");
  });
});
