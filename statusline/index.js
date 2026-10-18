#!/usr/bin/env node
/*
 * multi-provider status line for Claude Code. Zero dependencies, CommonJS.
 *
 * Reads the Claude Code status JSON from stdin and the provider metrics from
 * ~/.claude/multi-provider/state.json. It NEVER invokes provider CLIs.
 * Mode (full|compact|off) comes from statusline.mode in
 * ~/.claude/multiprovider.json (or <project>/.claude/multiprovider.json).
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const MP_HOME = process.env.MP_HOME || path.join(HOME, ".claude", "multi-provider");
const USER_CONFIG = process.env.MP_USER_CONFIG || path.join(HOME, ".claude", "multiprovider.json");
const SHORT = { codex: "codex", antigravity: "agy", claude: "claude" };
const PROVIDERS = ["codex", "antigravity"];

const useColor = !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const green = paint("32");
const yellow = paint("33");
const red = paint("31");
const dim = paint("2");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return undefined;
  }
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return "";
    return fs.readFileSync(0, "utf8");
  } catch (_) {
    return "";
  }
}

function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function fmtDuration(ms) {
  if (ms <= 0) return "0s";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
}

function config(projectDir) {
  const project = projectDir ? readJson(path.join(projectDir, ".claude", "multiprovider.json")) : undefined;
  const user = readJson(USER_CONFIG);
  const pick = (k) => (user && user.statusline && user.statusline[k]) || (project && project.statusline && project.statusline[k]);
  const mode = pick("mode");
  return {
    mode: mode === "full" || mode === "off" ? mode : "compact",
    compose: pick("compose"),
    chain: (user && user.chain) || (project && project.chain),
  };
}

/** Classify a provider: ok | cooldown | half_open | degraded | no_auth | not_installed | disabled | unknown. */
function providerStatus(p, now) {
  const health = p.health || {};
  const breaker = p.breaker || {};
  if (health.enabled === false) return { kind: "disabled" };
  if (health.installed === false) return { kind: "not_installed" };
  if (health.auth === "missing") return { kind: "no_auth" };
  if (breaker.state === "open" && breaker.cooldownUntil && breaker.cooldownUntil > now) {
    return { kind: "cooldown", remaining: breaker.cooldownUntil - now };
  }
  if (breaker.state === "open" || breaker.state === "half_open") return { kind: "half_open" };
  const m = p.metrics;
  if (m && m.lastError && Date.now() - Date.parse(m.lastError.at) < 10 * 60 * 1000 && m.lastError.at >= (m.lastCallAt || "")) {
    return { kind: "degraded" };
  }
  if (!p.health && !p.metrics) return { kind: "unknown" };
  return { kind: "ok" };
}

function icon(st) {
  switch (st.kind) {
    case "ok": return green("✓");
    case "cooldown": return yellow(`⏸ ${fmtDuration(st.remaining)}`);
    case "half_open": return yellow("◐");
    case "degraded": return yellow("!");
    case "no_auth": return red("🔒");
    case "not_installed": return red("✗");
    case "disabled": return dim("–");
    default: return dim("?");
  }
}

function label(st) {
  switch (st.kind) {
    case "ok": return green("ok");
    case "cooldown": return yellow(`circuito abierto, ${fmtDuration(st.remaining)} de cooldown`);
    case "half_open": return yellow("probando (half-open)");
    case "degraded": return yellow("degradado");
    case "no_auth": return red("sin auth");
    case "not_installed": return red("no instalado");
    case "disabled": return dim("deshabilitado");
    default: return dim("sin datos");
  }
}

