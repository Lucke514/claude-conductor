#!/usr/bin/env node
// multi-provider bootstrap (zero dependencies).
//
// Claude Code installs marketplace plugins by copying the repository, without
// node_modules. This launcher installs production dependencies on first run
// (npm install --omit=dev, under a lock) and then starts the requested entry:
//
//   node bootstrap.mjs mcp            -> dist/index.js (MCP stdio server)
//   node bootstrap.mjs cli <args...>  -> dist/cli.js   (hooks / setup)
//
// stdout is reserved for the MCP protocol / hook JSON: npm output goes to stderr.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED = ["@modelcontextprotocol/sdk", "zod"];

function hasDeps() {
  return REQUIRED.every((d) => existsSync(path.join(serverDir, "node_modules", ...d.split("/"), "package.json")));
}

function npmInvocation() {
  // Prefer npm-cli.js next to the running node (works on Windows without a shell).
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const cli = candidates.find((c) => existsSync(c));
  if (cli) return { cmd: process.execPath, pre: [cli], shell: false };
  return { cmd: process.platform === "win32" ? "npm.cmd" : "npm", pre: [], shell: process.platform === "win32" };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureDeps() {
  if (hasDeps()) return;
  const lock = path.join(serverDir, ".install.lock");
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5 * 60_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      if (hasDeps()) return;
      if (i > 600) throw new Error("timed out waiting for another dependency install");
      sleep(500);
    }
  }
  try {
    if (hasDeps()) return;
    process.stderr.write("multi-provider: installing server dependencies (first run)…\n");
    const npm = npmInvocation();
    const r = spawnSync(npm.cmd, [...npm.pre, "install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: serverDir,
      stdio: ["ignore", process.stderr, process.stderr],
      shell: npm.shell,
      windowsHide: true,
    });
    if (r.status !== 0 || !hasDeps()) {
      throw new Error(`npm install failed (exit ${r.status}). Run 'npm install && npm run build' in ${serverDir}`);
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const [entry, ...rest] = process.argv.slice(2);
const target = entry === "cli" ? "cli.js" : "index.js";
const file = path.join(serverDir, "dist", target);
try {
  ensureDeps();
  if (!existsSync(file)) throw new Error(`${file} missing. Run 'npm install && npm run build' in ${serverDir}`);
} catch (err) {
  process.stderr.write(`multi-provider: ${err.message}\n`);
  // Exit 1: non-blocking for hooks; the MCP server simply fails to start.
  process.exit(1);
}
process.argv = [process.argv[0], file, ...rest];
await import(pathToFileURL(file).href);
