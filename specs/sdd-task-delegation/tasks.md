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

- [ ] Done
- **Owner**: —
- **Component**: C2 · **Implements**: R3, R4, E5
- **Files**: `server/src/sdd/brief.ts`, `server/src/prompt-builder.ts`, `server/tests/sdd-brief.spec.ts`
- **Do**: Implementar `buildTaskBrief(feature, task)` con Do, Acceptance, Verify, Files, el texto de cada `R#`/`E#` citado, la sección `C#` y los comandos de los gates; `extraOutput` con la sección `## Acceptance` del worker. En `buildPrompt`: `extraOutput?` y `reason: "does not exist yet — to be created"` para archivos listados inexistentes.
- **Acceptance**: El prompt contiene literal R1, E2 y C2 de los fixtures; los archivos existentes van incrustados, el inexistente figura "to be created" y `.env` figura excluido sin su contenido; `delegate.spec.ts` sigue pasando.
- **Verify**: `npm --prefix server test -- sdd-brief delegate`
- **Notes**: —

## T3 [P] — Claim y handback

- [ ] Done
- **Owner**: —
- **Component**: C3 · **Implements**: R5, R6, R9, E6, E10
- **Files**: `server/src/sdd/claim.ts`, `server/tests/sdd-claim.spec.ts`
- **Do**: Implementar `checkDelegable`, `writeOwner` (reescribe solo la línea `**Owner**` de la tarea, atómico), `claimCommitted` (`git show HEAD:specs/<slug>/tasks.md` + árbol no revertido) y el comando de commit con pathspec `-- specs/<slug>/tasks.md`.
- **Acceptance**: Rechazo por Status no aprobado de spec, tasks o plan existente, y por casilla `[x]`/`[~]`/`[>]`/`[!]` u otro owner; segundo claim rechazado; `writeOwner` cambia una sola línea; con otro archivo modificado, ejecutar el comando devuelto commitea solo `tasks.md`; `claimCommitted` es falso antes del commit y verdadero después.
- **Verify**: `npm --prefix server test -- sdd-claim`
- **Notes**: —

## T4 [P] — Verificación de la tarea

- [ ] Done
- **Owner**: —
- **Component**: C4 · **Implements**: R7, E3, E9
- **Files**: `server/src/sdd/verify.ts`, `server/tests/sdd-verify.spec.ts`
- **Do**: Implementar `verifyTask(worktreePath, task, gates, timeoutMs)`: detección de sintaxis de shell → `manual` sin ejecutar; `splitCommand` + `runProcess` sin shell; gates `pipeline-only` → `manual`; `newFailure` según la baseline (true solo si registra 0 fallos, `"compare"` si registra preexistentes); no borra el worktree.
- **Acceptance**: Un Verify que pasa y otro que falla se informan con extracto de salida; `node -e "process.exit(1)"` con baseline de 0 fallos → `newFailure: true`; `npm test && rm -rf x` queda `manual` y el archivo `x` sigue existiendo; el worktree existe tras un fallo.
- **Verify**: `npm --prefix server test -- sdd-verify`
- **Notes**: —

## T5 — Herramientas MCP `sdd_task_*`

- [ ] Done
- **Owner**: —
- **Component**: C5 · **Implements**: R1, R5, R6, R8, R9, E6, E9
- **Files**: `server/src/sdd/task-delegation.ts`, `server/src/index.ts`, `server/tests/sdd-task-delegation.spec.ts`, `server/tests/fixtures/fake-codex.mjs`
- **Do**: Implementar y registrar `sdd_task_claim`, `sdd_task_delegate` (mode por defecto write, provider del Owner, error sin worker si el claim no está committeado, C4 tras el diff, `sdd.acceptance` parseado y `notesDraft` con el id, handback en `fallback_to_claude`/`failed`) y `sdd_task_release`. Añadir al CLI falso un modo que emita la sección `## Acceptance`.
- **Acceptance**: Sin commit del claim → error y el CLI falso no se invoca; con commit → diff, verificación y veredictos; criterio sin línea → `unverifiable`; todos los proveedores fallan → Owner `—`; Verify falla → worktree conservado y Owner intacto; `tasks.md` nunca recibe `[x]` ni Notes.
- **Verify**: `npm --prefix server test -- sdd-task-delegation`
- **Notes**: —

## T6 — Confirmación en write y `sessionId` para `sdd_task_delegate`

- [ ] Done
- **Owner**: —
- **Component**: C5 · **Implements**: R10
- **Files**: `server/src/hooks.ts`, `hooks/hooks.json`, `server/tests/hooks-setup.spec.ts`
- **Do**: `preDelegate` trata `mode` ausente como write cuando la herramienta es `sdd_task_delegate`; añadir su matcher al PreToolUse de `pre-delegate` en `hooks.json`.
- **Acceptance**: Una llamada a `sdd_task_delegate` sin `mode` pide confirmación e inyecta `sessionId`; con `mode: "read"` no pide confirmación; `delegate` sin cambios de comportamiento.
- **Verify**: `npm --prefix server test -- hooks-setup`
- **Notes**: —

## T7 — Slash command `/sdd-delegate`

- [ ] Done
- **Owner**: —
- **Component**: C6 · **Implements**: R10
- **Files**: `commands/sdd-delegate.md`, `skills/multi-provider/SKILL.md`
- **Do**: Escribir el comando con el flujo claim → commit (sin trailers) → delegate → presentación → apply + commit `sdd-task-delegation: T# …` tras el OK del usuario, o discard + release + commit del handback; defaults `auto` y write, `--read` opcional. Mencionar el flujo en la skill.
- **Acceptance**: El comando documenta los cuatro argumentos y los dos desenlaces; `claude plugin validate .` lo acepta.
- **Verify**: `claude plugin validate .`
- **Notes**: —

## T8 — Document the feature

- [ ] Done
- **Owner**: —
- **Component**: — · **Implements**: all (documentation)
- **Files**: `docs/sdd-task-delegation.md`, `README.md`
- **Do**: Escribir `docs/sdd-task-delegation.md` (flujo, herramientas, respuesta, límites: E3, comparación con baseline, Owner con fallback); sección en el README con `/sdd-delegate` y las tres herramientas.
- **Acceptance**: La doc describe el comportamiento real; cada ejemplo de invocación coincide con los esquemas registrados en `index.ts`.
- **Verify**: comparar cada ejemplo con `server/src/index.ts` y ejecutar `/sdd-delegate` sobre una tarea de prueba (SC1)
- **Notes**: —

---

## Gaps found in verification

---

## Verification reports
