---
description: Show where each spec-driven feature stands (Spec → Plan → Tasks → Implementación → Verificación → Cerrada), with warnings and the next step
argument-hint: [slug]
---

Show the spec-driven pipeline of this repository. Read-only: nothing is written and no suggested step is run.

Raw arguments: `$ARGUMENTS`

1. Call the `sdd_feature_status` tool of the multi-provider MCP server, with `slug` when an argument was given and without it otherwise. On an error (unknown slug) show it, with the available features it lists, and stop.
2. **Without slug** (`features`): one line per feature in the order returned. Draw the stages as a pipeline, `✓` for passed stages, `▸` for the current one and `·` for the pending ones (a Small feature has no Plan and Tasks; `Descartada` and `Desconocida` replace the pipeline with their name), then the task progress `closed/total`, the current task with its owner, `⚠ N` when there are warnings and the next step. Example:

   ```
   sdd-traceability   ✓ Spec ✓ Plan ✓ Tasks ▸ Implementación · Verificación · Cerrada   4/7 · T5 claude · ⚠ 1
                      → /sdd-delegate sdd-traceability next
   ```

   If `notes` says "no SDD features", say the repository has no `specs/<slug>/spec.md` and stop.
3. **With slug** (the full status): the same pipeline line, then the Status of each artifact, the open tasks with their owner, the last verification report (pass, converged, verdict counts), each warning with its code and detail, and the next step.
4. Explain each warning code in one short clause when it appears: `ready_to_close` (verification converged, spec not yet implemented), `orphan_claim` (a task claimed by a worker with no delegation in progress or recent: release it with `sdd_task_release` or delegate it again), `closed_with_open_tasks`, `scope_mismatch` (the `scope.md` row disagrees with the stage), `violations` (guardrail violations of that task's delegations), `malformed` (an artifact without a readable `> Status:`).
5. Show `notes` (for example "delegation state unavailable") after the pipeline. Never run the next step, tick a box, edit an artifact or change a Status from this command.
