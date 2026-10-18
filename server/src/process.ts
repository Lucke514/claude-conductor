import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Process helpers. Every child is started with `spawn` and an argv array —
 * never through a shell with an interpolated string.
 */

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Written to stdin then closed. When undefined stdin is closed immediately. */
  input?: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  /** Run inside a pseudo-terminal (node-pty). Falls back to spawn if unavailable. */
  usePty?: boolean;
  /** Keep at most this many bytes of stdout/stderr (tail). */
  maxOutputBytes?: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** Set when the process could not be started (e.g. ENOENT). */
  spawnError?: { code?: string; message: string };
  usedPty: boolean;
  notes: string[];
}

const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

/** Environment variables a worker must never inherit. */
const STRIPPED_ENV = ["MP_CLAUDE_COMMIT"];

export function buildChildEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !STRIPPED_ENV.includes(k)) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Binary resolution (PATH + PATHEXT on Windows, npm .cmd shims)
// ---------------------------------------------------------------------------

export interface ResolvedCommand {
  command: string;
  /** Arguments to prepend (e.g. the JS entry of an npm shim). */
  prefixArgs: string[];
  /** Resolved file on disk, for reporting. */
  resolvedPath: string;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function findInPath(bin: string, envPath = process.env.PATH ?? process.env.Path ?? ""): string | undefined {
  const isWin = process.platform === "win32";
  const exts = isWin
    ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())]
    : [""];
  const hasDir = bin.includes("/") || (isWin && bin.includes("\\"));
  const dirs = hasDir ? [""] : envPath.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const base = hasDir ? path.resolve(bin) : path.join(dir, bin);
    for (const ext of exts) {
      const candidate = base + ext;
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * On Windows, npm installs CLIs as `.cmd` shims that cannot be spawned without a
 * shell. We read the shim and run the underlying JS file with the current node.
 */
export function resolveCommand(bin: string): ResolvedCommand | undefined {
  const found = findInPath(bin);
  if (!found) return undefined;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(found)) {
    const js = parseNpmCmdShim(found);
    if (js) return { command: process.execPath, prefixArgs: [js], resolvedPath: found };
    // Unknown batch file: run through cmd.exe with escaped arguments (no interpolation).
    return { command: process.env.ComSpec ?? "cmd.exe", prefixArgs: ["/d", "/s", "/c", found], resolvedPath: found };
  }
  return { command: found, prefixArgs: [], resolvedPath: found };
}

export function parseNpmCmdShim(cmdFile: string): string | undefined {
  try {
    const text = readFileSync(cmdFile, "utf8");
    const m = text.match(/"%(?:~)?dp0%?\\?([^"%]+?\.(?:c|m)?js)"/i);
    if (!m?.[1]) return undefined;
    const js = path.join(path.dirname(cmdFile), m[1]);
    return existsSync(js) ? js : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Process tree kill
// ---------------------------------------------------------------------------

export function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      k.on("error", () => undefined);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    // Children are started detached => they lead their own process group.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// ANSI stripping (PTY output)
// ---------------------------------------------------------------------------

// CSI, OSC (BEL or ST terminated), DCS/PM/APC, and single-char escapes.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[PX^_][^\u001b]*\u001b\\|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(input: string): string {
  const noEsc = input.replace(ANSI_RE, "");
  // Resolve carriage-return overwrites (spinners/progress) line by line.
  return noEsc
    .split("\n")
    .map((line) => {
      const l = line.endsWith("\r") ? line.slice(0, -1) : line;
      const idx = l.lastIndexOf("\r");
      return idx >= 0 ? l.slice(idx + 1) : l;
    })
    .join("\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

class TailBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly max: number) {}
  push(s: string): void {
    this.chunks.push(s);
    this.size += s.length;
    while (this.size > this.max && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }
  toString(): string {
    const s = this.chunks.join("");
    return s.length > this.max ? s.slice(s.length - this.max) : s;
  }
}

type PtyModule = typeof import("node-pty");
let ptyModule: PtyModule | null | undefined;

async function loadPty(): Promise<PtyModule | null> {
  if (ptyModule !== undefined) return ptyModule;
  try {
    const mod = (await import("node-pty")) as Partial<PtyModule> & { default?: PtyModule };
    ptyModule = typeof mod.spawn === "function" ? (mod as PtyModule) : (mod.default ?? null);
  } catch {
    ptyModule = null;
  }
  return ptyModule;
}

export async function runProcess(opts: RunOptions): Promise<RunResult> {
  const notes: string[] = [];
  const resolved = resolveCommand(opts.command);
  const start = Date.now();
  if (!resolved) {
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 0,
      spawnError: { code: "ENOENT", message: `binary not found in PATH: ${opts.command}` },
      usedPty: false,
      notes,
    };
  }
  const args = [...resolved.prefixArgs, ...opts.args];
  const env = buildChildEnv(opts.env);

  if (opts.usePty) {
    const pty = await loadPty();
    if (pty) {
      try {
        return await runWithPty(pty, resolved.command, args, opts, env, start, notes);
      } catch (err) {
        notes.push(`pty spawn failed (${(err as Error).message}); fell back to plain spawn`);
      }
    } else {
      notes.push("node-pty unavailable; fell back to plain spawn");
    }
  }
  return runWithSpawn(resolved.command, args, opts, env, start, notes);
}

