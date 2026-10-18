---
description: Turn multi-provider auto-delegation on or off, or show its status
argument-hint: on|off|status
allowed-tools: Bash(node:*)
---

Manage multi-provider auto-delegation. Argument: `$ARGUMENTS`

With auto-delegation on, a `UserPromptSubmit` hook asks Claude to decide on every message whether the request is worth delegating to Codex or Antigravity (`delegate` with `provider: "auto"`), without the user typing `/delegate`. Conversation, quick questions, tiny edits and `/` commands are never delegated; write mode still asks for confirmation and diffs are only applied with the user's OK.

1. If the argument is empty, treat it as `status`.
2. If it is not exactly `on`, `off` or `status`, explain the three options above and stop.
3. Otherwise run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/server/bootstrap.mjs" cli auto-delegate <on|off|status>
   ```

4. Report the result in one line. The value is stored as `autoDelegate.enabled` in `~/.claude/multiprovider.json` and applies from the next message on (no restart needed). If it was turned on, mention that `/providers-status` shows which providers are available.
