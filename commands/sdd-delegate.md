---
description: Delegate one task of a spec-driven feature (specs/<slug>/tasks.md) to Codex or Antigravity, verified against its own Verify and the plan's gates
argument-hint: <slug> <T#|G#|next> [codex|antigravity|agy|auto] [--read]
---

Delegate a spec-driven task through the multi-provider plugin and supervise the result.

Raw arguments: `$ARGUMENTS`

1. Parse the arguments: the first word is the feature slug (a folder under `specs/`), the second is the task (`T3`, `G1` or `next`). An optional `codex`, `antigravity` (`agy` = antigravity) or `auto` picks the worker; without it use `auto`. `--read` anywhere means `mode: "read"` (research); otherwise `mode: "write"`.
2. **Claim**: call `sdd_task_claim` with `slug`, `task` and `provider`. A task with `**Repo**` is resolved by the tool (the spec's `.claude/worktrees/<slug>/<Repo>`, else `<Repo>` at the root) and returned as `repo`; mention it. On an error (unapproved artifact, closed or claimed task, unknown slug or task, `REPO_NOT_FOUND`) show it to the user and stop — never edit the artifacts to get past it.
3. **Commit the claim yourself** with the exact `commit` command the tool returned (Bash). It commits only the tasks file, even with other changes in the tree. No `Co-Authored-By`, `Generated with` or any other attribution trailer.
4. **Delegate**: call `sdd_task_delegate` with `slug`, the `taskId` the claim returned and `mode`. It refuses to start a worker until the claim is committed.
5. Present the result: the worker's summary, `filesChanged`, `sdd.verification` (each command pass / fail / manual, and for gates `newFailure`: `true` is a new failure, `"compare"` means compare by hand with the quoted baseline) and `sdd.acceptance` (met / not met / unverifiable per item). Verify the worker's claims against the real code before recommending anything.
6. Close it:
   - **`sdd.handback` present** (no worker completed the task): run its `commit` command, then offer to do the task yourself.
   - **Accept** (only after the user's OK): `delegation_apply` with the `worktreePath`; review the change against the clean-code checklist; tick the task's box, fill its `**Notes**` from `sdd.notesDraft` (replace the placeholders with the real commit and your review), set its `**Owner**` back to `—`, and commit everything as `<slug>: <T#> <what landed>` — again without attribution trailers.
   - **Reject**: `delegation_discard` with the `worktreePath`, then `sdd_task_release`, and commit the handback with the command it returns.
7. The tools never tick a box, write `Notes` or change a `Status`, and `mp/*` branches are never merged.
