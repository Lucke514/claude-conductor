import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { mpHome } from "./paths.js";
import { gitConfigEnv, type WorktreeMeta } from "./worktree.js";

/**
 * The environment a delegated worker runs with: no git or GitHub credentials,
 * git limited to local transports, and a `gh` that always refuses — so a worker
 * that skips the worktree hooks still cannot push or open a pull request.
 * The provider CLI's own credentials (~/.codex, API keys) are left alone.
 */

/** Removed from every worker environment. Only names are ever reported, never values. */
export const CREDENTIAL_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
] as const;

export const GH_SHIM_MESSAGE =
  "multi-provider: gh is disabled for delegated workers - pushes, pull requests and issues are reserved for Claude Code.";

export const shimDir = (): string => path.join(mpHome(), "bin");
export const emptyGhConfigDir = (): string => path.join(mpHome(), "empty-gh");

const SHIMS: Record<string, string> = {
  gh: `#!/bin/sh\necho "${GH_SHIM_MESSAGE}" >&2\nexit 1\n`,
  "gh.cmd": `@echo off\r\necho ${GH_SHIM_MESSAGE} 1>&2\r\nexit /b 1\r\n`,
};

/** Write the `gh` shims and the empty gh config dir (idempotent). */
export async function ensureShims(): Promise<void> {
  await fs.mkdir(shimDir(), { recursive: true });
  await fs.mkdir(emptyGhConfigDir(), { recursive: true });
  for (const [name, content] of Object.entries(SHIMS)) {
    const file = path.join(shimDir(), name);
    const current = await fs.readFile(file, "utf8").catch(() => undefined);
    if (current !== content) await fs.writeFile(file, content, { mode: 0o755 });
  }
}

/**
 * Variables holding the project's or the server's absolute path. A worker in a
 * nested repo's worktree must not learn where the source tree (and its `.env`) is.
 */
export const PROJECT_PATH_ENV = ["CLAUDE_PROJECT_DIR", "MP_PROJECT_DIR", "PWD", "OLDPWD", "INIT_CWD"] as const;

/** The PATH variable's own name (`Path` on Windows), so we never end up with two. */
export function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * Overrides for `buildChildEnv`: `undefined` deletes a variable. With a worktree,
 * its hooks are forced too.
 */
/** Whether `dir` is one of `roots` or inside one (compared as given and with symlinks resolved). */
function under(dir: string, roots: string[]): boolean {
  const forms = (p: string) => {
    const out = [path.resolve(p)];
    try {
      out.push(realpathSync.native(p));
    } catch {
      // Missing directories only compare as given.
    }
    return out;
  };
  return forms(dir).some((d) =>
    roots.flatMap(forms).some((r) => {
      const rel = path.relative(r, d);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    }),
  );
}

/**
 * `hidePaths`: the project and source repo roots. PATH entries under them (e.g.
 * `<repo>/node_modules/.bin`) are dropped, so the worker's environment never names them.
 */
export function workerEnv(
  meta?: Pick<WorktreeMeta, "hooksDir">,
  env: NodeJS.ProcessEnv = process.env,
  hidePaths: string[] = [],
): Record<string, string | undefined> {
  const key = pathKey(env);
  const out: Record<string, string | undefined> = {};
  for (const name of [...CREDENTIAL_ENV, ...PROJECT_PATH_ENV]) out[name] = undefined;
  const entries: [string, string][] = [["credential.helper", ""]];
  if (meta) entries.push(["core.hooksPath", meta.hooksDir]);
  Object.assign(out, gitConfigEnv(entries, env), {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GH_CONFIG_DIR: emptyGhConfigDir(),
    [key]: [shimDir(), ...(env[key] ?? "").split(path.delimiter).filter((d) => d && !(hidePaths.length && under(d, hidePaths)))].join(path.delimiter),
  });
  return out;
}
