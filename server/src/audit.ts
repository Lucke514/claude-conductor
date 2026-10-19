import { promises as fs } from "node:fs";
import path from "node:path";
import { logsDir } from "./paths.js";
import type { LifecycleState } from "./worktree.js";
import { today } from "./state.js";

/**
 * Append-only JSONL audit log (~/.claude/multi-provider/logs/YYYY-MM-DD.jsonl).
 * Records metadata only: never prompt text, file contents, output or diffs.
 */
export interface AuditEntry {
  id: string;
  ts: string;
  requestedProvider: string;
  provider: string | null;
  mode: string;
  status: string;
  durationMs: number;
  promptSha256: string;
  promptBytes: number;
  filesCount: number;
  model?: string;
  routingRule?: string;
  attempts: { provider: string; errorType?: string; skipped?: string; retry?: number; durationMs?: number }[];
  filesChanged?: number;
  violations?: { type: string; detail: string }[];
  sessionKey: string;
  sdd?: { slug: string; taskId: string };
}

export interface LifecycleAuditEntry {
  type: "lifecycle";
  id: string;
  ts: string;
  from: LifecycleState | null;
  to: LifecycleState;
}

export async function appendAudit(entry: AuditEntry | LifecycleAuditEntry, dir = logsDir()): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `${today()}.jsonl`), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}
