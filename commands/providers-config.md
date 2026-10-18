---
description: Show the effective multi-provider configuration (merged and validated)
---

Call the `providers_config` tool of the multi-provider MCP server.

Show:
1. Which config files were loaded (`sources`), in merge order: defaults ← `<project>/.claude/multiprovider.json` ← `~/.claude/multiprovider.json` (the user file wins).
2. The effective config as a JSON block.
3. A short summary: chain, routing rules, default mode/timeout/maxFileBytes, circuit breaker, retry policy, verify commands, and per provider `enabled`, `binaryPath`, `model`, `usePty`, `extraArgs`.

If the tool returns a validation error, show the exact path and message and suggest the fix. A full example lives in `${CLAUDE_PLUGIN_ROOT}/config/multiprovider.example.json`.
