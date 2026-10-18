#!/usr/bin/env node
// Fake `agy` CLI for tests. Behaviour selected with FAKE_MODE.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "success";

if (args[0] === "--version") {
  process.stdout.write("1.3.6\n");
  process.exit(0);
}
if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, tty: !!process.stdout.isTTY }));

const pIdx = args.indexOf("-p");
const prompt = pIdx >= 0 ? args[pIdx + 1] : undefined;
if (!prompt) {
  process.stderr.write("usage error\n");
  process.exit(2);
}

switch (mode) {
  case "success":
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
    process.stdout.write("done\n");
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
    process.stdout.write(`prompt arg length ${prompt.length}\n`);
    process.exit(0);
    break;
  default:
    process.exit(99);
}
