import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, type MpConfig } from "../src/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CODEX = path.join(here, "fixtures", "fake-codex.mjs");
export const FAKE_AGY = path.join(here, "fixtures", "fake-agy.mjs");
chmodSync(FAKE_CODEX, 0o755);
chmodSync(FAKE_AGY, 0o755);

export function tmpDir(prefix = "mp-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeRepo(): string {
  const dir = tmpDir("mp-repo-");
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.name", "Test User");
  g("config", "user.email", "test@example.com");
  g("config", "commit.gpgsign", "false");
  // Windows runners default to core.autocrlf=true; keep checkouts byte-identical.
  g("config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "README.md"), "# repo\n");
  writeFileSync(path.join(dir, "index.ts"), "export const a = 1;\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return dir;
}

export function testConfig(overrides: Record<string, unknown> = {}): MpConfig {
  return parseConfig({
    retry: { baseDelayMs: 1, maxDelayMs: 2 },
    providers: {
      codex: { binaryPath: FAKE_CODEX },
      antigravity: { binaryPath: FAKE_AGY, usePty: false },
    },
    ...overrides,
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // Orphans may linger as zombies when PID 1 doesn't reap them (containers): treat as dead.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^\d+ \(.*\) [ZX] /.test(stat);
  } catch {
    return true;
  }
}
