import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
const KILL_GRACE_MS = 2000;
/** Environment variables a worker must never inherit. */
const STRIPPED_ENV = ["MP_CLAUDE_COMMIT"];
export function buildChildEnv(extra) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !STRIPPED_ENV.includes(k))
            env[k] = v;
    }
    for (const [k, v] of Object.entries(extra ?? {})) {
        if (v === undefined)
            delete env[k];
        else
            env[k] = v;
    }
    return env;
}
function isFile(p) {
    try {
        return statSync(p).isFile();
    }
    catch {
        return false;
    }
}
export function findInPath(bin, envPath = process.env.PATH ?? process.env.Path ?? "") {
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
            if (isFile(candidate))
                return candidate;
        }
    }
    return undefined;
}
/**
 * On Windows, npm installs CLIs as `.cmd` shims that cannot be spawned without a
 * shell. We read the shim and run the underlying JS file with the current node.
 */
export function resolveCommand(bin) {
    const found = findInPath(bin);
    if (!found)
        return undefined;
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(found)) {
        const js = parseNpmCmdShim(found);
        if (js)
            return { command: process.execPath, prefixArgs: [js], resolvedPath: found };
        // Unknown batch file: run through cmd.exe with escaped arguments (no interpolation).
        return { command: process.env.ComSpec ?? "cmd.exe", prefixArgs: ["/d", "/s", "/c", found], resolvedPath: found };
    }
    // A plain JS entry point (e.g. binaryPath pointing at a CLI's .js file): run it with
    // the current node, since Windows cannot spawn a script through its shebang.
    if (/\.(c|m)?js$/i.test(found))
        return { command: process.execPath, prefixArgs: [found], resolvedPath: found };
    return { command: found, prefixArgs: [], resolvedPath: found };
}
export function parseNpmCmdShim(cmdFile) {
    try {
        const text = readFileSync(cmdFile, "utf8");
        const m = text.match(/"%(?:~)?dp0%?\\?([^"%]+?\.(?:c|m)?js)"/i);
        if (!m?.[1])
            return undefined;
        const js = path.join(path.dirname(cmdFile), m[1]);
        return existsSync(js) ? js : undefined;
    }
    catch {
        return undefined;
    }
}
// ---------------------------------------------------------------------------
// Process tree kill
// ---------------------------------------------------------------------------
export function killTree(pid, signal = "SIGTERM") {
    if (!pid)
        return;
    if (process.platform === "win32") {
        try {
            const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
            k.on("error", () => undefined);
        }
        catch {
            /* ignore */
        }
        return;
    }
    try {
        // Children are started detached => they lead their own process group.
        process.kill(-pid, signal);
    }
    catch {
        try {
            process.kill(pid, signal);
        }
        catch {
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
export function stripAnsi(input) {
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
    max;
    chunks = [];
    size = 0;
    constructor(max) {
        this.max = max;
    }
    push(s) {
        this.chunks.push(s);
        this.size += s.length;
        while (this.size > this.max && this.chunks.length > 1) {
            this.size -= this.chunks.shift().length;
        }
    }
    toString() {
        const s = this.chunks.join("");
        return s.length > this.max ? s.slice(s.length - this.max) : s;
    }
}
/**
 * The three ways a run is stopped from outside: total timeout, no output for
 * `idleTimeoutMs`, and an aborted signal. `kill` terminates the tree; `touch`
 * restarts the idle clock on each chunk of output.
 */
function stopper(opts, kill) {
    let reason;
    const stop = (r) => {
        if (reason)
            return;
        reason = r;
        kill(r);
    };
    const total = setTimeout(() => stop("timeout"), opts.timeoutMs);
    total.unref();
    let idle;
    const touch = () => {
        if (!opts.idleTimeoutMs || reason)
            return;
        clearTimeout(idle);
        idle = setTimeout(() => stop("stalled"), opts.idleTimeoutMs);
        idle.unref();
    };
    const onAbort = () => stop("cancelled");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // Aborted while the runner was starting (e.g. loading node-pty): stop right after it is wired.
    if (opts.signal?.aborted)
        queueMicrotask(onAbort);
    touch();
    return {
        touch,
        get reason() {
            return reason;
        },
        dispose() {
            clearTimeout(total);
            clearTimeout(idle);
            opts.signal?.removeEventListener("abort", onAbort);
        },
    };
}
/**
 * node-pty 1.x ships its macOS `spawn-helper` prebuild without the exec bit, so every
 * PTY spawn fails ("posix_spawnp failed") until it is chmod'ed. Best effort, no-op elsewhere.
 */
function ensureSpawnHelperExecutable() {
    if (process.platform !== "darwin")
        return;
    try {
        const root = path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
        for (const dir of [`prebuilds/darwin-${process.arch}`, "build/Release"]) {
            const helper = path.join(root, dir, "spawn-helper");
            if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0)
                chmodSync(helper, 0o755);
        }
    }
    catch {
        /* not installed or read-only: loadPty reports the failure through its fallback note */
    }
}
let ptyModule;
async function loadPty() {
    if (ptyModule !== undefined)
        return ptyModule;
    try {
        ensureSpawnHelperExecutable();
        const mod = (await import("node-pty"));
        ptyModule = typeof mod.spawn === "function" ? mod : (mod.default ?? null);
    }
    catch {
        ptyModule = null;
    }
    return ptyModule;
}
/** True when node-pty can be loaded (Antigravity needs it to avoid hanging without a TTY). */
export async function ptyAvailable() {
    return (await loadPty()) !== null;
}
export async function runProcess(opts) {
    const notes = [];
    const resolved = resolveCommand(opts.command);
    const start = Date.now();
    if (!resolved) {
        return {
            exitCode: null,
            signal: null,
            stdout: "",
            stderr: "",
            timedOut: false,
            cancelled: false,
            stalled: false,
            durationMs: 0,
            spawnError: { code: "ENOENT", message: `binary not found in PATH: ${opts.command}` },
            usedPty: false,
            notes,
        };
    }
    if (opts.signal?.aborted) {
        return { exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: true, stalled: false, durationMs: 0, usedPty: false, notes };
    }
    const args = [...resolved.prefixArgs, ...opts.args];
    const env = buildChildEnv(opts.env);
    if (opts.usePty) {
        const pty = await loadPty();
        if (pty) {
            try {
                return await runWithPty(pty, resolved.command, args, opts, env, start, notes);
            }
            catch (err) {
                notes.push(`pty spawn failed (${err.message}); fell back to plain spawn`);
            }
        }
        else {
            notes.push("node-pty unavailable; fell back to plain spawn");
        }
    }
    return runWithSpawn(resolved.command, args, opts, env, start, notes);
}
function runWithSpawn(command, args, opts, env, start, notes) {
    const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const stdout = new TailBuffer(max);
    const stderr = new TailBuffer(max);
    return new Promise((resolve) => {
        let child;
        let settled = false;
        let stop;
        const finish = (r) => {
            if (settled)
                return;
            settled = true;
            stop?.dispose();
            clearTimeout(hardTimer);
            resolve({
                ...r,
                stdout: stdout.toString(),
                stderr: stderr.toString(),
                timedOut: stop?.reason === "timeout",
                cancelled: stop?.reason === "cancelled",
                stalled: stop?.reason === "stalled",
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
        }
        catch (err) {
            const e = err;
            resolve({
                exitCode: null,
                signal: null,
                stdout: "",
                stderr: "",
                timedOut: false,
                cancelled: false,
                stalled: false,
                durationMs: Date.now() - start,
                spawnError: { code: e.code, message: e.message },
                usedPty: false,
                notes,
            });
            return;
        }
        let hardTimer;
        stop = stopper(opts, () => {
            killTree(child.pid, "SIGTERM");
            hardTimer = setTimeout(() => {
                killTree(child.pid, "SIGKILL");
                // If the process still doesn't report exit, resolve anyway.
                setTimeout(() => finish({ exitCode: null, signal: "SIGKILL" }), 500).unref();
            }, KILL_GRACE_MS);
            hardTimer.unref();
        });
        const onData = (buf) => (d) => {
            buf.push(d);
            stop?.touch();
            opts.onOutput?.(d);
        };
        child.stdout?.setEncoding("utf8").on("data", onData(stdout));
        child.stderr?.setEncoding("utf8").on("data", onData(stderr));
        child.on("error", (err) => {
            finish({ exitCode: null, signal: null, spawnError: { code: err.code, message: err.message } });
        });
        child.on("close", (code, signal) => finish({ exitCode: code, signal: signal ?? null }));
        child.stdin?.on("error", () => undefined);
        if (opts.input !== undefined)
            child.stdin?.end(opts.input);
        else
            child.stdin?.end();
    });
}
function runWithPty(pty, command, args, opts, env, start, notes) {
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
        let settled = false;
        const finish = (exitCode, signal) => {
            if (settled)
                return;
            settled = true;
            stop.dispose();
            resolve({
                exitCode,
                signal,
                stdout: stripAnsi(out.toString()),
                stderr: "",
                timedOut: stop.reason === "timeout",
                cancelled: stop.reason === "cancelled",
                stalled: stop.reason === "stalled",
                durationMs: Date.now() - start,
                usedPty: true,
                notes,
            });
        };
        const stop = stopper(opts, () => {
            killTree(proc.pid, "SIGTERM");
            try {
                proc.kill();
            }
            catch {
                /* ignore */
            }
            setTimeout(() => {
                killTree(proc.pid, "SIGKILL");
                finish(null, "SIGKILL");
            }, KILL_GRACE_MS).unref();
        });
        proc.onData((d) => {
            out.push(d);
            stop.touch();
            opts.onOutput?.(stripAnsi(d));
        });
        proc.onExit(({ exitCode, signal }) => finish(exitCode, signal ? String(signal) : null));
        if (opts.input !== undefined) {
            proc.write(opts.input);
            // EOT so a CLI that reads stdin sees end of input.
            proc.write(process.platform === "win32" ? "\x1a\r" : "\x04");
        }
    });
}
//# sourceMappingURL=process.js.map