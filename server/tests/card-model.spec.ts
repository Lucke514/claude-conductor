import { describe, expect, it } from "vitest";
import { bar, buildCard, ctxBar, fmtClock, fmtCost, fmtDuration, fmtTokens, outcomeOf, parseTasks, parseVerdict, pickActiveSpec, prettyModel, providerView, sparkline, specProgress } from "../../hooks/conductor/model.js";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const TODAY = "2026-10-18";
const ok = { health: { installed: true, enabled: true, auth: "ok" }, breaker: { state: "closed", consecutiveFailures: 0, cooldownUntil: null } };

describe("conductor card model", () => {
  it("formats numbers, durations and bars", () => {
    expect([fmtTokens(0), fmtTokens(950), fmtTokens(1500), fmtTokens(12_000), fmtTokens(2_300_000)]).toEqual(["0", "950", "1.5k", "12k", "2.3M"]);
    expect([fmtDuration(42_000), fmtDuration(102_000), fmtDuration(120_000), fmtDuration(3_900_000)]).toEqual(["42s", "1m42s", "2m", "1h5m"]);
    expect(fmtClock(134_000)).toBe("02:14");
    expect(bar(3, 10)).toBe("▮▮▮▯▯▯▯▯▯▯");
    expect(bar(5, 0)).toBe("▯".repeat(10));
  });

  it("sparkline scales the last calls and draws failures low", () => {
    expect(sparkline(undefined)).toBe("");
    const s = sparkline([
      { at: "a", ok: true, tokens: 1000, durationMs: 1 },
      { at: "b", ok: false, tokens: 0, durationMs: 1 },
      { at: "c", ok: true, tokens: 8000, durationMs: 1 },
    ]);
    expect(s).toHaveLength(3);
    expect(s[1]).toBe("▁");
    expect(s[2]).toBe("█");
  });

  it.each([
    [{ ...ok, metrics: { day: TODAY, callsToday: 2 } }, "ok", "● afinado"],
    [ok, "ok", "● listo"],
    [{ ...ok, breaker: { state: "open", consecutiveFailures: 3, cooldownUntil: NOW + 120_000 } }, "cooldown", "◐ silencio 2m"],
    [{ ...ok, breaker: { state: "open", consecutiveFailures: 3, cooldownUntil: NOW - 1 } }, "half_open", "◐ probando"],
    [{ health: { installed: true, enabled: true, auth: "missing" } }, "no_auth", "⊘ sin auth"],
    [{ health: { installed: false, enabled: true } }, "not_installed", "✗ no instalado"],
    [{ health: { installed: true, enabled: false } }, "disabled", "– deshabilitado"],
    [undefined, "unknown", "· sin datos"],
    [{ ...ok, metrics: { day: TODAY, callsToday: 1, lastError: { type: "TIMEOUT", at: "2026-10-18T11:57:00Z" }, lastCallAt: "2026-10-18T11:57:00Z" } }, "degraded", "! inestable"],
  ] as const)("provider status %#", (p, kind, badge) => {
    const v = providerView("codex", p as never, NOW, TODAY);
    expect(v.kind).toBe(kind);
    expect(v.badge).toBe(badge);
  });

  it("gives blocking states the command that fixes them", () => {
    expect(providerView("codex", { health: { installed: true, auth: "missing" } }, NOW, TODAY).fix).toBe("ejecuta codex login");
    expect(providerView("antigravity", { health: { installed: false } }, NOW, TODAY).fix).toMatch(/Antigravity/);
  });

  it("picks the card kind", () => {
    const base = { chain: ["codex", "antigravity", "claude"] };
    expect(buildCard({ state: { ...base, providers: { codex: ok, antigravity: ok } }, now: NOW }).kind).toBe("first_use");
    expect(
      buildCard({ state: { ...base, providers: { codex: { health: { installed: false } }, antigravity: { health: { installed: false } } } }, now: NOW }).kind,
    ).toBe("claude_only");
    expect(buildCard({ state: { ...base, providers: { codex: { health: { installed: true, auth: "missing" } }, antigravity: ok } }, now: NOW }).kind).toBe("degraded");
    const running = buildCard({
      state: { ...base, providers: { codex: ok, antigravity: ok } },
      now: NOW,
      running: { provider: "codex", mode: "write", task: "x", startedAt: NOW - 42_000 },
      tick: 2,
    });
    expect(running.kind).toBe("running");
    expect(running.running).toMatchObject({ provider: "codex", elapsed: "00:42", spinner: "⠹" });
    expect(running.border).toBe("#E0A85A");
  });

  it("strikes unavailable providers in the chain", () => {
    const v = buildCard({ state: { chain: ["codex", "antigravity", "claude"], providers: { codex: { health: { installed: false } }, antigravity: ok } }, now: NOW });
    expect(v.chain).toEqual([
      { name: "codex", struck: true },
      { name: "agy", struck: false },
      { name: "claude", struck: false },
    ]);
  });

  it("summarises the session, else the day", () => {
    const state = { providers: { codex: { ...ok, metrics: { day: TODAY, callsToday: 9, tokensToday: 20_000 } } } };
    expect(buildCard({ state, now: NOW }).summary).toBe("hoy 9 delegaciones · 20k tok");
    expect(buildCard({ state, now: NOW, session: { calls: 1, tokens: 1500 } }).summary).toBe("sesión 1 delegación · 1.5k tok");
  });

  it("shows verdicts over raw status and labels fallbacks", () => {
    const r = { id: "20261018115600-abc123", at: "2026-10-18T11:56:00Z", provider: "codex", mode: "write", status: "success", task: "t", filesChanged: 2 };
    expect(outcomeOf(r).text).toBe("◇ diff 2 archivos");
    expect(outcomeOf(r, "ACCEPT")).toEqual({ text: "✓ ACCEPT", tone: "ok" });
    expect(outcomeOf({ ...r, status: "fallback_to_claude" }).text).toBe("↪ fallback");
    const card = buildCard({ state: { recent: [{ ...r, provider: null, requested: "antigravity" }] }, now: NOW, verdicts: {} });
    expect(card.recent[0]?.who).toBe("agy→claude");
    expect(card.last?.ago).toBe("hace 4m");
  });

  it("parses worker verdicts", () => {
    expect(parseVerdict("...\nVERDICT: REQUEST_CHANGES\ndelegation: 20261018115600-abc123\n")).toEqual({ verdict: "REQUEST_CHANGES", id: "20261018115600-abc123" });
    expect(parseVerdict("VERDICT: ACCEPT | REQUEST_CHANGES | DISCARD")).toEqual({ verdict: "ACCEPT" });
    expect(parseVerdict("no verdict here")).toBeUndefined();
  });

  const TASKS = [
    "> Status: approved",
    "## T1 — Parse",
    "- [x] Done",
    "- **Owner**: —",
    "## T2 [P] — Gate",
    "- [ ] Done",
    "- **Owner**: codex (multi-provider) since 2026-10-18",
    "## T3 [P] — Docs",
    "- [ ] Done",
    "- **Owner**: —",
    "## G1 — Fix gap",
    "- [~] Waived — 2026-10-18, not worth it",
    "- **Owner**: —",
  ].join("\n");

  it("parses spec-driven tasks: ids, boxes and owners", () => {
    const { status, tasks } = parseTasks(TASKS);
    expect(status).toBe("approved");
    expect(tasks.map((t) => `${t.id}${t.box}`)).toEqual(["T1x", "T2 ", "T3 ", "G1~"]);
    expect(tasks[1]?.owner).toBe("codex (multi-provider) since 2026-10-18");
  });

  it("reports progress with the claimed task first, waived counting as closed", () => {
    const p = specProgress("demo", TASKS);
    expect(p).toMatchObject({ slug: "demo", status: "approved", done: 2, total: 4 });
    expect(p.current).toMatchObject({ id: "T2", state: "en curso" });
    const unclaimed = specProgress("demo", TASKS.replace("codex (multi-provider) since 2026-10-18", "—"));
    expect(unclaimed.current).toMatchObject({ id: "T2", state: "siguiente" });
  });

  it("picks the active spec: claimed work first, then approved with open tasks", () => {
    const draft = specProgress("a", TASKS.replace("approved", "draft").replace("codex (multi-provider) since 2026-10-18", "—"));
    const ready = specProgress("b", TASKS.replace("codex (multi-provider) since 2026-10-18", "—"));
    const busy = specProgress("c", TASKS);
    expect(pickActiveSpec([draft, ready, busy])?.slug).toBe("c");
    expect(pickActiveSpec([draft, ready])?.slug).toBe("b");
    expect(pickActiveSpec([draft])).toBeUndefined();
  });

  it("formats the session header figures", () => {
    expect(ctxBar(42)).toBe("━━━━──────");
    expect(ctxBar(undefined)).toBe("──────────");
    expect(ctxBar(130, 4)).toBe("━━━━");
    expect(fmtCost(0.5)).toBe("$0.50");
    expect(fmtCost(undefined)).toBe("");
  });

  it("shows model ids by family and version", () => {
    expect(prettyModel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(prettyModel("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(prettyModel("claude-haiku-5-5-20261001")).toBe("Haiku 5.5");
    expect(prettyModel("Opus 5.5")).toBe("Opus 5.5");
    expect(prettyModel("gpt-5")).toBe("gpt-5");
    expect(prettyModel(undefined)).toBeUndefined();
  });
});
