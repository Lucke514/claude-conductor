---
description: Delegate a task to Codex, Antigravity or auto-routing, then supervise the result
argument-hint: <codex|antigravity|agy|auto> [--write] <task>
---

Delegate this task through the multi-provider plugin and supervise the result.

Raw arguments: `$ARGUMENTS`

1. Parse the arguments: the first word is the provider (`codex`, `antigravity`, `agy` = antigravity, or `auto`). If the first word is none of these, use `auto` and treat the whole input as the task. A `--write` flag anywhere means `mode: "write"`; otherwise use `mode: "read"`. `--repo <path>` anywhere means `repo: "<path>"` (a nested code repo, relative to the project); when the code lives in a nested repo and no `--repo` was given, pick it yourself (`/mp-doctor` lists them under `workspace repos`).
2. Turn the task into a **self-contained** brief (the worker does not see this conversation): objective, constraints, acceptance criteria. Identify the relevant files and pass them in `files`.
3. Delegate via the matching subagent so the result is verified independently:
   - codex → `codex-worker`; antigravity → `agy-worker`;
   - auto → call the `delegate` MCP tool with `provider: "auto"` yourself, then verify like the worker agents do.
4. Handle the result (report `provider`, the one that answered; if it differs from `requestedProvider`, say so):
   - `fallback_to_claude` → explain briefly why (from `summary`) and do the task yourself.
   - Write mode with a diff and an **ACCEPT** verdict → show the user the diff summary and verification results, and only after their OK call `delegation_apply` with the `worktreePath`, then commit yourself with the user's git identity (no co-author/attribution lines).
   - REQUEST_CHANGES / DISCARD → explain, and either fix it yourself, re-delegate, or call `delegation_discard`.
5. Never merge `mp/*` branches and never accept output you have not verified.
