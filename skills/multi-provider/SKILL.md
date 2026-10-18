---
name: multi-provider
description: When and how to delegate work from Claude Code to other AI CLIs (OpenAI Codex, Google Antigravity) through the multi-provider MCP tools, and how to supervise their results. Use when a second opinion, a cross-review, parallelizable subtasks or saving Claude quota would help — or when the user asks to use Codex/Antigravity/agy.
---

# Multi-provider delegation

Claude Code is always the **orchestrator and supervisor**. Workers (Codex via `codex exec`, Antigravity via `agy -p`) run locally with their own CLI login, never see this conversation, and never integrate anything on their own.

## When delegating pays off

- **Second opinion** on a design, a tricky bug hypothesis or a risky change.
- **Cross-review**: you wrote the code, another model reviews it (`mode: "read"`), or vice-versa.
- **Parallelizable work**: independent subtasks (several modules to review, tests to draft for separate files) — fire several `delegate` calls/subagents at once.
- **Quota saving**: long mechanical tasks (boilerplate, bulk test scaffolding, docs) when Claude's budget is tight.

## When NOT to delegate

- Critical changes (security, auth, payments, data migrations, infra) — do them yourself; at most ask for a read-only review.
- Tightly coupled context: the task depends on a lot of what was discussed in this conversation and cannot be written down concisely.
- Tiny edits where writing the brief costs more than doing it.
- When `providers_status` shows nothing available — just do the work.

## How to delegate

1. Write a **self-contained brief**: objective, constraints, acceptance criteria, relevant conventions. Pass the key files in `files` (embedded with a size limit; secrets such as `.env`, `~/.codex/auth.json` or keys are never included).
2. Choose `provider`: `codex`, `antigravity`, or `auto` (routing by task type from config, e.g. `review → codex`, `refactor → antigravity`; otherwise first available in the chain).
3. Choose `mode`:
   - `read` (default): analysis/proposals only; runs in a disposable worktree, any file change is discarded and reported.
   - `write`: edits happen in an isolated git worktree on branch `mp/<provider>/<timestamp>`; requires user confirmation (hook).
4. Prefer the `codex-worker` / `agy-worker` subagents: they delegate, verify and return a verdict.

## Supervision flow (mandatory)

1. Read the response: `status`, `attempts`, `violations`, `notes`.
   - `fallback_to_claude` → do the task yourself; `summary` explains why each worker failed.
2. **Verify every claim** against the real code (Read/Grep). Never accept unverified output.
3. With a diff: review it fully; lint/tests run automatically in the worktree when `verify.commands` is configured (PostToolUse hook) — read that report, and run them yourself otherwise.
4. Decide:
   - **Accept** → `delegation_apply(worktreePath)` applies the diff to the user's branch with `git apply --3way` (no commit), then **you** commit with the user's identity — no co-author or attribution lines.
   - **Request changes** → re-delegate with precise feedback, or fix it yourself in the worktree before applying.
   - **Discard** → `delegation_discard(worktreePath)`.
5. `mp/*` branches are never merged; worktrees are removed on apply/discard (stale ones after 24 h).

## Spec-driven tasks

When the work is a task of a spec-driven feature (`specs/<slug>/tasks.md` with approved spec, plan and tasks), use `/sdd-delegate <slug> <T#|next>` instead of writing a brief by hand: `sdd_task_claim` writes the task's `**Owner**`, you commit that claim, and `sdd_task_delegate` builds the brief from the artifacts, runs the task's `Verify` and the plan's gates in the worktree, and returns per-criterion verdicts plus a `Notes` draft. On discard, `sdd_task_release` hands the task back. Ticking the box and writing `Notes` stay yours, after your own review.

## Hard rules

- Workers never commit, push or open PRs (a hook blocks commits; any worker commit is undone with `git reset --soft` and logged as a violation).
- Only Claude commits, with the user's git identity and without AI attribution.
- Workers run without git/GitHub credentials (no tokens, no SSH agent, git limited to local transports, a `gh` that always refuses), so they cannot push or open pull requests. A `worker_push` violation means a branch reached a remote anyway: tell the user and give them the `git push <remote> --delete <branch>` from `nextSteps`.
- Worker changes under `specs/` are restored and never applied (`specs_modified`); in a spec-driven repo, implement through `/sdd-delegate`, and treat `outside_task_files` / `sdd.drift` as spec drift to settle with the user.
- Every delegation is logged (metadata only, prompt hash) in `~/.claude/multi-provider/logs/`.
