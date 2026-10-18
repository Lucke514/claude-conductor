---
description: Switch the multi-provider status line mode (full, compact, off)
argument-hint: full|compact|off
allowed-tools: Bash(node:*)
---

Set the multi-provider status line mode to `$ARGUMENTS`.

If the argument is not exactly one of `full`, `compact` or `off`, explain the modes and stop:
- `full`: Claude line + one line per provider (status, session/day calls, tokens, time, last error) + chain.
- `compact`: a single line, e.g. `Opus · ctx 42% │ codex ✓ 3 · 12k │ agy ⏸ 2m │ codex→agy→claude`.
- `off`: only the Claude Code line.

Otherwise run:

```
node "${CLAUDE_PLUGIN_ROOT}/server/bootstrap.mjs" cli statusline-mode $ARGUMENTS
```

The mode is stored as `statusline.mode` in `~/.claude/multiprovider.json`. If the status line is not installed yet, suggest `/mp-setup`.
