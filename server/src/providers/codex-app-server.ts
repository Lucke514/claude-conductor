import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { effectiveErrorPatterns, type ProviderConfig } from "../config.js";
import { classifyFailure, excerpt } from "../fallback.js";
import { buildChildEnv, killTree, resolveCommand } from "../process.js";
import type { ErrorType, ProviderRequest, ProviderResult, TokenUsage } from "./types.js";

/**
 * Codex through `codex app-server`: JSON-RPC 2.0 over stdio, one line per message.
 * The same protocol the official `openai-codex` plugin speaks:
 *
 *   initialize → initialized → thread/start { cwd, sandbox, approvalPolicy: "never", ephemeral }
 *   → turn/start { threadId, input } → notifications until turn/completed
 *
 * Every request the server makes of us (approvals, user input) is answered
 * -32601: a delegated worker never asks anyone anything. Cancelling sends
 * turn/interrupt, then kills the process tree.
 */

const INIT_TIMEOUT_MS = 15_000;
const INTERRUPT_GRACE_MS = 5_000;
/**
 * Notifications we never subscribe away: streaming deltas (command output, reasoning) are
 * what keeps the idle clock alive during a long, productive step. Their payloads are ignored.
 */
const OPT_OUT: string[] = [];

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

interface Item {
  type?: string;
  text?: string;
  phase?: string | null;
  command?: string;
  path?: string;
}

/** The app-server could not be used at all: the caller falls back to `codex exec` (E1). */
export class TransportUnavailable extends Error {}

/** codexErrorInfo (camelCase enum in the protocol) → our error types. */
const ERROR_INFO: Record<string, ErrorType> = {
  unauthorized: "AUTH",
  usageLimitExceeded: "QUOTA",
  sessionBudgetExceeded: "QUOTA",
  rateLimitExceeded: "RATE_LIMIT",
};

export function progressFromItem(item: Item): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return item.command ? `command: ${item.command}` : "command";
    case "fileChange":
      return "file change";
    case "agentMessage":
      return item.phase === "final_answer" ? "final answer" : "agent message";
    case "reasoning":
      return "reasoning";
    default:
      return item.type;
  }
}

