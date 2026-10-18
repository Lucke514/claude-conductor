import { promises as fs } from "node:fs";
import path from "node:path";
import { mpHome } from "./paths.js";
import { gitConfigEnv } from "./worktree.js";
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
];
export const GH_SHIM_MESSAGE = "multi-provider: gh is disabled for delegated workers - pushes, pull requests and issues are reserved for Claude Code.";
export const shimDir = () => path.join(mpHome(), "bin");
export const emptyGhConfigDir = () => path.join(mpHome(), "empty-gh");
const SHIMS = {
    gh: `#!/bin/sh\necho "${GH_SHIM_MESSAGE}" >&2\nexit 1\n`,
    "gh.cmd": `@echo off\r\necho ${GH_SHIM_MESSAGE} 1>&2\r\nexit /b 1\r\n`,
};
/** Write the `gh` shims and the empty gh config dir (idempotent). */
export async function ensureShims() {
    await fs.mkdir(shimDir(), { recursive: true });
    await fs.mkdir(emptyGhConfigDir(), { recursive: true });
    for (const [name, content] of Object.entries(SHIMS)) {
        const file = path.join(shimDir(), name);
        const current = await fs.readFile(file, "utf8").catch(() => undefined);
        if (current !== content)
            await fs.writeFile(file, content, { mode: 0o755 });
    }
}
/**
 * Variables holding the project's or the server's absolute path. A worker in a
 * nested repo's worktree must not learn where the source tree (and its `.env`) is.
 */
export const PROJECT_PATH_ENV = ["CLAUDE_PROJECT_DIR", "MP_PROJECT_DIR", "PWD", "OLDPWD", "INIT_CWD"];
/** The PATH variable's own name (`Path` on Windows), so we never end up with two. */
export function pathKey(env) {
    return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}
/**
 * Overrides for `buildChildEnv`: `undefined` deletes a variable. With a worktree,
 * its hooks are forced too.
 */
export function workerEnv(meta, env = process.env) {
    const key = pathKey(env);
    const out = {};
    for (const name of [...CREDENTIAL_ENV, ...PROJECT_PATH_ENV])
        out[name] = undefined;
    const entries = [["credential.helper", ""]];
    if (meta)
        entries.push(["core.hooksPath", meta.hooksDir]);
    Object.assign(out, gitConfigEnv(entries, env), {
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: "file",
        GH_CONFIG_DIR: emptyGhConfigDir(),
        [key]: [shimDir(), env[key]].filter(Boolean).join(path.delimiter),
    });
    return out;
}
//# sourceMappingURL=worker-env.js.map