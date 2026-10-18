import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Fixtures for the SDD tests: a Standard feature with spec, plan and tasks. */

export const SPEC = `# Spec: Demo

> Status: approved

## Requirements

- **R1** — La herramienta resuelve la tarea.
  - Given una tarea, when se delega, then se usa su bloque.
- **R2** — Segunda regla.

## Edge cases & error behavior

- **E1** — Slug inexistente.
- **E2** — Tarea inexistente.
`;

export const PLAN = `# Plan: Demo

> Status: approved

## Quality gates

| Gate | Command | Where | Baseline |
|---|---|---|---|
| Tests | \`node -e "process.exit(0)"\` | \`here\` | \`3 passed, 0 failed\` |
| Dist | \`git diff --exit-code\` | \`pipeline-only\` | \`—\` |
| Lint | — no tooling | — | — |

## Components

### C1 — Lector

- **Implements**: R1

### C2 — Brief

- **Implements**: R2, E2

## Build order
`;

export const TASKS = `# Tasks: Demo

> Status: approved

## T1 — Hecha

- [x] Done
- **Owner**: —
- **Component**: C1 · **Implements**: R1
- **Files**: \`index.ts\`
- **Do**: algo.
- **Acceptance**: algo.
- **Verify**: \`node -e "1"\`
- **Notes**: listo

## T2 — Bloqueada

- [!] Blocked — 2026-10-18, falta acceso
- **Owner**: —
- **Component**: C1 · **Implements**: R1
- **Files**: \`index.ts\`
- **Verify**: \`node -e "1"\`
- **Notes**: —

## T3 [P] — Construir el brief

- [ ] Done
- **Owner**: —
- **Component**: C2 · **Implements**: R1, E2
- **Files**: \`index.ts\`, \`src/nuevo.ts\`, \`.env\`
- **Do**: Escribir el brief con acentos: «añadir» y ñ.
- **Acceptance**: El brief contiene R1 y E2.
- **Verify**: \`node -e "process.exit(0)"\`
- **Notes**: —

## T4 [P] — Reclamada

- [ ] Done
- **Owner**: codex (multi-provider) since 2026-10-18
- **Component**: C2 · **Implements**: R2
- **Files**: \`index.ts\`
- **Verify**: revisión manual
- **Notes**: —

---

## Gaps found in verification

## G1 — Hueco

- [ ] Done
- **Owner**: —
- **Component**: C1 · **Implements**: R9
- **Files**: \`index.ts\`
- **Verify**: \`node -e "1"\`
- **Notes**: —

---

## Verification reports
`;

