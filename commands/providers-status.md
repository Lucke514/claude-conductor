---
description: Health check of the delegation providers (binary, version, auth, circuit breaker)
---

Call the `providers_status` tool of the multi-provider MCP server and present the result as a compact table with one row per provider:

| provider | enabled | installed (binary) | version | auth | circuit breaker | available |

- For an open breaker show the remaining cooldown (`breaker.remainingCooldownMs`) in human units.
- `auth: "unknown"` for antigravity is expected: agy has no documented auth-status command (configure `providers.antigravity.authCheckArgs` to probe it).
- After the table, show the fallback chain (e.g. `codex → antigravity → claude`) and, for each unavailable provider, the one most likely fix (install the CLI, `codex login`, run `agy` interactively once to sign in, wait for cooldown, enable it in config).
