<!-- Status enum: draft | in-review | approved | abandoned -->

# Tasks: Delegación de tareas SDD

> Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md)
> Status: approved
> Last updated: 2026-10-18

Una tarea = una sesión. Hecha significa: su **Verify** pasa, los gates del plan pasan sin fallos nuevos contra su baseline (`npm --prefix server run typecheck`, `npm --prefix server test`, `claude plugin validate .`, `claude plugin test .`), `server/dist` está reconstruido y committeado si la tarea toca `server/src`, y el diff está limpio. Commits con prefijo `sdd-task-delegation: `, solo de Claude y sin trailers de atribución.

## T1 — Lector de artefactos SDD

- [x] Done
- **Owner**: —
- **Component**: C1 · **Implements**: R1, R2, E1, E2, E4, E7, E8
- **Files**: `server/src/sdd/artifacts.ts`, `server/tests/sdd-artifacts.spec.ts`
- **Do**: Implementar `loadFeature(projectDir, slug)` y `resolveTask(feature, ref)` según C1: Status de cada artefacto, tareas con sus campos y `[P]`, texto literal de `R#`/`E#` de `spec.md`, secciones `### C#` y tabla Quality gates de `plan.md`, modo Small desde `## Tasks` del `spec.md`. Errores con slugs disponibles (E1), tareas abiertas y owners (E2) e id inexistente en `Implements`/`Component` (E4).
- **Acceptance**: `T3` se resuelve con Files, Do, Acceptance, Verify e Implements; `next` salta `[x]`, `[!]` y tareas con owner; slug, tarea o `R#` inexistentes devuelven el error descrito; una feature Small y una en español se leen igual.
- **Verify**: `npm --prefix server test -- sdd-artifacts`
- **Notes**: `server/src/sdd/artifacts.ts` (`loadFeature`, `resolveTask`, `checkReferences`, parsers de Status/tareas/R#/C#/gates) y `server/tests/sdd-artifacts.spec.ts` (7 casos) con fixtures en `server/tests/sdd-fixtures.ts`; commit `sdd-task-delegation: T1 SDD artifact reader`. Gates: typecheck 0 errores, 161 passed (154 + 7). Clean-code: none · close calls: `parseTasks` acepta `###` además de `##` para el `## Tasks` de una feature Small — se queda, es lo que lee E7

## T2 [P] — Brief de la tarea

- [x] Done
- **Owner**: —
- **Component**: C2 · **Implements**: R3, R4, E5
- **Files**: `server/src/sdd/brief.ts`, `server/src/prompt-builder.ts`, `server/tests/sdd-brief.spec.ts`
- **Do**: Implementar `buildTaskBrief(feature, task)` con Do, Acceptance, Verify, Files, el texto de cada `R#`/`E#` citado, la sección `C#` y los comandos de los gates; `extraOutput` con la sección `## Acceptance` del worker. En `buildPrompt`: `extraOutput?` y `reason: "does not exist yet — to be created"` para archivos listados inexistentes.
- **Acceptance**: El prompt contiene literal R1, E2 y C2 de los fixtures; los archivos existentes van incrustados, el inexistente figura "to be created" y `.env` figura excluido sin su contenido; `delegate.spec.ts` sigue pasando.
- **Verify**: `npm --prefix server test -- sdd-brief delegate`
- **Notes**: `server/src/sdd/brief.ts` (`buildTaskBrief`, `acceptanceItems`) y en `server/src/prompt-builder.ts` `extraOutput` y el motivo "does not exist yet — to be created" para archivos inexistentes; `server/tests/sdd-brief.spec.ts` (3 casos); commit `sdd-task-delegation: T2 task brief`. Gates: typecheck 0 errores, 164 passed. Clean-code: none · close calls: el criterio de Acceptance se parte por `; ` en ítems A1…An — se queda, es la unidad por la que el worker responde (R8)

## T3 [P] — Claim y handback

- [x] Done
- **Owner**: —
- **Component**: C3 · **Implements**: R5, R6, R9, E6, E10
- **Files**: `server/src/sdd/claim.ts`, `server/tests/sdd-claim.spec.ts`
- **Do**: Implementar `checkDelegable`, `writeOwner` (reescribe solo la línea `**Owner**` de la tarea, atómico), `claimCommitted` (`git show HEAD:specs/<slug>/tasks.md` + árbol no revertido) y el comando de commit con pathspec `-- specs/<slug>/tasks.md`.
- **Acceptance**: Rechazo por Status no aprobado de spec, tasks o plan existente, y por casilla `[x]`/`[~]`/`[>]`/`[!]` u otro owner; segundo claim rechazado; `writeOwner` cambia una sola línea; con otro archivo modificado, ejecutar el comando devuelto commitea solo `tasks.md`; `claimCommitted` es falso antes del commit y verdadero después.
- **Verify**: `npm --prefix server test -- sdd-claim`
- **Notes**: `server/src/sdd/claim.ts` (`checkDelegable`, `replaceOwner`/`writeOwner`, `commitCommand` con pathspec, `claimCommitted` vía `HEAD:./<ruta>`) y `server/tests/sdd-claim.spec.ts` (4 casos); commit `sdd-task-delegation: T3 claim and handback`. Gates: typecheck 0 errores, 168 passed. Clean-code: none · close calls: `claimCommitted` usa `HEAD:./ruta` relativo al cwd en vez de una ruta relativa a la raíz — se queda, evita el desajuste `/var` vs `/private/var` y nombres 8.3 que ya rompieron CI en macOS/Windows

## T4 [P] — Verificación de la tarea

- [x] Done
- **Owner**: —
- **Component**: C4 · **Implements**: R7, E3, E9
- **Files**: `server/src/sdd/verify.ts`, `server/tests/sdd-verify.spec.ts`
- **Do**: Implementar `verifyTask(worktreePath, task, gates, timeoutMs)`: detección de sintaxis de shell → `manual` sin ejecutar; `splitCommand` + `runProcess` sin shell; gates `pipeline-only` → `manual`; `newFailure` según la baseline (true solo si registra 0 fallos, `"compare"` si registra preexistentes); no borra el worktree.
- **Acceptance**: Un Verify que pasa y otro que falla se informan con extracto de salida; `node -e "process.exit(1)"` con baseline de 0 fallos → `newFailure: true`; `npm test && rm -rf x` queda `manual` y el archivo `x` sigue existiendo; el worktree existe tras un fallo.
- **Verify**: `npm --prefix server test -- sdd-verify`
- **Notes**: `server/src/sdd/verify.ts` (`verifyTask`, `shellSyntax`, `baselineIsClean`) y `server/tests/sdd-verify.spec.ts` (4 casos); commit `sdd-task-delegation: T4 task verification`. Gates: typecheck 0 errores, 172 passed. Clean-code: none · close calls: `$` y backticks dentro de comillas dobles cuentan como shell (se expanden) — se queda, E3 pide no ejecutar nada que dependa de una shell

## T5 — Herramientas MCP `sdd_task_*`

- [x] Done
- **Owner**: —
- **Component**: C5 · **Implements**: R1, R5, R6, R8, R9, E6, E9
- **Files**: `server/src/sdd/task-delegation.ts`, `server/src/index.ts`, `server/tests/sdd-task-delegation.spec.ts`, `server/tests/fixtures/fake-codex.mjs`
- **Do**: Implementar y registrar `sdd_task_claim`, `sdd_task_delegate` (mode por defecto write, provider del Owner, error sin worker si el claim no está committeado, C4 tras el diff, `sdd.acceptance` parseado y `notesDraft` con el id, handback en `fallback_to_claude`/`failed`) y `sdd_task_release`. Añadir al CLI falso un modo que emita la sección `## Acceptance`.
- **Acceptance**: Sin commit del claim → error y el CLI falso no se invoca; con commit → diff, verificación y veredictos; criterio sin línea → `unverifiable`; todos los proveedores fallan → Owner `—`; Verify falla → worktree conservado y Owner intacto; `tasks.md` nunca recibe `[x]` ni Notes.
- **Verify**: `npm --prefix server test -- sdd-task-delegation`
- **Notes**: `server/src/sdd/task-delegation.ts` (`sddTaskClaim`, `sddTaskDelegate`, `sddTaskRelease`, `parseAcceptance`), registro en `server/src/index.ts` (errores con `code`), `extraOutput` en `DelegateParams`, modo `message` en `server/tests/fixtures/fake-codex.mjs` y `server/tests/sdd-task-delegation.spec.ts` (7 casos); control negativo de R6: sin la comprobación del claim el test falla ("promise resolved … instead of rejecting"); commit `sdd-task-delegation: T5 sdd_task_* MCP tools`. Gates: typecheck 0 errores, 179 passed. Clean-code: none · close calls: `sdd_task_delegate` rechaza `next` — se queda, la tarea ya debe estar reclamada y `next` elegiría otra

## T6 — Confirmación en write y `sessionId` para `sdd_task_delegate`

- [x] Done
- **Owner**: —
- **Component**: C5 · **Implements**: R10
- **Files**: `server/src/hooks.ts`, `hooks/hooks.json`, `server/tests/hooks-setup.spec.ts`
- **Do**: `preDelegate` trata `mode` ausente como write cuando la herramienta es `sdd_task_delegate`; añadir su matcher al PreToolUse de `pre-delegate` en `hooks.json`.
- **Acceptance**: Una llamada a `sdd_task_delegate` sin `mode` pide confirmación e inyecta `sessionId`; con `mode: "read"` no pide confirmación; `delegate` sin cambios de comportamiento.
- **Verify**: `npm --prefix server test -- hooks-setup`
- **Notes**: `preDelegate` en `server/src/hooks.ts` trata `mode` ausente como write para `sdd_task_delegate` y nombra slug/tarea en la confirmación; matcher nuevo en `hooks/hooks.json` (solo PreToolUse); 2 casos en `server/tests/hooks-setup.spec.ts`; commit `sdd-task-delegation: T6 write confirmation for sdd_task_delegate`. Gates: typecheck 0 errores, 181 passed, plugin validate ok, plugin test 7 pass. Clean-code: none · close calls: none

## T7 — Slash command `/sdd-delegate`

- [x] Done
- **Owner**: —
- **Component**: C6 · **Implements**: R10
- **Files**: `commands/sdd-delegate.md`, `skills/multi-provider/SKILL.md`
- **Do**: Escribir el comando con el flujo claim → commit (sin trailers) → delegate → presentación → apply + commit `sdd-task-delegation: T# …` tras el OK del usuario, o discard + release + commit del handback; defaults `auto` y write, `--read` opcional. Mencionar el flujo en la skill.
- **Acceptance**: El comando documenta los cuatro argumentos y los dos desenlaces; `claude plugin validate .` lo acepta.
- **Verify**: `claude plugin validate .`
- **Notes**: `commands/sdd-delegate.md` (argumentos, defaults auto/write, flujo claim → commit → delegate → apply o discard + release) y sección "Spec-driven tasks" en `skills/multi-provider/SKILL.md`; commit `sdd-task-delegation: T7 /sdd-delegate command`. Gates: plugin validate ok. Clean-code: none · close calls: none

## T8 — Document the feature

- [x] Done
- **Owner**: —
- **Component**: — · **Implements**: all (documentation)
- **Files**: `docs/sdd-task-delegation.md`, `README.md`
- **Do**: Escribir `docs/sdd-task-delegation.md` (flujo, herramientas, respuesta, límites: E3, comparación con baseline, Owner con fallback); sección en el README con `/sdd-delegate` y las tres herramientas.
- **Acceptance**: La doc describe el comportamiento real; cada ejemplo de invocación coincide con los esquemas registrados en `index.ts`.
- **Verify**: comparar cada ejemplo con `server/src/index.ts` y ejecutar `/sdd-delegate` sobre una tarea de prueba (SC1)
- **Notes**: `docs/sdd-task-delegation.md` (uso, interfaz de las tres herramientas y del comando, notas de comportamiento, señal) y README (sección `/sdd-delegate`, filas de las herramientas, estructura); ejemplos cotejados con los esquemas de `server/src/index.ts`; commit `sdd-task-delegation: T8 document the feature`. La ejecución real de `/sdd-delegate` (SC1) queda pendiente: este entorno no tiene `codex` ni `agy`. Clean-code: none · close calls: none

---

## Gaps found in verification

---

## Verification reports

### Verification report — sdd-task-delegation — 2026-10-18 — pass 1

Change set: `3ea6976` (`main@b5b0714...HEAD`)
Converged: no — awaiting the user's decision on R10/SC1 (a real `/sdd-delegate` run with `codex` or `agy`, or accepting it as a documented limitation)

| Req | Verdict | Evidence (case · assertion · clause) |
|---|---|---|
| R1 | met | `sdd-artifacts.spec.ts::"R1: resolves T3 with its fields…"` — asserts id, Files, Do, Acceptance, Verify, Implements, Component of T3; runner: `1 passed`; negative control: `resolveTask` returning the first task → `1 failed`. Code `server/src/sdd/artifacts.ts` (`resolveTask`), tool entry `server/src/index.ts` (`sdd_task_claim`) |
| R2 | met | `sdd-artifacts.spec.ts::"R2: next skips done, blocked and claimed tasks"` — asserts T3, then G1 once T3 has an owner; runner: `1 passed`; negative control: ignoring the owner → `1 failed` |
| R3 | met | `sdd-brief.spec.ts::"R3: carries Do, Acceptance, Verify, Files and the literal R#/E#/C# texts and gates"` — asserts literal R1 (with its Given line), E2, C2 section, gate commands, and that uncited R2 is absent; runner: `1 passed`; negative control: no requirements in the brief → `1 failed`. Code `server/src/sdd/brief.ts` |
| R4 | met | `sdd-brief.spec.ts::"R4/E5: embeds existing files, marks missing ones to be created…"` — asserts `index.ts` embedded and `src/nuevo.ts` "does not exist yet — to be created"; runner: `1 passed`; negative control: ENOENT branch removed → `1 failed`. Code `server/src/prompt-builder.ts` |
| R5 | met | `sdd-claim.spec.ts::"R5: rejects unapproved spec, tasks or existing plan, and closed tasks"` — asserts the error names each artifact and `Status: in-review`, and `[x]`/`[!]`/`[~]`/`[>]` rejected; runner: `1 passed`; negative control: Status check disabled → `1 failed`. No worktree clause: the check runs before `delegate()` (`server/src/sdd/task-delegation.ts`), covered by R6's case (worker not invoked) |
| R6 | met | `sdd-task-delegation.spec.ts::"R6/SC2: claim writes the Owner; delegate refuses to start a worker until the claim is committed"` — asserts Owner line written, `CLAIM_NOT_COMMITTED` and no `FAKE_ARGS_FILE` (CLI never ran); `sdd-claim.spec.ts::"E10/SC2…"` asserts `claimCommitted` false→true around the commit; runner: `1 passed` each; negative control: commit check removed → `1 failed` ("promise resolved … instead of rejecting") |
| R7 | met | `sdd-verify.spec.ts::"R7: runs Verify and gates without a shell…"` — asserts pass/fail per command, output tail, `newFailure` true / false / "compare" against the baseline, pipeline-only manual; `sdd-task-delegation.spec.ts::"R8…"` asserts it runs inside the delegation worktree; runner: `1 passed`; negative control: `newFailure` not set → `1 failed` |
| R8 | met | `sdd-task-delegation.spec.ts::"R8: write mode returns the diff, the verification, per-item verdicts and a Notes draft; tasks.md is not ticked"` — asserts A1 met / R1 not met / E2 unverifiable, `notesDraft` with the delegation id, no `[x]` and Notes untouched; runner: `1 passed`; negative control: verdicts ignored → `1 failed` |
| R9 | met | `sdd-task-delegation.spec.ts::"R9: when every provider fails the Owner goes back to —"` — asserts `fallback_to_claude`, `handback` commit and tasks.md byte-identical to the original; `"R9: sdd_task_release frees a claimed task…"`; runner: `1 passed` each; negative control: handback write removed → `1 failed` |
| R10 | partially met | `commands/sdd-delegate.md` documents the four arguments, defaults `auto`/write and both outcomes; `claude plugin validate .` → `√ Validation passed`. Not exercised end to end: this environment has neither `codex` nor `agy` (SC1) |
| E1 | met | `sdd-artifacts.spec.ts::"E1: an unknown slug lists the available features"` — asserts `Available features: demo`, missing tasks.md, invalid slug; runner: `1 passed`; negative control: empty slug list → `1 failed` |
| E2 | met | `sdd-artifacts.spec.ts::"E2: an unknown task or an empty next lists open tasks and owners"` — asserts the exact list with owners and `NO_OPEN_TASK`; runner: `1 passed`; negative control: empty list → `1 failed` |
| E3 | met | `sdd-verify.spec.ts::"E3: a command with shell syntax is never run…"` — asserts `manual` with `(&&)` and that file `x` still exists; runner: `1 passed`; negative control: detection off → `1 failed` |
| E4 | met | `sdd-artifacts.spec.ts::"E4: a cited R#/E# or C# missing from the artifacts is rejected by id"` — asserts `G1 cites R9`, `T3 cites C7`; runner: `1 passed` |
| E5 | met | `sdd-brief.spec.ts::"R4/E5…"` — asserts `.env` reported "sensitive file … never shared" and `hunter2` absent from the prompt; runner: `1 passed`; negative control: `isSensitivePath` → false → `1 failed` |
| E6 | met | `sdd-claim.spec.ts::"E6: a claimed task cannot be claimed again…"` and `sdd-task-delegation.spec.ts::"R6/SC2…"` (second claim → `TASK_CLAIMED`, before any worktree); runner: `1 passed` each |
| E7 | met | `sdd-artifacts.spec.ts::"E7: a Small feature reads tasks, gates and Status from spec.md"`; runner: `1 passed` |
| E8 | met | `sdd-artifacts.spec.ts::"R1…"` — asserts the Spanish Do text with «», ñ and accents copied verbatim; runner: `1 passed` |
| E9 | met | `sdd-task-delegation.spec.ts::"E9: a failing Verify keeps the worktree and the claim"` — asserts exit 4, `verified: false`, worktree exists, Owner intact; runner: `1 passed` |
| E10 | met | `sdd-claim.spec.ts::"E10/SC2…"` — runs the returned command with `index.ts` modified; asserts the commit holds only `specs/demo/tasks.md` and `index.ts` stays modified; runner: `1 passed` |

Coverage: surfaces API ✅ (R1–R9, MCP tools) · CLI ✅ (R10, partially met) · sensitive ground: access control non-goal · traceability R9 · data handling E5 · data lifecycle non-goal · repeat-request correctness E6 · accessibility non-goal (no UI)
Gates: typecheck ✅ exit 0 · tests ✅ `Test Files 16 passed (16) · Tests 181 passed (181)` (baseline 154 passed (154); +27 new, 0 skipped) · `claude plugin validate .` ✅ `√ Validation passed` · `claude plugin test .` ✅ `7 pass, 0 fail` · Pipeline: run 39094610235 on `2f6a7fc` (same code as the change set; later commits touch only this file) — `dist is up to date` ✅ · `claude plugin validate / test` ✅ · `test` ubuntu/macos/windows × Node 20/22 ✅ 6/6
Attribution: none — no failure required attribution
Tests removed: none
Clean-code sweep: none · close calls: `parseStatus`/`parseRequirements`/`parseComponents` are exported but only used inside `artifacts.ts` — kept, they are the module's parsing surface next to the tested `parseTasks`/`parseGates`
Shortcuts declared: none
Dead-code sweep: none — every new export reached by `server/src/index.ts` (tool registration) or by the modules it calls; `tsc --noUnusedLocals --noUnusedParameters` reports nothing in the change set (scope: this tree) · declared duplications: `parseTasks` vs `hooks/conductor/model.ts` and `verifyTask` vs `hooks.ts → runVerify` (plan C1/C4 **Duplicates**)
Excluded from inventory: none
Documentation: `docs/sdd-task-delegation.md` (with Operating → Signal) and README sections match the schemas in `server/src/index.ts`
Success criteria: SC1 pending — needs a real `/sdd-delegate` run with `codex` or `agy` installed · SC2 met on emission — `sdd-task-delegation.spec.ts::"R6/SC2…"` and `sdd-claim.spec.ts::"E10/SC2…"`; this feature's own history shows `sdd-task-delegation: claim T#` before each `T#` commit
Integration: pending review (Lucke514/claude-conductor#8)