export function writeFeature(root: string, slug: string, files: Record<string, string>): void {
  const dir = path.join(root, "specs", slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
}

/** Snapshot of specs/sdd-task-delegation/tasks.md. */
export const DELEGATION_REPORT = `## Verification reports

### Verification report — sdd-task-delegation — 2026-10-18 — pass 1

Change set: \`3ea6976\` (\`main@b5b0714...HEAD\`)
Converged: no — awaiting the user's decision on R10/SC1 (a real \`/sdd-delegate\` run with \`codex\` or \`agy\`, or accepting it as a documented limitation)

| Req | Verdict | Evidence (case · assertion · clause) |
|---|---|---|
| R1 | met | \`sdd-artifacts.spec.ts::"R1: resolves T3 with its fields…"\` — asserts id, Files, Do, Acceptance, Verify, Implements, Component of T3; runner: \`1 passed\`; negative control: \`resolveTask\` returning the first task → \`1 failed\`. Code \`server/src/sdd/artifacts.ts\` (\`resolveTask\`), tool entry \`server/src/index.ts\` (\`sdd_task_claim\`) |
| R2 | met | \`sdd-artifacts.spec.ts::"R2: next skips done, blocked and claimed tasks"\` — asserts T3, then G1 once T3 has an owner; runner: \`1 passed\`; negative control: ignoring the owner → \`1 failed\` |
| R3 | met | \`sdd-brief.spec.ts::"R3: carries Do, Acceptance, Verify, Files and the literal R#/E#/C# texts and gates"\` — asserts literal R1 (with its Given line), E2, C2 section, gate commands, and that uncited R2 is absent; runner: \`1 passed\`; negative control: no requirements in the brief → \`1 failed\`. Code \`server/src/sdd/brief.ts\` |
| R4 | met | \`sdd-brief.spec.ts::"R4/E5: embeds existing files, marks missing ones to be created…"\` — asserts \`index.ts\` embedded and \`src/nuevo.ts\` "does not exist yet — to be created"; runner: \`1 passed\`; negative control: ENOENT branch removed → \`1 failed\`. Code \`server/src/prompt-builder.ts\` |
| R5 | met | \`sdd-claim.spec.ts::"R5: rejects unapproved spec, tasks or existing plan, and closed tasks"\` — asserts the error names each artifact and \`Status: in-review\`, and \`[x]\`/\`[!]\`/\`[~]\`/\`[>]\` rejected; runner: \`1 passed\`; negative control: Status check disabled → \`1 failed\`. No worktree clause: the check runs before \`delegate()\` (\`server/src/sdd/task-delegation.ts\`), covered by R6's case (worker not invoked) |
| R6 | met | \`sdd-task-delegation.spec.ts::"R6/SC2: claim writes the Owner; delegate refuses to start a worker until the claim is committed"\` — asserts Owner line written, \`CLAIM_NOT_COMMITTED\` and no \`FAKE_ARGS_FILE\` (CLI never ran); \`sdd-claim.spec.ts::"E10/SC2…"\` asserts \`claimCommitted\` false→true around the commit; runner: \`1 passed\` each; negative control: commit check removed → \`1 failed\` ("promise resolved … instead of rejecting") |
| R7 | met | \`sdd-verify.spec.ts::"R7: runs Verify and gates without a shell…"\` — asserts pass/fail per command, output tail, \`newFailure\` true / false / "compare" against the baseline, pipeline-only manual; \`sdd-task-delegation.spec.ts::"R8…"\` asserts it runs inside the delegation worktree; runner: \`1 passed\`; negative control: \`newFailure\` not set → \`1 failed\` |
| R8 | met | \`sdd-task-delegation.spec.ts::"R8: write mode returns the diff, the verification, per-item verdicts and a Notes draft; tasks.md is not ticked"\` — asserts A1 met / R1 not met / E2 unverifiable, \`notesDraft\` with the delegation id, no \`[x]\` and Notes untouched; runner: \`1 passed\`; negative control: verdicts ignored → \`1 failed\` |
| R9 | met | \`sdd-task-delegation.spec.ts::"R9: when every provider fails the Owner goes back to —"\` — asserts \`fallback_to_claude\`, \`handback\` commit and tasks.md byte-identical to the original; \`"R9: sdd_task_release frees a claimed task…"\`; runner: \`1 passed\` each; negative control: handback write removed → \`1 failed\` |
| R10 | partially met | \`commands/sdd-delegate.md\` documents the four arguments, defaults \`auto\`/write and both outcomes; \`claude plugin validate .\` → \`√ Validation passed\`. Not exercised end to end: this environment has neither \`codex\` nor \`agy\` (SC1) |
| E1 | met | \`sdd-artifacts.spec.ts::"E1: an unknown slug lists the available features"\` — asserts \`Available features: demo\`, missing tasks.md, invalid slug; runner: \`1 passed\`; negative control: empty slug list → \`1 failed\` |
| E2 | met | \`sdd-artifacts.spec.ts::"E2: an unknown task or an empty next lists open tasks and owners"\` — asserts the exact list with owners and \`NO_OPEN_TASK\`; runner: \`1 passed\`; negative control: empty list → \`1 failed\` |
| E3 | met | \`sdd-verify.spec.ts::"E3: a command with shell syntax is never run…"\` — asserts \`manual\` with \`(&&)\` and that file \`x\` still exists; runner: \`1 passed\`; negative control: detection off → \`1 failed\` |
| E4 | met | \`sdd-artifacts.spec.ts::"E4: a cited R#/E# or C# missing from the artifacts is rejected by id"\` — asserts \`G1 cites R9\`, \`T3 cites C7\`; runner: \`1 passed\` |
| E5 | met | \`sdd-brief.spec.ts::"R4/E5…"\` — asserts \`.env\` reported "sensitive file … never shared" and \`hunter2\` absent from the prompt; runner: \`1 passed\`; negative control: \`isSensitivePath\` → false → \`1 failed\` |
| E6 | met | \`sdd-claim.spec.ts::"E6: a claimed task cannot be claimed again…"\` and \`sdd-task-delegation.spec.ts::"R6/SC2…"\` (second claim → \`TASK_CLAIMED\`, before any worktree); runner: \`1 passed\` each |
| E7 | met | \`sdd-artifacts.spec.ts::"E7: a Small feature reads tasks, gates and Status from spec.md"\`; runner: \`1 passed\` |
| E8 | met | \`sdd-artifacts.spec.ts::"R1…"\` — asserts the Spanish Do text with «», ñ and accents copied verbatim; runner: \`1 passed\` |
| E9 | met | \`sdd-task-delegation.spec.ts::"E9: a failing Verify keeps the worktree and the claim"\` — asserts exit 4, \`verified: false\`, worktree exists, Owner intact; runner: \`1 passed\` |
| E10 | met | \`sdd-claim.spec.ts::"E10/SC2…"\` — runs the returned command with \`index.ts\` modified; asserts the commit holds only \`specs/demo/tasks.md\` and \`index.ts\` stays modified; runner: \`1 passed\` |

Coverage: surfaces API ✅ (R1–R9, MCP tools) · CLI ✅ (R10, partially met) · sensitive ground: access control non-goal · traceability R9 · data handling E5 · data lifecycle non-goal · repeat-request correctness E6 · accessibility non-goal (no UI)
Gates: typecheck ✅ exit 0 · tests ✅ \`Test Files 16 passed (16) · Tests 181 passed (181)\` (baseline 154 passed (154); +27 new, 0 skipped) · \`claude plugin validate .\` ✅ \`√ Validation passed\` · \`claude plugin test .\` ✅ \`7 pass, 0 fail\` · Pipeline: run 39094610235 on \`2f6a7fc\` (same code as the change set; later commits touch only this file) — \`dist is up to date\` ✅ · \`claude plugin validate / test\` ✅ · \`test\` ubuntu/macos/windows × Node 20/22 ✅ 6/6
Attribution: none — no failure required attribution
Tests removed: none
Clean-code sweep: none · close calls: \`parseStatus\`/\`parseRequirements\`/\`parseComponents\` are exported but only used inside \`artifacts.ts\` — kept, they are the module's parsing surface next to the tested \`parseTasks\`/\`parseGates\`
Shortcuts declared: none
Dead-code sweep: none — every new export reached by \`server/src/index.ts\` (tool registration) or by the modules it calls; \`tsc --noUnusedLocals --noUnusedParameters\` reports nothing in the change set (scope: this tree) · declared duplications: \`parseTasks\` vs \`hooks/conductor/model.ts\` and \`verifyTask\` vs \`hooks.ts → runVerify\` (plan C1/C4 **Duplicates**)
Excluded from inventory: none
Documentation: \`docs/sdd-task-delegation.md\` (with Operating → Signal) and README sections match the schemas in \`server/src/index.ts\`
Success criteria: SC1 pending — needs a real \`/sdd-delegate\` run with \`codex\` or \`agy\` installed · SC2 met on emission — \`sdd-task-delegation.spec.ts::"R6/SC2…"\` and \`sdd-claim.spec.ts::"E10/SC2…"\`; this feature's own history shows \`sdd-task-delegation: claim T#\` before each \`T#\` commit
Integration: pending review (Lucke514/claude-conductor#8)
`;

/** Snapshot of specs/sdd-integration/scope.md. */
export const INTEGRATION_SCOPE = `<!-- Row Status enum: pending | in-progress | done | deferred | abandoned -->

# Scope: Integración de spec-driven (SDD) en multi-provider

> Last updated: 2026-10-18

Integrar el flujo de [spec-driven](https://github.com/Lucke514/spec-driven) en el plugin \`multi-provider\`, para que las delegaciones a Codex y Antigravity operen sobre los artefactos SDD (spec, plan, tasks) en lugar de prompts sueltos. El usuario aprobó la división y el orden el 2026-10-18.

| Slug | Responsibility | Depends-on | Rank | Status |
|---|---|---|---|---|
| sdd-task-delegation | Delegar una tarea \`T#\`/\`G#\` de \`tasks.md\` con un brief construido desde spec, plan y tasks, verificarla con su \`Verify\` y los gates del plan, y registrar el claim del \`Owner\` | — | 1 | in-progress |
| sdd-guardrails | Impedir que la auto-delegación (\`/mp-auto\`) delegue trabajo no trivial sin spec y tasks aprobados, impedir que los workers toquen \`specs/\`, marcar como spec drift los diffs que salen de los \`Files\` de la tarea, y quitar al worker las credenciales de git y GitHub para que no pueda hacer push ni abrir PRs | sdd-task-delegation | 2 | done |
| sdd-cross-review | Pedir una segunda opinión en modo read a otro proveedor: red team del spec (fases 1–2) y Audit mode independiente en la fase 7, que Claude reconcilia | — | 3 | pending |
| sdd-parallel-dispatch | Repartir los grupos \`[P]\` de \`tasks.md\` entre proveedores a la vez, cada uno en su worktree | sdd-task-delegation | 4 | pending |
| sdd-traceability | Pipeline de etapas por feature (Spec → Plan → Tasks → Implementación → Verificación → Cerrada) deducido de los artefactos, con avisos de incoherencia y siguiente paso (\`sdd_feature_status\`, \`/sdd-status\`); registrar \`slug\` y \`taskId\` en el log de auditoría y en \`state.json\`, y mostrar el avance en la conductor card | sdd-task-delegation | 5 | in-progress |
| sdd-packaging | Publicar spec-driven como plugin en este marketplace y declararlo dependencia de \`multi-provider\` | — (requiere acceso de escritura a \`Lucke514/spec-driven\`) | 6 | pending |
`;
