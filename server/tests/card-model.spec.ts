import { describe, expect, it } from "vitest";
import { runningFromJobs, bar, buildCard, ctxBar, fmtClock, fmtCost, fmtDuration, fmtTokens, outcomeOf, ownerProvider, parseTasks, parseVerdict, pickActiveSpec, pipelineView, prettyModel, providerView, rateLimitText, rateLimitView, sparkline, specProgress } from "../../hooks/conductor/model.js";

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
    // provider-reliability R7: one attributable failure is not "unstable"; two in a row are.
    [{ ...ok, breaker: { state: "closed", consecutiveFailures: 1 }, metrics: { day: TODAY, callsToday: 1, lastError: { type: "TIMEOUT", at: "2026-10-18T11:57:00Z" }, lastCallAt: "2026-10-18T11:57:00Z" } }, "ok", "● afinado"],
    [{ ...ok, breaker: { state: "closed", consecutiveFailures: 2 }, metrics: { day: TODAY, callsToday: 2, lastError: { type: "TIMEOUT", at: "2026-10-18T11:57:00Z" }, lastCallAt: "2026-10-18T11:57:00Z" } }, "degraded", "! inestable"],
    [{ ...ok, breaker: { state: "closed", consecutiveFailures: 0 }, metrics: { day: TODAY, callsToday: 1, lastNotice: { type: "CANCELLED", at: "2026-10-18T11:59:00Z" }, lastCallAt: "2026-10-18T11:59:00Z" } }, "ok", "● afinado"],
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

  it("R4: verifying keeps the active card and exposes the command and clock", () => {
    const state = { jobs: [{ id: "j", provider: "codex", mode: "write", task: "t",
      phase: "verifying", detail: "npm test", startedAt: new Date(NOW - 42000).toISOString() }] };
    const view = buildCard({ state, now: NOW, running: runningFromJobs(state) });
    expect(view.kind).toBe("running");
    expect(view.border).toBe("#E0A85A");
    expect(view.running).toMatchObject({ phase: "verifying", detail: "npm test", elapsed: "00:42" });
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

describe("rate-limit windows", () => {
  it("R9: labels, bar, percent and time to reset", () => {
    const views = rateLimitView(
      [
        { kind: "five_hour", percentUsed: 42, resetsAt: new Date(NOW + 130 * 60_000).toISOString() },
        { kind: "seven_day", percentUsed: 18.5 },
      ],
      NOW,
    );
    expect(views.map(rateLimitText)).toEqual(["5h ▮▮▮▯▯▯ 42% · 2h10m", "7d ▮▯▯▯▯▯ 18.5%"]);
    expect(views.map((v) => v.tone)).toEqual(["text", "text"]);
  });

  it("R9: warn from 80%, error from 95%", () => {
    const tones = rateLimitView([79.9, 80, 94.9, 95].map((percentUsed) => ({ kind: "five_hour", percentUsed })), NOW).map((v) => v.tone);
    expect(tones).toEqual(["text", "warn", "warn", "error"]);
  });

  it("E12: no windows → nothing to draw", () => {
    expect(rateLimitView([], NOW)).toEqual([]);
    expect(rateLimitView(undefined, NOW)).toEqual([]);
  });

  it("E13: no resetsAt, an exceeded spend limit and an unknown kind", () => {
    const [spend, other] = rateLimitView([{ kind: "spend_limit", percentUsed: 112 }, { kind: "monthly", percentUsed: 3, resetsAt: "not a date" }], NOW);
    expect(rateLimitText(spend!)).toBe("gasto ▮▮▮▮▮▮ 112%");
    expect(spend!.tone).toBe("error");
    expect(rateLimitText(other!)).toBe("monthly ▯▯▯▯▯▯ 3%");
  });
});

describe("SDD pipeline lines", () => {
  const f = (slug: string, stage: string, warnings = 0) => ({ slug, stage, closed: 3, total: 8, warnings, nextStep: "" });

  it("R7: at most 3 features in Implementación/Verificación, with the live task and warnings", () => {
    const features = [f("a", "Implementación"), f("b", "Cerrada"), f("c", "Verificación", 1), f("d", "Implementación"), f("e", "Implementación")];
    const running = { provider: "antigravity", mode: "write", task: "a T4", startedAt: NOW, slug: "a", taskId: "T4" };
    const lines = pipelineView(features, running);
    expect(lines.map((l) => l.text)).toEqual(["a ▸ Impl 3/8 · agy T4 ⏳", "c ▸ Verif 3/8 · ⚠ 1", "d ▸ Impl 3/8"]);
    expect(lines.map((l) => [l.running, l.warn])).toEqual([[true, false], [false, true], [false, false]]);
  });

  it("E3: no active feature → no lines; a plain delegate does not mark a feature", () => {
    expect(pipelineView([f("b", "Cerrada"), f("s", "Spec")], null)).toEqual([]);
    expect(pipelineView([f("a", "Implementación")], { provider: "codex", mode: "read", task: "x", startedAt: NOW })[0]!.running).toBe(false);
  });

  it("R7: a long line shortens the slug and keeps stage, task and warnings", () => {
    const running = { provider: "codex", mode: "write", task: "", startedAt: NOW, slug: "sdd-traceability", taskId: "T6" };
    const [line] = pipelineView([{ slug: "sdd-traceability", stage: "Implementación", closed: 5, total: 7, warnings: 1, nextStep: "" }], running);
    expect(line!.text).toBe("sdd-traceabil… ▸ Impl 5/7 · codex T6 ⏳ · ⚠ 1");
    expect(line!.text.length).toBeLessThanOrEqual(44);
  });

  it("ownerProvider reads the worker from a claim", () => {
    expect(ownerProvider("codex (multi-provider) since 2026-10-18")).toBe("codex");
    expect(ownerProvider("antigravity (multi-provider) since 2026-10-18")).toBe("antigravity");
    expect(ownerProvider("claude (sesión principal)")).toBeUndefined();
    expect(ownerProvider(null)).toBeUndefined();
  });
});

describe("provider-reliability R7: honest health", () => {
  it("a notice shows as a dim detail, never as unstable", () => {
    const v = providerView("antigravity", { health: { installed: true, enabled: true, auth: "ok" }, breaker: { consecutiveFailures: 0 }, metrics: { day: TODAY, callsToday: 1, lastNotice: { type: "STALLED", at: "2026-10-18T11:59:00Z" }, lastCallAt: "2026-10-18T11:59:00Z" } } as never, NOW, TODAY);
    expect(v.kind).toBe("ok");
    expect(v.detail).toContain("aviso STALLED");
  });
});

describe("delegation-lifecycle: pending diffs on the card", () => {
  it("shows nothing without pending diffs, a dim line under 7 days and a warning from 7 days on", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(buildCard({ state: {}, now }).pending).toBeUndefined();
    expect(buildCard({ state: { pending: { count: 0, oldestDays: 0, at: "" } }, now }).pending).toBeUndefined();
    expect(buildCard({ state: { pending: { count: 1, oldestDays: 2, at: "" } }, now }).pending).toEqual({ text: "1 diff pendiente de revisar o descartar", tone: "dim" });
    expect(buildCard({ state: { pending: { count: 2, oldestDays: 9, at: "" } }, now }).pending).toEqual({ text: "⚠ 2 diffs pendientes · el más antiguo de hace 9 días", tone: "warn" });
  });
});
