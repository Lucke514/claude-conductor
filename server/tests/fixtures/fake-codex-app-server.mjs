// Fake `codex app-server` (JSON-RPC over stdio), loaded by fake-codex.mjs when FAKE_APPSERVER is set.
//   ok             → agent messages, token usage, turn completed
//   error          → turn failed with codexErrorInfo usageLimitExceeded
//   server-request → asks for a command approval; expects -32601, then completes
//   hang           → turn starts and never ends (interrupt / kill tests)
//   init-error     → initialize fails (exec fallback)
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_APPSERVER;
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const log = (entry) => {
  if (!process.env.FAKE_RPC_LOG) return;
  const prev = globalThis.__rpc ?? [];
  prev.push(entry);
  globalThis.__rpc = prev;
  writeFileSync(process.env.FAKE_RPC_LOG, JSON.stringify(prev));
};
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));

const notify = (method, params) => send({ method, params });

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  log({ id: m.id, method: m.method, params: m.params, error: m.error });
  if (m.method === "initialize") {
    if (mode === "init-error") return send({ id: m.id, error: { code: -32000, message: "initialize not available" } });
    return send({ id: m.id, result: { userAgent: "fake" } });
  }
  if (m.method === "thread/start") return send({ id: m.id, result: { thread: { id: "th-1" }, sandbox: m.params.sandbox } });
  if (m.method === "turn/interrupt") {
    send({ id: m.id, result: {} });
    notify("turn/completed", { threadId: "th-1", turn: { id: "tu-1", status: "interrupted" } });
    return;
  }
  if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "tu-1", status: "inProgress" } } });
    notify("turn/started", { threadId: "th-1", turn: { id: "tu-1" } });
    notify("item/started", { threadId: "th-1", item: { type: "commandExecution", command: "npm test" } });
    if (mode === "hang") return;
    if (mode === "server-request") {
      send({ id: 900, method: "item/commandExecution/requestApproval", params: { threadId: "th-1", command: "rm -rf /" } });
      return;
    }
    if (mode === "error") {
      notify("error", { error: { message: "You've hit your usage limit." } });
      notify("turn/completed", { threadId: "th-1", turn: { id: "tu-1", status: "failed", error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } } });
      return;
    }
    finish();
    return;
  }
  // The answer to our approval request: -32601 expected, then the turn completes.
  if (m.id === 900 && !m.method) finish();
});

function finish() {
  notify("item/completed", { threadId: "th-1", item: { type: "agentMessage", text: "draft", phase: "commentary" } });
  notify("item/completed", { threadId: "th-1", item: { type: "agentMessage", text: "## Summary\nAll good via app-server.", phase: "final_answer" } });
  notify("thread/tokenUsage/updated", {
    threadId: "th-1",
    turnId: "tu-1",
    tokenUsage: { total: { inputTokens: 900, cachedInputTokens: 100, outputTokens: 50, reasoningOutputTokens: 25, totalTokens: 975 }, last: {} },
  });
  notify("turn/completed", { threadId: "th-1", turn: { id: "tu-1", status: "completed" } });
}
