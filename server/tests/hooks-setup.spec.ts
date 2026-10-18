import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractDelegateResult, postDelegate, preBash, preDelegate, splitCommand } from "../src/hooks.js";
import { applySettings, installGitHooks, statuslineCommand, setStatuslineMode, uninstallGitHooks } from "../src/setup.js";
import { makeRepo, tmpDir } from "./helpers.js";
import { worktreesDir } from "../src/paths.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const settingsFile = process.env.MP_CLAUDE_SETTINGS!;
const userConfig = process.env.MP_USER_CONFIG!;

afterEach(() => {
  rmSync(settingsFile, { force: true });
  rmSync(userConfig, { force: true });
  for (const f of readdirSync(path.dirname(settingsFile))) {
    if (f.startsWith(path.basename(settingsFile) + ".bak-")) rmSync(path.join(path.dirname(settingsFile), f));
  }
});

describe("PreToolUse(delegate)", () => {
  it("asks for confirmation in write mode and injects the session id", async () => {
    const out = (await preDelegate({ session_id: "s1", cwd: tmpDir(), tool_input: { provider: "codex", task: "t", mode: "write" } })) as any;
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/MODIFY/);
    expect(out.hookSpecificOutput.updatedInput).toEqual({ provider: "codex", task: "t", mode: "write", sessionId: "s1" });
  });
  it("does not set a decision in read mode", async () => {
    const out = (await preDelegate({ session_id: "s1", cwd: tmpDir(), tool_input: { provider: "codex", task: "t" } })) as any;
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.updatedInput.sessionId).toBe("s1");
  });
  it("uses defaults.mode from config when mode is omitted", async () => {
    writeFileSync(userConfig, JSON.stringify({ defaults: { mode: "write" } }));
    const out = (await preDelegate({ cwd: tmpDir(), tool_input: { provider: "auto", task: "t" } })) as any;
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  });
});

describe("PreToolUse(Bash)", () => {
  it("rewrites gh pr create bodies", async () => {
    const out = (await preBash({ tool_input: { command: 'gh pr create --body "x\\n\\nCo-Authored-By: C <n@a.com>"', description: "d" } })) as any;
    expect(out.hookSpecificOutput.updatedInput).toEqual({ command: 'gh pr create --body "x"', description: "d" });
  });
  it("is silent for other commands", async () => {
    expect(await preBash({ tool_input: { command: "ls -la" } })).toBeUndefined();
  });
});

describe("PostToolUse(delegate)", () => {
  it("finds the result in MCP content blocks", () => {
    const payload = { status: "success", attempts: [], worktreePath: "/x", diff: "d" };
    expect(extractDelegateResult([{ type: "text", text: JSON.stringify(payload) }])).toEqual(payload);
    expect(extractDelegateResult({ content: [{ type: "text", text: JSON.stringify(payload) }] })).toEqual(payload);
    expect(extractDelegateResult("not json")).toBeUndefined();
  });

  it("runs verify.commands inside the worktree and reports results", async () => {
    const wt = path.join(worktreesDir(), "repo-x", "codex-1");
    mkdirSync(wt, { recursive: true });
    writeFileSync(userConfig, JSON.stringify({ verify: { commands: [["node", "-e", "require('fs').writeFileSync('ran.txt','1')"], "node -e \"process.exit(3)\""] } }));
    const resp = [{ type: "text", text: JSON.stringify({ status: "success", attempts: [], worktreePath: wt, diff: "+x" }) }];
    const out = (await postDelegate({ cwd: tmpDir(), tool_response: resp })) as any;
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(existsSync(path.join(wt, "ran.txt"))).toBe(true);
    expect(ctx).toMatch(/FAILURES/);
    expect(ctx).toMatch(/exit 3/);
  });

  it("ignores results without a diff or outside managed worktrees", async () => {
    expect(await postDelegate({ tool_response: [{ type: "text", text: JSON.stringify({ status: "success", attempts: [] }) }] })).toBeUndefined();
    const out = await postDelegate({ tool_response: { status: "success", attempts: [], worktreePath: "/etc", diff: "x" } });
    expect(out).toBeUndefined();
  });

  it("splitCommand honours quotes", () => {
    expect(splitCommand(`npm run lint -- --fix "a b" 'c d' ""`)).toEqual(["npm", "run", "lint", "--", "--fix", "a b", "c d", ""]);
  });
});

