#!/usr/bin/env node
// Fake `agy` CLI for tests. Behaviour selected with FAKE_MODE.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "success";

if (args[0] === "--version") {
  process.stdout.write("1.3.6\n");
  process.exit(0);
}
if (args[0] === "--help") {
  // An old agy (FAKE_AGY_HELP=old) lists neither flag the defaults rely on.
  process.stdout.write(process.env.FAKE_AGY_HELP === "old" ? "Usage: agy -p <prompt>\n" : "  --dangerously-skip-permissions  Auto-approve\n  --output-format  (text, json, stream-json)\n");
  process.exit(0);
}
if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, tty: !!process.stdout.isTTY }));

const pIdx = args.indexOf("-p");
const prompt = pIdx >= 0 ? args[pIdx + 1] : undefined;
if (!prompt) {
  process.stderr.write("usage error\n");
  process.exit(2);
}

const fmtIdx = args.indexOf("--output-format");
const stream = fmtIdx >= 0 && args[fmtIdx + 1] === "stream-json";
const ev = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
/** The final answer as agy prints it: plain text, or stream-json events when asked for them. */
const say = (text) => {
  if (!stream) return process.stdout.write(text);
  ev({ event: "init", conversation_id: "c1", init: { cwd: process.cwd(), tools: ["run_command"], permission_mode: "request-review" } });
  ev({ event: "step_update", step_update: { conversation_id: "c1", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: text } });
  ev({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: text, usage: { input_tokens: 40, output_tokens: 6, thinking_tokens: 2, cache_read_tokens: 10 } } });
};

if (stream && mode === "unknown-flag") {
  process.stderr.write("error: unknown flag: --output-format\n");
  process.exit(2);
}

switch (mode) {
  case "unknown-flag":
    process.stdout.write("text answer\n");
    process.exit(0);
    break;
  case "stream-fixture":
    process.stdout.write(readFileSync(new URL("./agy-stream.jsonl", import.meta.url), "utf8"));
    process.exit(0);
    break;
  case "stream-permission":
    // A step that waits for the user's approval, as a headless run cannot give it.
    ev({ event: "init", conversation_id: "c2", init: { cwd: process.cwd(), tools: ["run_command"], permission_mode: "request-review" } });
    ev({ event: "step_update", step_update: { conversation_id: "c2", step_index: 2, state: "WAITING", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "npm test" } }, requires_approval: true } });
    setInterval(() => {}, 1000);
    break;
  case "success":
    if (stream) {
      say("## Summary\nLooks fine.\n");
      process.exit(0);
    }
    // Colored, with a spinner overwritten by \r.
    process.stdout.write("\u001b[2K⠋ thinking\r\u001b[32m## Summary\u001b[0m\nLooks fine.\n");
    process.exit(0);
    break;
  case "json":
    process.stderr.write("progress...\n");
    process.stdout.write(JSON.stringify({ conversation_id: "c1", status: "SUCCESS", response: "json answer", usage: { input_tokens: 50, output_tokens: 7 } }) + "\n");
    process.exit(0);
    break;
  case "needs-tty":
    // Simulates the old bug: hang forever when not attached to a TTY.
    if (!process.stdout.isTTY) setInterval(() => {}, 1000);
    else {
      process.stdout.write("tty ok\n");
      process.exit(0);
    }
    break;
  case "write":
    writeFileSync(path.join(process.cwd(), "agy-file.txt"), "agy was here\n");
    say("done\n");
    process.exit(0);
    break;
  case "timeout": {
    const g = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 600000)"], { stdio: "ignore" });
    if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(g.pid));
    setInterval(() => {}, 1000);
    break;
  }
  case "auth":
    process.stderr.write("Error: authentication required\n");
    process.exit(1);
    break;
  case "ratelimit":
    process.stderr.write("Error: 429 RESOURCE_EXHAUSTED rate limit\n");
    process.exit(1);
    break;
  case "empty":
    process.exit(0);
    break;
  case "longprompt":
    say(`prompt arg length ${prompt.length}\n`);
    process.exit(0);
    break;
  default:
    process.exit(99);
}