export async function runAppServer(cfg: ProviderConfig, req: ProviderRequest, bin: string): Promise<ProviderResult> {
  const resolved = resolveCommand(bin);
  if (!resolved) throw new TransportUnavailable(`binary not found in PATH: ${bin}`);
  const started = Date.now();
  const model = req.model ?? cfg.model;
  let child: ChildProcess;
  try {
    child = spawn(resolved.command, [...resolved.prefixArgs, "app-server", ...cfg.extraArgs], {
      cwd: req.cwd,
      env: buildChildEnv({ NO_COLOR: "1", ...req.env }),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    throw new TransportUnavailable((err as Error).message);
  }

  let nextId = 1;
  const pending = new Map<number, { resolve: (m: RpcMessage) => void }>();
  let stderr = "";
  let exited = false;
  let exitCode: number | null = null;
  // A closed pipe (the app-server died) must not crash the MCP server: fail what is pending instead.
  child.stdin?.on("error", (err: Error) => {
    for (const p of pending.values()) p.resolve({ error: { code: -1, message: `app-server input failed: ${err.message}` } });
    pending.clear();
    turnDone?.("failed", { message: `app-server input failed: ${err.message}` });
  });
  const send = (m: RpcMessage) => {
    if (!child.stdin?.destroyed) child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  };
  const request = (method: string, params: Record<string, unknown>, timeoutMs?: number) =>
    new Promise<RpcMessage>((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve });
      send({ id, method, params });
      if (timeoutMs) setTimeout(() => pending.get(id) && (pending.delete(id), resolve({ error: { code: -1, message: `${method} timed out` } })), timeoutMs).unref();
    });

  // Turn state, filled by notifications.
  let finalMessage = "";
  let lastMessage = "";
  let usage: TokenUsage | undefined;
  let turnDone: ((status: string, error?: { message?: string; codexErrorInfo?: unknown }) => void) | undefined;
  const turnFinished = new Promise<{ status: string; error?: { message?: string; codexErrorInfo?: unknown } }>((resolve) => {
    turnDone = (status, error) => resolve({ status, ...(error ? { error } : {}) });
  });
  let lastError: string | undefined;

  const onLine = (line: string) => {
    let m: RpcMessage;
    try {
      m = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (m.id !== undefined && m.method) {
      // A request from the server (approval, input): never granted.
      send({ id: m.id, error: { code: -32601, message: `Unsupported server request: ${m.method}` } });
      req.onProgress?.(`declined server request ${m.method}\n`);
      return;
    }
    if (m.id !== undefined) {
      const p = pending.get(Number(m.id));
      if (p) {
        pending.delete(Number(m.id));
        p.resolve(m);
      }
      return;
    }
    const params = m.params ?? {};
    switch (m.method) {
      case "item/completed": {
        const item = (params.item ?? {}) as Item;
        if (item.type === "agentMessage" && typeof item.text === "string") {
          lastMessage = item.text;
          if (item.phase === "final_answer") finalMessage = item.text;
        }
        const p = progressFromItem(item);
        if (p) req.onProgress?.(`${p}\n`);
        break;
      }
      case "item/started": {
        const p = progressFromItem((params.item ?? {}) as Item);
        if (p) req.onProgress?.(`started ${p}\n`);
        break;
      }
      case "thread/tokenUsage/updated": {
        const total = (params.tokenUsage as { total?: Record<string, number> } | undefined)?.total;
        if (total) {
          usage = {
            inputTokens: total.inputTokens ?? 0,
            cachedInputTokens: total.cachedInputTokens ?? 0,
            outputTokens: (total.outputTokens ?? 0) + (total.reasoningOutputTokens ?? 0),
          };
        }
        break;
      }
      case "error":
        lastError = (params.error as { message?: string } | undefined)?.message ?? "error";
        req.onProgress?.("provider error\n");
        break;
      case "turn/completed": {
        const turn = (params.turn ?? {}) as { status?: string; error?: { message?: string; codexErrorInfo?: unknown } };
        turnDone?.(turn.status ?? "completed", turn.error ?? undefined);
        break;
      }
      default:
        break;
    }
  };

  createInterface({ input: child.stdout! }).on("line", (line) => {
    touch();
    onLine(line);
  });
  child.stderr?.setEncoding("utf8").on("data", (d: string) => {
    stderr = (stderr + d).slice(-8192);
  });
  const exitedPromise = new Promise<void>((resolve) => {
    child.on("close", (code) => {
      exited = true;
      exitCode = code;
      for (const p of pending.values()) p.resolve({ error: { code: -1, message: "app-server exited" } });
      pending.clear();
      turnDone?.("failed", { message: `codex app-server exited (code ${code ?? "none"}): ${excerpt(stderr, 200)}` });
      resolve();
    });
    child.on("error", (err) => {
      stderr += err.message;
    });
  });

  // Stops: total timeout, idle timeout, cancellation. Interrupt first, then kill.
  let stopReason: "timeout" | "stalled" | "cancelled" | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  const stop = (reason: "timeout" | "stalled" | "cancelled") => {
    if (stopReason || exited) return;
    stopReason = reason;
    // With a turn running, ask Codex to stop it cleanly; before that there is nothing to interrupt.
    // The turn then ends with turn/completed (interrupted); if Codex does not answer in time, kill it.
    if (threadId && turnId) {
      void request("turn/interrupt", { threadId, turnId });
      graceTimer = setTimeout(() => {
        turnDone?.("interrupted");
        killTree(child.pid, "SIGKILL");
      }, INTERRUPT_GRACE_MS);
      graceTimer.unref();
    } else {
      killTree(child.pid, "SIGKILL");
      turnDone?.("interrupted");
    }
  };
  const total = setTimeout(() => stop("timeout"), req.timeoutMs);
  total.unref();
  let idle: NodeJS.Timeout | undefined;
  function touch() {
    if (!req.idleTimeoutMs || stopReason) return;
    clearTimeout(idle);
    idle = setTimeout(() => stop("stalled"), req.idleTimeoutMs);
    idle.unref();
  }
  const onAbort = () => stop("cancelled");
  if (req.signal?.aborted) onAbort();
  else req.signal?.addEventListener("abort", onAbort, { once: true });

  const base = (): Omit<ProviderResult, "ok" | "output"> => ({
    exitCode,
    durationMs: Date.now() - started,
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
  });
  const stoppedResult = (message: string): ProviderResult | undefined => {
    if (stopReason === "cancelled") return { ...base(), ok: false, output: message, error: { type: "CANCELLED", message: "delegation cancelled" } };
    if (stopReason === "stalled") return { ...base(), ok: false, output: message, error: { type: "STALLED", message: "no app-server events for the idle timeout; turn interrupted" } };
    if (stopReason === "timeout") return { ...base(), ok: false, output: message, error: { type: "TIMEOUT", message: "turn exceeded timeout and was interrupted" } };
    return undefined;
  };
  // Never return (or fall back to exec) while the app-server may still be running.
  const cleanup = async () => {
    clearTimeout(total);
    clearTimeout(idle);
    clearTimeout(graceTimer);
    req.signal?.removeEventListener("abort", onAbort);
    child.stdin?.end();
    if (exited) return;
    killTree(child.pid, "SIGTERM");
    const gone = await Promise.race([exitedPromise.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000).unref())]);
    if (!gone) {
      killTree(child.pid, "SIGKILL");
      await Promise.race([exitedPromise, new Promise((r) => setTimeout(r, 1000).unref())]);
    }
  };

  try {
    const init = await request(
      "initialize",
      { clientInfo: { name: "multi-provider", title: "claude-conductor multi-provider", version: "1" }, capabilities: { experimentalApi: false, optOutNotificationMethods: OPT_OUT } },
      INIT_TIMEOUT_MS,
    );
    if (init.error) throw new TransportUnavailable(`initialize failed: ${init.error.message ?? init.error.code}`);
    send({ method: "initialized", params: {} });
    const thread = await request("thread/start", {
      cwd: req.cwd,
      model: model ?? null,
      approvalPolicy: "never",
      sandbox: req.mode === "write" ? "workspace-write" : "read-only",
      ephemeral: true,
    });
    if (thread.error) {
      if (thread.error.code === -32601) throw new TransportUnavailable(`thread/start not supported: ${thread.error.message}`);
      throw new Error(thread.error.message ?? "thread/start failed");
    }
    threadId = (thread.result?.thread as { id?: string } | undefined)?.id;
    if (!threadId) throw new Error("thread/start returned no thread id");
    const turn = await request("turn/start", { threadId, input: [{ type: "text", text: req.prompt, text_elements: [] }], ...(model ? { model } : {}) });
    if (turn.error) throw new Error(turn.error.message ?? "turn/start failed");
    turnId = (turn.result?.turn as { id?: string } | undefined)?.id;

    const outcome = await turnFinished;
    const message = (finalMessage || lastMessage).trim();
    const stopped = stoppedResult(message);
    if (stopped) return stopped;
    if (outcome.status !== "completed") {
      const info = typeof outcome.error?.codexErrorInfo === "string" ? ERROR_INFO[outcome.error.codexErrorInfo] : undefined;
      const text = outcome.error?.message ?? lastError ?? `turn ${outcome.status}`;
      const classified = info ? { type: info, message: excerpt(text) } : classifyFailure({ exitCode: 1, timedOut: false }, text, effectiveErrorPatterns("codex", cfg));
      return { ...base(), ok: false, output: message, error: classified ?? { type: "NON_ZERO_EXIT", message: excerpt(text) } };
    }
    if (!message) return { ...base(), ok: false, output: "", error: { type: "EMPTY_OUTPUT", message: "codex produced no agent message" } };
    return { ...base(), ok: true, output: message };
  } catch (err) {
    // Stopped while starting up: report why we stopped, not the broken pipe it caused.
    const stopped = stoppedResult((finalMessage || lastMessage).trim());
    if (stopped) return stopped;
    if (err instanceof TransportUnavailable) throw err;
    return { ...base(), ok: false, output: "", error: { type: "NON_ZERO_EXIT", message: excerpt(`${(err as Error).message} ${stderr}`) } };
  } finally {
    await cleanup();
  }
}