describe("/mp-setup: settings.json", () => {
  it("adds attribution off, keeps existing keys and makes a backup", async () => {
    writeFileSync(settingsFile, JSON.stringify({ model: "opus", attribution: { commit: "x", extra: 1 }, permissions: { allow: ["Bash(ls)"] } }));
    const r = await applySettings({ scope: "user", projectDir: tmpDir(), attribution: true, statusLine: false, existingStatusLine: "abort" });
    const s = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(s.attribution).toEqual({ commit: "", pr: "", sessionUrl: false, extra: 1 });
    expect(s.model).toBe("opus");
    expect(s.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(r.backup && existsSync(r.backup)).toBe(true);
    expect(JSON.parse(readFileSync(r.backup!, "utf8")).attribution.commit).toBe("x");
  });

  it("is idempotent and never clobbers invalid JSON", async () => {
    await applySettings({ scope: "user", projectDir: tmpDir(), attribution: true, statusLine: false, existingStatusLine: "abort" });
    const r2 = await applySettings({ scope: "user", projectDir: tmpDir(), attribution: true, statusLine: false, existingStatusLine: "abort" });
    expect(r2.changed).toEqual([]);
    writeFileSync(settingsFile, "{ broken");
    await expect(applySettings({ scope: "user", projectDir: tmpDir(), attribution: true, statusLine: false, existingStatusLine: "abort" })).rejects.toThrow();
    expect(readFileSync(settingsFile, "utf8")).toBe("{ broken");
  });

  it("project scope writes .claude/settings.json in the project", async () => {
    const proj = tmpDir();
    const r = await applySettings({ scope: "project", projectDir: proj, attribution: true, statusLine: false, existingStatusLine: "abort" });
    expect(r.file).toBe(path.join(proj, ".claude", "settings.json"));
    expect(JSON.parse(readFileSync(r.file, "utf8")).attribution.sessionUrl).toBe(false);
  });

  it("installs the status line and composes with an existing one", async () => {
    writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: "command", command: "~/my-line.sh", padding: 1 } }));
    await expect(applySettings({ scope: "user", projectDir: tmpDir(), attribution: false, statusLine: true, existingStatusLine: "abort" })).rejects.toThrow(/already configured/);
    const r = await applySettings({ scope: "user", projectDir: tmpDir(), attribution: false, statusLine: true, existingStatusLine: "compose" });
    expect(r.composedStatusLine).toBe("~/my-line.sh");
    const s = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(s.statusLine.command).toBe(statuslineCommand());
    expect(s.statusLine.padding).toBe(1);
    expect(JSON.parse(readFileSync(userConfig, "utf8")).statusline.compose).toBe("~/my-line.sh");
  });

  it("/mp-statusline stores the mode in the plugin config", async () => {
    writeFileSync(userConfig, JSON.stringify({ chain: ["codex", "claude"] }));
    await setStatuslineMode("full");
    const c = JSON.parse(readFileSync(userConfig, "utf8"));
    expect(c).toEqual({ chain: ["codex", "claude"], statusline: { mode: "full" } });
  });
});

describe("/mp-setup: git commit-msg hook", () => {
  it("strips co-author trailers on commit and chains existing hooks", async () => {
    const repo = makeRepo();
    // Pre-existing hook in a custom hooksPath (like husky).
    const custom = path.join(repo, ".husky");
    mkdirSync(custom);
    writeFileSync(path.join(custom, "commit-msg"), `#!/bin/sh\necho "Co-authored-by: Added By Prev <p@x>" >> "$1"\necho chained > "${path.join(repo, "chained.txt").split(path.sep).join("/")}"\n`);
    chmodSync(path.join(custom, "commit-msg"), 0o755);
    writeFileSync(path.join(custom, "pre-commit"), `#!/bin/sh\necho pre > "${path.join(repo, "pre.txt").split(path.sep).join("/")}"\n`);
    chmodSync(path.join(custom, "pre-commit"), 0o755);
    git(repo, "config", "core.hooksPath", ".husky");

    const r = await installGitHooks(repo);
    expect(r.previousConfigured).toBe(".husky");
    writeFileSync(path.join(repo, "f.txt"), "x");
    git(repo, "add", "-A");
    const msg = "feat: x\n\nbody\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nCo-authored-by: Codex <c@openai.com>\n";
    execFileSync("git", ["commit", "-q", "-F", "-"], { cwd: repo, input: msg });
    expect(git(repo, "log", "-1", "--format=%B")).toBe("feat: x\n\nbody");
    // Identity untouched: whatever git resolves for the user (config or env), not a bot.
    const ident = git(repo, "var", "GIT_AUTHOR_IDENT").replace(/ \d+ [+-]\d{4}$/, "");
    expect(git(repo, "log", "-1", "--format=%an <%ae>")).toBe(ident);
    expect(existsSync(path.join(repo, "chained.txt"))).toBe(true);
    expect(existsSync(path.join(repo, "pre.txt"))).toBe(true);

    // Re-install keeps the original chain target; uninstall restores it.
    const again = await installGitHooks(repo);
    expect(again.previousConfigured).toBe(".husky");
    await uninstallGitHooks(repo);
    expect(git(repo, "config", "core.hooksPath")).toBe(".husky");
  });

  it("works with default .git/hooks and unsets hooksPath on uninstall", async () => {
    const repo = makeRepo();
    await installGitHooks(repo);
    writeFileSync(path.join(repo, "g.txt"), "x");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "fix: y\n\nCo-authored-by: x <y@z>");
    expect(git(repo, "log", "-1", "--format=%B")).toBe("fix: y");
    await uninstallGitHooks(repo);
    expect(() => git(repo, "config", "core.hooksPath")).toThrow();
  });
});