function runWithSpawn(
  command: string,
  args: string[],
  opts: RunOptions,
  env: Record<string, string>,
  start: number,
  notes: string[],
): Promise<RunResult> {
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const stdout = new TailBuffer(max);
  const stderr = new TailBuffer(max);
  return new Promise((resolve) => {
    let child: ChildProcess;
    let timedOut = false;
    let settled = false;
    const finish = (r: Omit<RunResult, "durationMs" | "usedPty" | "notes" | "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      resolve({
        ...r,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        durationMs: Date.now() - start,
        usedPty: false,
        notes,
      });
    };
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        durationMs: Date.now() - start,
        spawnError: { code: e.code, message: e.message },
        usedPty: false,
        notes,
      });
      return;
    }
    let hardTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, "SIGTERM");
      hardTimer = setTimeout(() => {
        killTree(child.pid, "SIGKILL");
        // If the process still doesn't report exit, resolve anyway.
        setTimeout(() => finish({ exitCode: null, signal: "SIGKILL" }), 500).unref();
      }, KILL_GRACE_MS);
      hardTimer.unref();
    }, opts.timeoutMs);
    timer.unref();

    child.stdout?.setEncoding("utf8").on("data", (d: string) => stdout.push(d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => stderr.push(d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ exitCode: null, signal: null, spawnError: { code: err.code, message: err.message } });
    });
    child.on("close", (code, signal) => finish({ exitCode: code, signal: signal ?? null }));
    child.stdin?.on("error", () => undefined);
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

function runWithPty(
  pty: PtyModule,
  command: string,
  args: string[],
  opts: RunOptions,
  env: Record<string, string>,
  start: number,
  notes: string[],
): Promise<RunResult> {
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const out = new TailBuffer(max);
  const proc = pty.spawn(command, args, {
    name: "xterm-256color",
    cols: 200,
    rows: 50,
    cwd: opts.cwd,
    env: { ...env, TERM: env.TERM ?? "xterm-256color" },
  });
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: stripAnsi(out.toString()),
        stderr: "",
        timedOut,
        durationMs: Date.now() - start,
        usedPty: true,
        notes,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc.pid, "SIGTERM");
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        killTree(proc.pid, "SIGKILL");
        finish(null, "SIGKILL");
      }, KILL_GRACE_MS).unref();
    }, opts.timeoutMs);
    timer.unref();
    proc.onData((d) => out.push(d));
    proc.onExit(({ exitCode, signal }) => finish(exitCode, signal ? String(signal) : null));
    if (opts.input !== undefined) {
      proc.write(opts.input);
      // EOT so a CLI that reads stdin sees end of input.
      proc.write(process.platform === "win32" ? "\x1a\r" : "\x04");
    }
  });
}