function claudeLine(input) {
  const parts = [];
  const model = input.model && (input.model.display_name || input.model.id);
  if (model) parts.push(model);
  const ctx = input.context_window && input.context_window.used_percentage;
  if (typeof ctx === "number") parts.push(`ctx ${Math.round(ctx)}%`);
  const cost = input.cost && input.cost.total_cost_usd;
  if (typeof cost === "number" && cost > 0) parts.push(`$${cost.toFixed(2)}`);
  const rl = input.rate_limits && input.rate_limits.five_hour;
  if (rl && typeof rl.used_percentage === "number") {
    const pct = Math.round(rl.used_percentage);
    const s = `5h ${pct}%`;
    parts.push(pct >= 90 ? red(s) : pct >= 70 ? yellow(s) : s);
  }
  return parts.join(" · ") || "Claude Code";
}

function composed(cmd, raw) {
  if (!cmd) return undefined;
  try {
    const { spawnSync } = require("child_process");
    // The user's own previously configured status line command (from settings.json).
    const r = spawnSync(cmd, { shell: true, input: raw, encoding: "utf8", timeout: 1000, windowsHide: true });
    const out = (r.stdout || "").replace(/\s+$/, "");
    return out || undefined;
  } catch (_) {
    return undefined;
  }
}

function render(input, raw, state, cfg, now) {
  const base = composed(cfg.compose, raw) || claudeLine(input);
  if (cfg.mode === "off") return base;
  const providers = (state && state.providers) || {};
  const sessions = (state && state.sessions) || {};
  const session = input.session_id ? sessions[input.session_id] : undefined;
  const today = new Date(now).toISOString().slice(0, 10);
  const chain = ((state && state.chain && state.chain.length ? state.chain : cfg.chain) || ["codex", "antigravity", "claude"])
    .map((c) => SHORT[c] || c)
    .join("→");

  const rows = PROVIDERS.map((name) => {
    const p = providers[name] || {};
    const st = providerStatus(p, now);
    const m = p.metrics && p.metrics.day === today ? p.metrics : undefined;
    const sp = session && session.providers && session.providers[name];
    return { name, p, st, m, sp };
  });

  if (cfg.mode === "full") {
    const lines = [base];
    for (const r of rows) {
      const bits = [label(r.st)];
      bits.push(`sesión ${r.sp ? r.sp.calls : 0}`);
      bits.push(`hoy ${r.m ? r.m.callsToday : 0}`);
      const tokens = r.m ? r.m.tokensToday : 0;
      if (tokens) bits.push(`${fmtTokens(tokens)} tok`);
      if (r.m && r.m.durationMsToday) bits.push(fmtDuration(r.m.durationMsToday));
      const le = r.p.metrics && r.p.metrics.lastError;
      if (le) bits.push(dim(`último error ${le.type}`));
      lines.push(`${SHORT[r.name].padEnd(6)} ${icon(r.st)} ${bits.join(" · ")}`);
    }
    lines.push(dim(`cadena ${chain}`));
    return lines.join("\n");
  }

  // compact
  const segs = rows.map((r) => {
    let s = `${SHORT[r.name]} ${icon(r.st)}`;
    if (r.st.kind === "ok" || r.st.kind === "degraded") {
      const calls = r.sp ? r.sp.calls : r.m ? r.m.callsToday : 0;
      if (calls) s += ` ${calls}`;
      const tokens = r.sp ? r.sp.tokens : r.m ? r.m.tokensToday : 0;
      if (tokens) s += ` · ${fmtTokens(tokens)}`;
    }
    return s;
  });
  return [base, ...segs, dim(chain)].join(" │ ");
}

function main() {
  const raw = readStdin();
  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch (_) {
    input = {};
  }
  const projectDir = (input.workspace && (input.workspace.project_dir || input.workspace.current_dir)) || input.cwd;
  const cfg = config(projectDir);
  const state = cfg.mode === "off" ? undefined : readJson(path.join(MP_HOME, "state.json"));
  process.stdout.write(`${render(input, raw, state, cfg, Date.now())}\n`);
}

module.exports = { render, providerStatus, fmtTokens, fmtDuration, claudeLine };

if (require.main === module) main();
