#!/usr/bin/env node
// Fake `codex` CLI for tests. Behaviour selected with FAKE_MODE.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "success";
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (args[0] === "--version") {
  process.stdout.write("codex-cli 9.9.9\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (process.env.FAKE_AUTH === "missing") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stderr.write("Logged in using ChatGPT\n");
  process.exit(0);
}

if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
const cdIdx = args.indexOf("-C");
const cwd = cdIdx >= 0 ? args[cdIdx + 1] : process.cwd();

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_PROMPT_FILE) writeFileSync(process.env.FAKE_PROMPT_FILE, stdin);
  process.stderr.write("Reading prompt from stdin...\n");
  out({ type: "thread.started", thread_id: "t-1" });
  out({ type: "turn.started" });
  switch (mode) {
    case "success":
      out({ type: "item.completed", item: { id: "i1", type: "reasoning", text: "thinking" } });
      out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "## Summary\nAll good." } });
      out({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 300 } });
      process.exit(0);
      break;
    case "write":
    case "commit": {
      writeFileSync(path.join(cwd, "added-by-worker.txt"), "hello from worker\n");
      if (mode === "commit") {
        // Bypass hooks like a misbehaving worker would.
        execFileSync("git", ["add", "-A"], { cwd });
        execFileSync("git", ["-c", "user.name=w", "-c", "user.email=w@x", "commit", "--no-verify", "-qm", "worker commit"], { cwd });
      }
      out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "## Changes\nadded file" } });
      out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
      process.exit(0);
      break;
    }
    case "hang-write": {
      // Writes a file, reports progress, then never finishes (cancellation tests).
      writeFileSync(path.join(cwd, "added-by-worker.txt"), "partial work\n");
      if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
      out({ type: "item.completed", item: { id: "i1", type: "reasoning", text: "working" } });
      setInterval(() => {}, 1000);
      break;
    }
    case "stall": {
      // Reports once, then goes silent without touching any file (idle / total timeout tests).
      out({ type: "item.completed", item: { id: "i1", type: "reasoning", text: "thinking" } });
      setInterval(() => {}, 1000);
      break;
    }
    case "probe": {
      // Behaves like a worker trying to publish: dumps its env, runs gh, pushes past the hooks.
      const run = (cmd, a) => {
        const r = spawnSync(cmd, a, { cwd, encoding: "utf8", shell: process.platform === "win32" && cmd === "gh", timeout: 20000 });
        return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
      };
      for (const f of (process.env.FAKE_WRITE_FILE ?? "").split(",").filter(Boolean)) {
        execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(require("path").dirname(${JSON.stringify(f)}),{recursive:true})`], { cwd });
        writeFileSync(path.join(cwd, f), "from worker\n");
      }
      const probe = {
        env: process.env,
        credentialHelper: run("git", ["config", "--get", "credential.helper"]),
        gh: run("gh", ["pr", "create", "--fill"]),
        push: process.env.FAKE_PUSH ? run("git", ["push", "--no-verify", process.env.FAKE_PUSH, "HEAD"]) : null,
      };
      if (process.env.FAKE_PROBE_FILE) writeFileSync(process.env.FAKE_PROBE_FILE, JSON.stringify(probe));
      out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: process.env.FAKE_MESSAGE ?? "## Summary\nprobed" } });
      out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
      process.exit(0);
      break;
    }
    case "message": {
      // Writes FAKE_WRITE_FILE (if set) and answers with FAKE_MESSAGE.
      if (process.env.FAKE_WRITE_FILE) writeFileSync(path.join(cwd, process.env.FAKE_WRITE_FILE), "from worker\n");
      out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: process.env.FAKE_MESSAGE ?? "" } });
      out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
      process.exit(0);
      break;
    }
    case "try-commit": {
      writeFileSync(path.join(cwd, "added-by-worker.txt"), "hello\n");
      let blocked = false;
      try {
        execFileSync("git", ["add", "-A"], { cwd });
        execFileSync("git", ["-c", "user.name=w", "-c", "user.email=w@x", "commit", "-qm", "worker commit"], { cwd, stdio: "pipe" });
      } catch {
        blocked = true;
      }
      out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: blocked ? "commit blocked" : "commit succeeded" } });
      process.exit(0);
      break;
    }
    case "timeout": {
      // Spawn a grandchild to verify the whole tree gets killed.
      const g = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 600000)"], { stdio: "ignore" });
      if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(g.pid));
      setTimeout(() => {}, 600000);
      break;
    }
    case "auth":
      out({ type: "error", message: "unexpected status 401 Unauthorized: Not logged in" });
      out({ type: "turn.failed", error: { message: "401 Unauthorized" } });
      process.exit(1);
      break;
    case "ratelimit":
      out({ type: "error", message: "exceeded retry limit, last status: 429 Too Many Requests" });
      out({ type: "turn.failed", error: { message: "rate limit exceeded" } });
      process.exit(1);
      break;
    case "quota":
      out({ type: "error", message: "You’ve hit your usage limit. Upgrade to Plus to continue." });
      process.exit(1);
      break;
    case "empty":
      out({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0 } });
      process.exit(0);
      break;
    case "garbage":
      process.stdout.write("this is not json at all\n");
      process.exit(0);
      break;
    case "crash":
      process.stderr.write("panic: something broke\n");
      process.exit(3);
      break;
    default:
      process.exit(99);
  }
});
