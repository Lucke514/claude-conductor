<!-- Status enum: draft | in-review | approved | implemented | superseded | abandoned -->

# Plan: Delegación de tareas SDD

> Spec: [spec.md](./spec.md)
> Status: in-review
> Last updated: 2026-10-18

## Approach

Tres herramientas MCP nuevas en el servidor existente, en lugar de un único `delegate` con más parámetros: `sdd_task_claim` (comprueba y escribe el `**Owner**`), `sdd_task_delegate` (comprueba que el claim está committeado, construye el brief, delega y verifica) y `sdd_task_release` (handback). La partición en dos llamadas es lo que hace cumplible R6 con la decisión de que solo Claude committea: entre `claim` y `delegate` Claude hace el commit, y `delegate` se niega a arrancar un worker si no lo encuentra en `HEAD` (SC2). El núcleo de delegación, fallback, worktrees, límites de archivos y exclusión de secretos es el `delegate()` actual, que se reutiliza sin bifurcarlo; lo nuevo es leer los artefactos SDD y ejecutar la verificación de la tarea. Se descartó extender `delegate` con `slug`/`taskId`: mezclaría dos contratos de entrada y no permite el commit intermedio.

## Current state

- **Architecture**: servidor MCP plano en `server/src/` — un módulo por responsabilidad (`delegate.ts` orquesta, `prompt-builder.ts` construye el brief, `worktree.ts` aísla, `process.ts` lanza procesos sin shell, `hooks.ts` implementa los hooks, `index.ts` registra herramientas), sin capas ni carpetas por feature salvo `providers/`. Esta feature sigue el patrón de `providers/`: una carpeta `server/src/sdd/` para sus módulos, porque son cuatro piezas de un mismo dominio. Tests en `server/tests/*.spec.ts` (vitest) con repos temporales (`helpers.ts → makeRepo`) y CLIs falsos (`tests/fixtures/fake-codex.mjs`). Slash commands en `commands/*.md`.
- `server/src/delegate.ts` — `delegate(params, ctx)`: se llama tal cual desde `sdd_task_delegate`; solo cambia su entrada (brief y `files` ya construidos).
- `server/src/prompt-builder.ts` — `buildPrompt`: se extiende con `extraOutput` (secciones adicionales de salida esperada) y con el informe "a crear" para archivos inexistentes (R4).
- `server/src/hooks.ts` — `splitCommand` y `runVerify`: `splitCommand` se reutiliza; la ejecución de Verify/gates es nueva porque necesita detectar shell (E3) y comparar con baseline (R7). `preDelegate` se amplía al nuevo tool (confirmación en write e inyección de `sessionId`).
- `hooks/hooks.json` — se añade el matcher de `sdd_task_delegate` al PreToolUse de `pre-delegate`. El PostToolUse `post-delegate` **no** se amplía: `sdd_task_delegate` ya verifica por sí mismo.
- `server/src/index.ts` — registro de las tres herramientas.
- `hooks/conductor/model.ts` — `parseTasks`/`pickActiveSpec` (card): leen casilla y Owner para la card; ver **Duplicates** de C1.
- **Overlap scan**: `ls specs/` → `sdd-integration` (solo `scope.md`, sin plan) y esta feature. Ramas remotas: `feature/*` ya fusionadas en `main` (#1–#7) más esta; ningún otro plan reclama estos archivos.

## Quality gates

| Gate | Command | Where | Baseline |
|---|---|---|---|
| Tests | `npm --prefix server test` | `here` | `Test Files 11 passed (11) · Tests 154 passed (154)` |
| Types | `npm --prefix server run typecheck` | `here` | `tsc` (src + tests) exit 0, 0 errores |
| Plugin | `claude plugin validate .` · `claude plugin test .` | `here` | `√ Validation passed` · `7 pass, 0 fail` |
| Dist | `git diff --exit-code --stat -- server/dist` tras `npm --prefix server run build` | `pipeline-only` (job `dist`); localmente cada tarea que toca `server/src` reconstruye y committea `server/dist` | `—` (0 archivos difieren en la base) |
| Tests multiplataforma | matriz ubuntu/macos/windows × Node 20/22 | `pipeline-only` (job `test`) | `—` |
| Lint / Format | — el proyecto no tiene linter ni formatter configurado; no se propone uno (un check que el proyecto nunca ejecutó no es un gate ausente) | — | — |

**Base**: `main` @ `b5b0714` — rama de feature dedicada `feature/sdd-task-delegation`.

**Integration**: un PR a `main` revisado y fusionado por el usuario; checks requeridos de CI: `test` (matriz), `dist`, `plugin`.

**Task span**: `— a task is claimed for at most 7 days`

**Measurements**: — ningún requisito fija un número.

## Components

### C1 — Lector de artefactos SDD

- **Implements**: R1, R2, E1, E2, E4, E7, E8
- **Where**: `server/src/sdd/artifacts.ts` (nuevo)
- **What**: `loadFeature(projectDir, slug)` → `{ depth: "small" | "standard", spec, plan?, tasks, statuses }`; lee `> Status:` de cada artefacto, las tareas (`## T#`/`## G#`, `[P]`, casilla, `**Owner**`, `**Component**`, `**Implements**`, `**Files**`, `**Do**`, `**Acceptance**`, `**Verify**`), el texto literal de cada `R#`/`E#` de `spec.md`, la sección `### C#` de `plan.md` y la tabla Quality gates (`Command`, `Where`, `Baseline`). Small (E7): tareas y gates desde `## Tasks` del `spec.md`. `resolveTask(feature, "T3" | "G1" | "next")` (R2). Errores tipados con la lista de slugs (E1), de tareas abiertas y su owner (E2) y del id inexistente (E4). Solo anclas en inglés; el texto se copia tal cual (E8).
- **Reuses**: `node:fs/promises`; `server/src/paths.ts` para resolver `projectDir`.
- **Duplicates**: `hooks/conductor/model.ts → parseTasks` lee casilla y Owner para la card. No se extrae a un módulo común porque corre en el sandbox de mods de Claude Code (`.tsx` sin imports del servidor, validado por `claude plugin validate`) y el servidor compila con `rootDir: src`; compartir obligaría a un tercer paquete. El parser del servidor es un superconjunto; `sdd-traceability` puede reconsiderarlo.
- **Depends on**: —

### C2 — Brief de la tarea

- **Implements**: R3, R4, E5
- **Where**: `server/src/sdd/brief.ts` (nuevo); extensión de `server/src/prompt-builder.ts`
- **What**: `buildTaskBrief(feature, task)` → `{ task: string, files: string[], extraOutput: string[] }`: el objetivo incluye literal `Do`, `Acceptance`, `Verify`, `Files`, el texto de cada `R#`/`E#` de `Implements`, la sección `C#` y los comandos de los gates. `extraOutput` pide al worker una sección `## Acceptance` con una línea por criterio y por `R#`/`E#`: `- [met|not met|unverifiable] <id o criterio> — <evidencia>`. En `prompt-builder.ts`: `PromptInput.extraOutput?` y, para un archivo listado que no existe, `reason: "does not exist yet — to be created"` (R4). La exclusión de secretos (E5) y los límites son los de `buildPrompt`, sin cambios.
- **Reuses**: `buildPrompt`, `isSensitivePath`, `config.defaults.maxFileBytes/maxTotalBytes`.
- **Duplicates**: — none
- **Depends on**: C1

### C3 — Claim y handback

- **Implements**: R5, R6, R9, E6, E10
- **Where**: `server/src/sdd/claim.ts` (nuevo)
- **What**: `checkDelegable(feature, task)` — rechaza si `spec.md`, `tasks.md` o `plan.md` (si existe) no están `approved`, o si la tarea está `[x]`/`[~]`/`[>]`/`[!]` o tiene otro owner (R5, E6). `writeOwner(projectDir, slug, taskId, value)` reescribe solo la línea `**Owner**` de esa tarea, de forma atómica, sin tocar nada más del archivo (R6, R9). `claimCommitted(repoRoot, slug, taskId, owner)` — comprueba con `git show HEAD:specs/<slug>/tasks.md` que el Owner está committeado y que el árbol de trabajo no lo ha revertido (SC2). La herramienta nunca hace commits: devuelve a Claude el comando exacto `git commit -m "<slug>: claim T#" -- specs/<slug>/tasks.md`, que con pathspec incluye solo `tasks.md` aunque haya otros cambios (E10).
- **Reuses**: `fsutil.writeFileAtomic`, `git.gitOk`, `git.repoRootOf`, `fallback.routeTask`/`resolveOrder` para resolver `auto` al proveedor que se nombra en el Owner.
- **Duplicates**: — none
- **Depends on**: C1

### C4 — Verificación de la tarea

- **Implements**: R7, E3, E9
- **Where**: `server/src/sdd/verify.ts` (nuevo)
- **What**: `verifyTask(worktreePath, task, gates, timeoutMs)` → por comando `{ command, kind: "verify" | "gate", result: "pass" | "fail" | "manual", newFailure?: boolean | "compare", baseline?, outputTail }`. Un comando con sintaxis de shell (`|`, `&&`, `||`, `;`, `>`, `<`, `$`, backticks, `*` sin comillas) no se ejecuta y queda `manual` con el texto literal (E3). Los demás se separan con `splitCommand` y se lanzan con `runProcess` sin shell en el worktree. Gate en `pipeline-only` → `manual`. Comparación con baseline: exit 0 → sin fallos nuevos; exit ≠ 0 con baseline que registra 0 fallos → `newFailure: true`; con fallos preexistentes → `"compare"` citando la celda Baseline para que Claude compare. Si el Verify falla no se borra nada: el worktree se conserva (E9).
- **Reuses**: `hooks.splitCommand`, `process.runProcess`, `config.verify.timeoutMs`.
- **Duplicates**: `hooks.ts → runVerify` ejecuta `verify.commands` del config. No se extiende porque su contrato (lista plana del config, OK/FAILED) lo usa el hook `post-delegate` y aquí hacen falta E3 y la comparación con baseline; ambos comparten `splitCommand` y `runProcess`.
- **Depends on**: C1

### C5 — Herramientas MCP

- **Implements**: R1, R5, R6, R8, R9, E6, E9
- **Where**: `server/src/sdd/task-delegation.ts` (nuevo); `server/src/index.ts`; `server/src/hooks.ts` (`preDelegate`); `hooks/hooks.json`
- **What**:
  - `sdd_task_claim { slug, task, provider? = "auto" }` → C1 + C3; escribe el Owner `<proveedor> (multi-provider) since <fecha>` y devuelve `{ taskId, owner, commit: "<comando>" }`.
  - `sdd_task_delegate { slug, task, mode? = "write", timeoutMs? }` → C1, comprueba `claimCommitted` (si no, error sin worker), C2, `delegate()` con el proveedor del Owner y fallback; en write y con diff, C4 en el worktree. Respuesta = la de `delegate` más `sdd: { slug, taskId, acceptance: [{ item, verdict }], verification: [...], notesDraft }`. `acceptance` se parsea de la sección `## Acceptance` del worker; lo que falte queda `unverifiable` (R8). `notesDraft` cita el id de la delegación. Si el estado es `fallback_to_claude` o `failed`, devuelve el Owner a `—` y lo indica (R9).
  - `sdd_task_release { slug, task }` → Owner a `—` y el comando de commit (R9; lo llama Claude al descartar).
  - `preDelegate` cubre `sdd_task_delegate` tratando `mode` ausente como write; `hooks.json` añade su matcher.
  - Ninguna herramienta marca `[x]`, escribe `Notes` ni cambia un Status.
- **Reuses**: `delegate()`, `removeWorktree`, el `json`/`fail` de `index.ts`.
- **Duplicates**: — none
- **Depends on**: C1, C2, C3, C4

### C6 — Slash command y documentación

- **Implements**: R10
- **Where**: `commands/sdd-delegate.md` (nuevo); `README.md`; `skills/multi-provider/SKILL.md`
- **What**: `/sdd-delegate <slug> <T#|G#|next> [codex|antigravity|auto] [--read]`. Instruye a Claude: `sdd_task_claim` → `git commit` del claim (sin trailers) → `sdd_task_delegate` → presentar diff, verificación y veredictos → `delegation_apply` + commit `<slug>: T# …` tras el OK del usuario, o `delegation_discard` + `sdd_task_release` + commit del handback. README: sección de la feature y las tres herramientas.
- **Reuses**: el formato de `commands/delegate.md`.
- **Duplicates**: — none
- **Depends on**: C5

## Build order

1. C1
2. C2, C3, C4 (parallel)
3. C5
4. C6

## Evidence per requirement

| R#/E# | Evidence | Exists today? |
|---|---|---|
| R1 | `server/tests/sdd-artifacts.spec.ts` — resuelve `T3` y expone sus campos | no — Phase 5 |
| R2 | `sdd-artifacts.spec.ts` — `next` salta `[x]`, `[!]` y tareas con owner | no — Phase 5 |
| R3 | `server/tests/sdd-brief.spec.ts` — el brief contiene literal R1, E2 y C2 | no — Phase 5 |
| R4 | `sdd-brief.spec.ts` — incrusta archivos existentes y marca el inexistente "to be created" | no — Phase 5 |
| R5 | `server/tests/sdd-claim.spec.ts` — rechazo por Status de spec/tasks/plan y por casilla; sin worktree creado | no — Phase 5 |
| R6 | `server/tests/sdd-task-delegation.spec.ts` — claim escribe el Owner; `delegate` sin commit → error y 0 llamadas al CLI falso; con commit → arranca | no — Phase 5 |
| R7 | `server/tests/sdd-verify.spec.ts` — Verify y gate pasan/fallan con `newFailure` según baseline | no — Phase 5 |
| R8 | `sdd-task-delegation.spec.ts` — `acceptance` parseado del CLI falso, `notesDraft` con el id; `tasks.md` sin `[x]` ni Notes | no — Phase 5 |
| R9 | `sdd-task-delegation.spec.ts` — todos los proveedores fallan → Owner `—`; `sdd_task_release` → Owner `—` | no — Phase 5 |
| R10 | Manual: ejecutar `/sdd-delegate` en una sesión real sobre una tarea de `sdd-guardrails` (SC1); el archivo del comando pasa `claude plugin validate .` | no — Phase 5 |
| E1 | `sdd-artifacts.spec.ts` — slug inexistente lista los disponibles | no — Phase 5 |
| E2 | `sdd-artifacts.spec.ts` — tarea inexistente / `next` vacío lista abiertas y owners | no — Phase 5 |
| E3 | `sdd-verify.spec.ts` — `npm test && rm -rf x` queda `manual` y no se ejecuta | no — Phase 5 |
| E4 | `sdd-artifacts.spec.ts` — `Implements: R9` inexistente → error con el id | no — Phase 5 |
| E5 | `sdd-brief.spec.ts` — `.env` en `Files` no entra; aparece como excluido | sí, parcial — `delegate.spec.ts` cubre `buildPrompt`; se añade el caso vía brief |
| E6 | `sdd-claim.spec.ts` — segundo claim rechazado; un solo worktree | no — Phase 5 |
| E7 | `sdd-artifacts.spec.ts` — feature Small: tareas y gates desde `spec.md` | no — Phase 5 |
| E8 | `sdd-artifacts.spec.ts` — fixture en español, texto copiado literal | no — Phase 5 |
| E9 | `sdd-task-delegation.spec.ts` — Verify falla → worktree existe, Owner se mantiene | no — Phase 5 |
| E10 | `sdd-claim.spec.ts` — con otro archivo modificado, el comando devuelto commitea solo `tasks.md` (se ejecuta en el test) | no — Phase 5 |

## Data changes, delivery & dependencies

- **Data changes**: — none
- **Delivery**: — ships with the normal release (actualizar el plugin; sin config nueva: reutiliza `verify.timeoutMs`, `chain` y `routing`)
- **Dependencies**: — none

## Risks

| Risk | Mitigation |
|---|---|
| Con `auto` o fallback, el proveedor que trabaja no es el que nombra el Owner | El Owner nombra el primero del orden resuelto; si el fallback cae en otro, la respuesta lo dice en `notes` y Claude corrige el Owner en el commit que aplica el trabajo |
| La comparación con baseline es textual (la celda es lectura humana) | Solo se afirma `newFailure: true` cuando la baseline registra 0 fallos; en el resto, `"compare"` con la celda citada: nunca se declara "sin fallos nuevos" sin certeza |
| El worker no devuelve la sección `## Acceptance` o la deforma | Todo criterio sin línea válida queda `unverifiable`; Claude verifica igualmente el diff |
| Un `Verify` legítimo usa `&&` y queda manual | E3 es deliberado; la respuesta muestra el comando literal y Claude lo ejecuta revisado |
| El brief crece con R#/E#/C# y archivos | El texto de artefactos cuenta contra `maxTotalBytes` como los archivos; si se agota, los archivos se informan como no incluidos |

## Requirement coverage

| Requirement | Covered by |
|---|---|
| R1 | C1, C5 |
| R2 | C1 |
| R3 | C2 |
| R4 | C2 |
| R5 | C3, C5 |
| R6 | C3, C5 |
| R7 | C4 |
| R8 | C5 |
| R9 | C3, C5 |
| R10 | C6 |
| E1 | C1 |
| E2 | C1 |
| E3 | C4 |
| E4 | C1 |
| E5 | C2 |
| E6 | C3, C5 |
| E7 | C1 |
| E8 | C1 |
| E9 | C4, C5 |
| E10 | C3 |
