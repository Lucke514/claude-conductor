import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "./config.js";
import { readJson, writeFileAtomic } from "./fsutil.js";
import { git, gitOk } from "./git.js";
import { mpHome, userConfigPath } from "./paths.js";
const here = path.dirname(fileURLToPath(import.meta.url));
/** Plugin root: server/dist/.. /.. */
export const pluginRoot = () => process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(here, "..", "..");
export function settingsPath(scope, projectDir) {
    if (scope === "user")
        return process.env.MP_CLAUDE_SETTINGS ?? path.join(os.homedir(), ".claude", "settings.json");
    return path.join(projectDir, ".claude", "settings.json");
}
export const ATTRIBUTION_OFF = { commit: "", pr: "", sessionUrl: false };
async function loadSettings(file) {
    let text;
    try {
        text = await fs.readFile(file, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return { data: {}, existed: false };
        throw err;
    }
    if (!text.trim())
        return { data: {}, existed: true };
    const data = JSON.parse(text); // throws on invalid JSON: never clobber a file we can't read
    if (typeof data !== "object" || data === null || Array.isArray(data))
        throw new Error(`${file} is not a JSON object`);
    return { data: data, existed: true };
}
async function backup(file) {
    if (!existsSync(file))
        return undefined;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dst = `${file}.bak-${stamp}`;
    await fs.copyFile(file, dst);
    return dst;
}
/** Path the statusLine command points to; stable across plugin updates. */
export const stableStatuslinePath = () => path.join(mpHome(), "statusline.js");
export function statuslineCommand() {
    return `node "${stableStatuslinePath()}"`;
}
/** Copy statusline/index.js to a stable location (plugin root changes on update). */
export async function syncStatuslineScript() {
    const src = path.join(pluginRoot(), "statusline", "index.js");
    if (!existsSync(src))
        return false;
    await fs.mkdir(mpHome(), { recursive: true });
    const dst = stableStatuslinePath();
    const [a, b] = await Promise.all([fs.readFile(src, "utf8"), fs.readFile(dst, "utf8").catch(() => "")]);
    if (a !== b)
        await writeFileAtomic(dst, a);
    return true;
}
export async function applySettings(opts) {
    const file = settingsPath(opts.scope, opts.projectDir);
    const { data } = await loadSettings(file);
    const changed = [];
    const result = { file, changed };
    if (opts.attribution) {
        const prev = data.attribution;
        const base = typeof prev === "object" && prev !== null && !Array.isArray(prev) ? prev : {};
        const next = { ...base, ...ATTRIBUTION_OFF };
        if (JSON.stringify(prev) !== JSON.stringify(next)) {
            data.attribution = next;
            changed.push("attribution");
        }
    }
    if (opts.statusLine) {
        await syncStatuslineScript();
        const ours = statuslineCommand();
        const existing = data.statusLine;
        const existingCmd = existing?.command;
        const isOurs = typeof existingCmd === "string" && (existingCmd === ours || existingCmd.includes(path.join(".claude", "multi-provider")));
        if (existingCmd && !isOurs) {
            if (opts.existingStatusLine === "abort") {
                throw new Error(`a status line is already configured (${existingCmd}); rerun with --statusline-compose or --statusline-replace`);
            }
            if (opts.existingStatusLine === "compose") {
                await updateUserConfig((c) => {
                    const sl = (c.statusline ??= {});
                    sl.compose = existingCmd;
                });
                result.composedStatusLine = existingCmd;
            }
        }
        if (!isOurs || existingCmd !== ours) {
            data.statusLine = { ...(typeof existing === "object" ? existing : {}), type: "command", command: ours };
            changed.push("statusLine");
        }
    }
    if (changed.length > 0) {
        const bak = await backup(file);
        if (bak)
            result.backup = bak;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
    }
    return result;
}
// ---------------------------------------------------------------------------
// Plugin config (~/.claude/multiprovider.json)
// ---------------------------------------------------------------------------
export async function updateUserConfig(mutate) {
    const file = userConfigPath();
    const current = (await readJson(file)) ?? {};
    if (existsSync(file) && Object.keys(current).length === 0) {
        const text = await fs.readFile(file, "utf8");
        if (text.trim())
            throw new Error(`${file} is not valid JSON; fix it first`);
    }
    mutate(current);
    parseConfig(current, file); // validate before writing
    await writeFileAtomic(file, `${JSON.stringify(current, null, 2)}\n`);
    return file;
}
export async function setStatuslineMode(mode) {
    return updateUserConfig((c) => {
        const sl = (c.statusline ??= {});
        sl.mode = mode;
    });
}
export async function setAutoDelegate(enabled) {
    return updateUserConfig((c) => {
        const ad = (c.autoDelegate ??= {});
        ad.enabled = enabled;
    });
}
// ---------------------------------------------------------------------------
// Git hooks (commit-msg attribution scrubber, chained via core.hooksPath)
// ---------------------------------------------------------------------------
const CHAINED_HOOKS = [
    "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg",
    "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "post-rewrite", "pre-auto-gc",
    "push-to-checkout", "sendemail-validate", "post-index-change",
];
/** Hooks that run very often: only chain them if the previous dir has them. */
const OPTIONAL_HOOKS = ["reference-transaction", "fsmonitor-watchman"];
const MARKER = "# multi-provider chained hook";
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const toPosix = (p) => p.split(path.sep).join("/");
function wrapperHook(name, prev) {
    return `#!/bin/sh
${MARKER}
PREV=${shq(toPosix(prev))}
if [ -x "$PREV/${name}" ]; then exec "$PREV/${name}" "$@"; fi
exit 0
`;
}
function commitMsgHook(prev) {
    return `#!/bin/sh
${MARKER}
# Runs the previous commit-msg hook (if any), then strips Co-authored-by /
# "Generated with ..." / claude.ai session lines from the message.
PREV=${shq(toPosix(prev))}
HERE=$(dirname "$0")
if [ -x "$PREV/commit-msg" ]; then "$PREV/commit-msg" "$@" || exit $?; fi
if command -v node >/dev/null 2>&1; then
  node "$HERE/mp-clean-commit-msg.mjs" "$1" || echo "multi-provider: could not clean commit message" >&2
fi
exit 0
`;
}
const CLEANER = `// multi-provider: strip AI attribution from a commit message file.
import { readFileSync, writeFileSync } from "node:fs";
import { stripAttribution } from "./mp-sanitize.mjs";
const file = process.argv[2];
if (file) {
  const msg = readFileSync(file, "utf8");
  const cleaned = stripAttribution(msg);
  if (cleaned !== msg) writeFileSync(file, cleaned);
}
`;
export async function installGitHooks(cwd) {
    const repo = await gitOk(["rev-parse", "--show-toplevel"], cwd);
    const common = path.resolve(repo, await gitOk(["rev-parse", "--git-common-dir"], repo));
    const ours = path.join(common, "mp-hooks");
    const stateFile = path.join(ours, ".previous.json");
    const configured = (await git(["config", "--local", "--get", "core.hooksPath"], repo)).stdout.trim() || null;
    let previousConfigured;
    let previous;
    const saved = await readJson(stateFile);
    if (configured && path.resolve(repo, configured) === ours && saved) {
        // Re-install: keep the original chain target.
        previous = saved.previous;
        previousConfigured = saved.previousConfigured;
    }
    else {
        previousConfigured = configured;
        previous = configured ? path.resolve(repo, configured) : path.join(common, "hooks");
    }
    await fs.mkdir(ours, { recursive: true });
    // dist/sanitize.js (also resolvable when running from src/ under tests).
    const sanitizeSrc = [path.join(here, "sanitize.js"), path.join(here, "..", "dist", "sanitize.js")].find((p) => existsSync(p));
    if (!sanitizeSrc)
        throw new Error("dist/sanitize.js not found; run 'npm run build' in server/");
    await fs.copyFile(sanitizeSrc, path.join(ours, "mp-sanitize.mjs"));
    await fs.writeFile(path.join(ours, "mp-clean-commit-msg.mjs"), CLEANER);
    await fs.writeFile(path.join(ours, "commit-msg"), commitMsgHook(previous), { mode: 0o755 });
    for (const h of CHAINED_HOOKS)
        await fs.writeFile(path.join(ours, h), wrapperHook(h, previous), { mode: 0o755 });
    for (const h of OPTIONAL_HOOKS) {
        if (existsSync(path.join(previous, h)))
            await fs.writeFile(path.join(ours, h), wrapperHook(h, previous), { mode: 0o755 });
    }
    await fs.writeFile(stateFile, JSON.stringify({ previous, previousConfigured }, null, 2));
    await gitOk(["config", "--local", "core.hooksPath", toPosix(ours)], repo);
    return { repo, hooksDir: ours, previous, previousConfigured };
}
export async function uninstallGitHooks(cwd) {
    const repo = await gitOk(["rev-parse", "--show-toplevel"], cwd);
    const common = path.resolve(repo, await gitOk(["rev-parse", "--git-common-dir"], repo));
    const ours = path.join(common, "mp-hooks");
    const saved = await readJson(path.join(ours, ".previous.json"));
    if (saved?.previousConfigured)
        await gitOk(["config", "--local", "core.hooksPath", saved.previousConfigured], repo);
    else
        await git(["config", "--local", "--unset", "core.hooksPath"], repo);
    await fs.rm(ours, { recursive: true, force: true });
    return { restored: saved?.previousConfigured ?? null };
}
//# sourceMappingURL=setup.js.map