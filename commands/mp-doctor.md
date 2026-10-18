---
description: End-to-end self check of multi-provider (node, git, config, node-pty, each CLI's install/auth and a real one-line run)
argument-hint: "[--no-live]"
allowed-tools: Bash(node:*)
---

Run the multi-provider doctor. Argument: `$ARGUMENTS`

1. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/server/bootstrap.mjs" cli doctor $ARGUMENTS
   ```

   Without `--no-live` it sends one tiny read-only prompt ("reply OK") to each usable provider inside a throwaway git repo, never in this project. That costs a few tokens per provider and can take up to two minutes.

2. Show the output as is (one line per check: `✓` ok, `!` warning, `✗` failure, `-` skipped). Exit code 0 means everything passed; 3 means at least one check failed.

3. For each failing check, explain its `fix:` line in one sentence. If the live run fails but `/providers-status` looks fine, it usually means the CLI flags changed in a new release: point at `providers.<name>.extraArgs` / `readModeArgs` in `.claude/multiprovider.json`.
