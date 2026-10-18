---
description: Disable AI attribution in commits/PRs, install the multi-provider status line and the commit-msg scrubber hook
argument-hint: [user|project]
allowed-tools: Bash(node:*) AskUserQuestion Read
---

Set up multi-provider for this machine/repository. Arguments: `$ARGUMENTS`

1. Decide the settings scope. If the arguments say `user` or `project`, use it. Otherwise ask the user (AskUserQuestion):
   - **user** → `~/.claude/settings.json` (all projects)
   - **project** → `.claude/settings.json` of this repository (shared with the team if committed)
2. Check whether a status line already exists in that settings file (Read it). If a status line exists and it is not the multi-provider one, ask whether to **compose** (run the existing one and append the provider segment — recommended) or **replace** it.
3. Run (pick the flags from the answers):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/server/bootstrap.mjs" cli setup --scope <user|project> [--statusline-compose | --statusline-replace]
   ```

   Other flags: `--no-attribution`, `--no-statusline`, `--no-git-hooks`.

   This command:
   - backs up the settings file (`settings.json.bak-<timestamp>`) and keeps every existing key,
   - sets `"attribution": { "commit": "", "pr": "", "sessionUrl": false }`,
   - sets `statusLine` to the multi-provider script (copied to `~/.claude/multi-provider/statusline.js`, a stable path that survives plugin updates),
   - installs a git `commit-msg` hook in this repo through `core.hooksPath`, chaining any hooks that already existed (husky etc.). It removes `Co-authored-by:` lines (any author, including Codex/agy), `Generated with [Claude Code]…`, `🤖 Generated…` and claude.ai session URLs.
4. Show the JSON report: settings file, backup path, what changed, the hooks dir and the previous hooks path it chains to.
5. Remind the user: restart Claude Code (or open `/hooks` / `/statusline`) for settings to apply; undo the git hook with `node "${CLAUDE_PLUGIN_ROOT}/server/bootstrap.mjs" cli git-hooks uninstall`.
