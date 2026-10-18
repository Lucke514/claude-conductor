#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { checkHealth } from "./health.js";
import { postDelegate, preBash, preDelegate, sessionStart, userPromptSubmit, type HookInput } from "./hooks.js";
import { stripAttribution } from "./sanitize.js";
import { applySettings, installGitHooks, setAutoDelegate, setStatuslineMode, syncStatuslineScript, uninstallGitHooks, type Scope } from "./setup.js";
import { StateStore } from "./state.js";

/**
 * multi-provider CLI, used by plugin hooks and slash commands:
 *
 *   cli.js hook <pre-delegate|pre-bash|post-delegate|session-start|user-prompt-submit>   (JSON on stdin)
 *   cli.js setup [--scope user|project] [--no-attribution] [--no-statusline]
 *                [--statusline-compose|--statusline-replace] [--no-git-hooks]
 *   cli.js statusline-mode <full|compact|off>
 *   cli.js auto-delegate <on|off|status>
 *   cli.js git-hooks <install|uninstall>
 *   cli.js clean-commit-msg <file>
 *   cli.js status
 */

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const HOOKS: Record<string, (i: HookInput) => Promise<Record<string, unknown> | undefined>> = {
  "pre-delegate": preDelegate,
  "pre-bash": preBash,
  "post-delegate": postDelegate,
  "session-start": sessionStart,
  "user-prompt-submit": userPromptSubmit,
};

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}
function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const projectDir = () => {
  const env = process.env.CLAUDE_PROJECT_DIR;
  return env && !env.includes("${") ? env : process.cwd();
};

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "hook": {
      const handler = HOOKS[rest[0] ?? ""];
      if (!handler) throw new Error(`unknown hook: ${rest[0]}`);
      let input: HookInput = {};
      try {
        input = JSON.parse((await readStdin()) || "{}") as HookInput;
      } catch {
        /* malformed input: behave as no-op */
      }
      if (rest[0] === "session-start") await syncStatuslineScript().catch(() => false);
      const out = await handler(input);
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
      return 0;
    }
    case "setup": {
      const scope = (option(rest, "--scope") ?? "user") as Scope;
      if (scope !== "user" && scope !== "project") throw new Error("--scope must be user or project");
      const dir = option(rest, "--project-dir") ?? projectDir();
      const settings = await applySettings({
        scope,
        projectDir: dir,
        attribution: !flag(rest, "--no-attribution"),
        statusLine: !flag(rest, "--no-statusline"),
        existingStatusLine: flag(rest, "--statusline-compose") ? "compose" : flag(rest, "--statusline-replace") ? "replace" : "abort",
      });
      const report: Record<string, unknown> = { settings };
      if (!flag(rest, "--no-git-hooks")) {
        try {
          report.gitHooks = await installGitHooks(dir);
        } catch (err) {
          report.gitHooks = { skipped: (err as Error).message };
        }
      }
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    case "statusline-mode": {
      const mode = rest[0];
      if (mode !== "full" && mode !== "compact" && mode !== "off") throw new Error("usage: statusline-mode full|compact|off");
      const file = await setStatuslineMode(mode);
      process.stdout.write(`statusline mode set to '${mode}' in ${file}\n`);
      return 0;
    }
    case "auto-delegate": {
      const arg = rest[0];
      if (arg === "status") {
        const { config } = await loadConfig(projectDir());
        process.stdout.write(`auto-delegation is ${config.autoDelegate.enabled ? "on" : "off"}\n`);
        return 0;
      }
      if (arg !== "on" && arg !== "off") throw new Error("usage: auto-delegate on|off|status");
      const file = await setAutoDelegate(arg === "on");
      process.stdout.write(`auto-delegation turned ${arg} in ${file}\n`);
      return 0;
    }
    case "git-hooks": {
      const dir = option(rest, "--repo") ?? projectDir();
      const r = rest[0] === "uninstall" ? await uninstallGitHooks(dir) : await installGitHooks(dir);
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return 0;
    }
    case "clean-commit-msg": {
      const file = rest[0];
      if (!file) throw new Error("usage: clean-commit-msg <file>");
      const msg = readFileSync(file, "utf8");
      const cleaned = stripAttribution(msg);
      if (cleaned !== msg) writeFileSync(file, cleaned);
      return 0;
    }
    case "status": {
      const { config } = await loadConfig(projectDir());
      process.stdout.write(`${JSON.stringify(await checkHealth(config, new StateStore()), null, 2)}\n`);
      return 0;
    }
    default:
      process.stderr.write("usage: cli.js hook|setup|statusline-mode|auto-delegate|git-hooks|clean-commit-msg|status\n");
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`multi-provider: ${(err as Error).message}\n`);
    // Hooks must never block Claude Code because of an internal error (exit 1 = non-blocking).
    process.exit(1);
  },
);
