<!-- Status enum: draft | in-review | approved | implemented | superseded | abandoned -->

# Plan: Guardrails de delegación

> Spec: [spec.md](./spec.md)
> Status: implemented
> Last updated: 2026-10-18

## Approach

Todos los controles se meten en el camino único por el que pasa cualquier delegación —`delegate()` y lo que llama—, para que valgan igual con `delegate`, con `sdd_task_delegate` y con los subagentes:
- un módulo nuevo construye el entorno del worker (sin credenciales, git solo local, `gh` falso al principio del `PATH`);
- `collectChanges` restaura `specs/` antes de calcular el diff;
- tras cada intento se comprueba en el remoto la rama `mp/*`;
- `delegate()` acepta los `Files` esperados y marca como violación lo que queda fuera.

Las violaciones nuevas viajan por el array `violations` que ya existe, así llegan a la respuesta y al log de auditoría sin un segundo canal (R8). Se descartó un sandbox de sistema (contenedor, namespaces): no es portable a macOS y Windows, que corren en CI, y cortaría también la red del propio CLI del worker.

## Current state

- **Architecture**: servidor MCP plano en `server/src/`, un módulo por responsabilidad, más `providers/` y `sdd/`. Tests en `server/tests/*.spec.ts` con repos temporales (`makeRepo`) y CLIs falsos (`fixtures/fake-codex.mjs`, `fake-agy.mjs`). Hooks en `server/src/hooks.ts`, registrados en `hooks/hooks.json`.
- `server/src/process.ts` — `buildChildEnv(extra)` copia `process.env` menos `STRIPPED_ENV` (`MP_CLAUDE_COMMIT`) y aplica `extra`, donde `undefined` borra la variable. Todos los procesos de los adapters pasan por aquí, con spawn o con PTY.
- `server/src/worktree.ts`:
  - `workerGitEnv(meta)` añade `core.hooksPath` vía `GIT_CONFIG_*` respetando las entradas existentes;
  - `collectChanges` deshace commits del worker, hace `git add -A` y calcula el diff;
  - `applyWorktree` vuelve a llamar a `collectChanges`, así que lo que este excluye tampoco se aplica.
- `server/src/delegate.ts` — `execute` crea el worktree, pasa `env: meta ? workerGitEnv(meta) : {}` al adapter y llama a `collectChanges`. En modo read sin worktree (`isolation.readMode: "cwd"`) el worker recibe hoy el entorno completo.
- `server/src/hooks.ts` — `AUTO_DELEGATE_CONTEXT`/`userPromptSubmit` y `preDelegate`.
- `server/src/sdd/task-delegation.ts` — `sddTaskDelegate` llama a `delegate()` y calcula `verified`.
- `server/src/config.ts` — esquema zod; se añade `guardrails`.
- `server/src/audit.ts` — `violations: { type, detail }[]` ya se registra.
- **Overlap scan**: `ls specs/` → `sdd-integration` (scope) y `sdd-task-delegation`, ya fusionado, cuyo plan reclamaba `sdd/task-delegation.ts`, `delegate.ts` y `hooks.ts`. Esta feature los modifica después de esa fusión, sin trabajo en curso que se solape. No hay otras ramas activas.

## Quality gates

| Gate | Command | Where | Baseline |
|---|---|---|---|
| Tests | `npm --prefix server test` | `here` | `Test Files 16 passed (16) · Tests 181 passed (181)` |
| Types | `npm --prefix server run typecheck` | `here` | `tsc` (src + tests) exit 0, 0 errores |
| Plugin | `claude plugin validate .` · `claude plugin test .` | `here` | `√ Validation passed` · `7 pass, 0 fail` |
| Dist | `git diff --exit-code --stat -- server/dist` tras `npm --prefix server run build` | `pipeline-only` (job `dist`) | `—` |
| Tests multiplataforma | matriz ubuntu/macos/windows × Node 20/22 | `pipeline-only` (job `test`) | `—` |
| Lint / Format | — sin tooling en el proyecto | — | — |

**Base**: `main` @ `30f6cb7` — rama de feature dedicada `feature/sdd-guardrails`.

**Integration**: un PR a `main` revisado y fusionado por el usuario; checks requeridos `test` (matriz), `dist` y `plugin`.

**Task span**: `— a task is claimed for at most 7 days`

**Measurements**: — el único número es el timeout de 10 s de E6, que se fija en código y se comprueba en un test con timeout corto; no hay medición de rendimiento.

## Components

### C1 — Entorno sellado del worker

- **Implements**: R4, R5, E5, E8, E9
- **Where**: `server/src/worker-env.ts` (nuevo); `server/src/delegate.ts` (usarlo en `execute`)
- **What**: `workerEnv(meta?: WorktreeMeta, env = process.env): Record<string, string | undefined>`:
  - las variables de R4 a `undefined` (`buildChildEnv` las borra);
  - `GIT_TERMINAL_PROMPT=0`, `GIT_ALLOW_PROTOCOL=file`;
  - `GH_CONFIG_DIR` → `<mpHome>/empty-gh`;
  - entradas `GIT_CONFIG_*` añadidas a las existentes: `credential.helper=""` y, con worktree, `core.hooksPath` (E5);
  - la variable de PATH, encontrada sin distinguir mayúsculas (`Path` en Windows), con `<mpHome>/bin` delante (E8).

  `ensureShims()` escribe una sola vez `<mpHome>/bin/gh` (sh, 0755) y `gh.cmd`; ambos salen con 1 y el mensaje de R5. Se aplica también en modo read sin worktree. Nada registra valores de variables, solo sus nombres (E9).
- **Reuses**: `workerGitEnv` (`worktree.ts`), que se generaliza para aceptar varias claves; `buildChildEnv`; `paths.mpHome`.
- **Duplicates**: — none
- **Depends on**: —

### C2 — `specs/` intocable

- **Implements**: R3, E2
- **Where**: `server/src/worktree.ts` (`collectChanges`, tipo `Violation`)
- **What**: tras deshacer commits y antes del `git add -A`, `git diff --name-only <base>` y `git ls-files --others --exclude-standard` filtrados por `specs/`. Si hay alguno:
  - `git checkout <base> -- specs` restaura lo modificado o borrado;
  - `git clean -fdq -- specs` quita lo nuevo;
  - se registra la violación `{ type: "specs_modified", detail, files }`.

  Como `applyWorktree` reutiliza `collectChanges`, tampoco se aplica nada de `specs/`. En read se registra igual (E2).
- **Reuses**: `collectChanges`, `git`/`gitOk`, `quietHooks`.
- **Duplicates**: — none
- **Depends on**: —

### C3 — Comprobación de push al remoto

- **Implements**: R6, E6, E7
- **Where**: `server/src/remote-check.ts` (nuevo); `server/src/delegate.ts`; `server/src/config.ts` (`guardrails.checkRemotePush`, por defecto `true`); `config/multiprovider.example.json`
- **What**: `checkRemotePush(repoRoot, branch, timeoutMs = 10_000)` → `{ violations, notes }`:
  - sin remotos (`git remote`), no hace nada (E7);
  - por cada remoto, `git ls-remote --heads <remote> refs/heads/<branch>` con `runProcess` y timeout, en el entorno de Claude;
  - salida no vacía → `{ type: "worker_push", detail: "<remote>/<branch>" }`;
  - fallo o timeout → nota `push check skipped: <remoto>: <motivo>` (E6).

  Se llama en `execute` justo después de `collectChanges`, con worktree y antes de borrarlo. Si hay `worker_push`, `nextSteps` añade el comando exacto `git push <remote> --delete <branch>` para que lo ejecute el usuario.
- **Reuses**: `process.runProcess` (timeout y kill), el patrón de `notes`/`violations` de `delegate()`.
- **Duplicates**: — none
- **Depends on**: —

### C4 — Drift fuera de los `Files` de la tarea

- **Implements**: R7, E3, E4
- **Where**: `server/src/delegate.ts` (`DelegateParams.scopeFiles?`); `server/src/sdd/task-delegation.ts`
- **What**: con `scopeFiles`, `delegate()` compara `changes.files` con la lista. Un archivo está dentro si coincide exactamente o si una entrada termina en `/` y es prefijo (E4); un archivo creado que estaba listado no es drift (E3). Lo que queda fuera es la violación `{ type: "outside_task_files", detail, files }`. `sddTaskDelegate` pasa `scopeFiles: task.files`, expone `sdd.drift` y fuerza `verified: false` si no está vacío.
- **Reuses**: el array `violations` y `appendAudit` de `delegate()` (R8 sin código extra).
- **Duplicates**: — none
- **Depends on**: —

### C5 — Delegación automática y confirmación en repos SDD

- **Implements**: R1, R2, E1
- **Where**: `server/src/hooks.ts`
- **What**:
  - `isSddRepo(dir)`: existe `specs/*/spec.md`;
  - `userPromptSubmit`, en un repo SDD, añade a `AUTO_DELEGATE_CONTEXT` la instrucción de R1;
  - `preDelegate`, para `delegate` en write en un repo SDD, completa el motivo de confirmación con el aviso de R2 (`sdd_task_delegate` no cambia).
  - Sin `specs/`, el texto es el de hoy (E1).
- **Reuses**: `projectDirFrom`, `preDelegate`, `userPromptSubmit`.
- **Duplicates**: — none
- **Depends on**: —

### C6 — Auditoría de las violaciones nuevas

- **Implements**: R8
- **Where**: `server/src/audit.ts` (sin cambios de esquema) y `server/src/delegate.ts`
- **What**: las tres violaciones nuevas entran en `violations` antes de `finish()`, que ya las escribe como `{ type, detail }`. `detail` nombra archivos, remotos y ramas, nunca valores de variables (E9). Se cubre con un test sobre el JSONL.
- **Reuses**: `appendAudit`.
- **Duplicates**: — none
- **Depends on**: C2, C3, C4

## Build order

1. C1, C2, C3, C4, C5 (parallel)
2. C6

## Evidence per requirement

| R#/E# | Evidence | Exists today? |
|---|---|---|
| R1 | `server/tests/hooks-setup.spec.ts` — con `specs/demo/spec.md` el contexto nombra `/sdd-delegate`; sin él, el texto actual | no — Phase 5 |
| R2 | `hooks-setup.spec.ts` — `delegate` write en repo SDD → `ask` con motivo que menciona `/sdd-delegate` | no — Phase 5 |
| R3 | `server/tests/guardrails.spec.ts` — el CLI falso edita `specs/demo/tasks.md` y `index.ts` → diff solo `index.ts`, violación `specs_modified`; `delegation_apply` no toca `specs/` | no — Phase 5 |
| R4 | `guardrails.spec.ts` — el CLI falso vuelca su entorno: sin las variables de R4, con `GIT_ALLOW_PROTOCOL=file`; un `git push` real a un remoto `https://` falla sin red; con remoto `file://` se bloquea por el hook | no — Phase 5 |
| R5 | `guardrails.spec.ts` — el CLI falso ejecuta `gh pr create` → código 1 y mensaje del plugin | no — Phase 5 |
| R6 | `guardrails.spec.ts` — el CLI falso hace push saltándose el hook a un remoto bare local (permitido para el servidor) → `worker_push` y paso con `git push … --delete`; con `checkRemotePush: false` no se comprueba | no — Phase 5 |
| R7 | `server/tests/sdd-task-delegation.spec.ts` — diff con un archivo fuera de `Files` → `sdd.drift`, `verified: false` | no — Phase 5 |
| R8 | `guardrails.spec.ts` — el JSONL de auditoría contiene las tres violaciones nuevas | no — Phase 5 |
| E1 | `hooks-setup.spec.ts` (caso sin `specs/` de R1) | no — Phase 5 |
| E2 | `guardrails.spec.ts` — read mode editando `specs/` → `specs_modified` y `write_in_read_mode` | no — Phase 5 |
| E3 | `sdd-task-delegation.spec.ts` — archivo listado y creado por el worker → sin drift | no — Phase 5 |
| E4 | `server/tests/guardrails.spec.ts` — `Files: src/` cubre `src/x/y.ts` | no — Phase 5 |
| E5 | `guardrails.spec.ts` — con `GIT_CONFIG_COUNT=1` previo, las entradas se añaden a partir del índice 1 | no — Phase 5 |
| E6 | `guardrails.spec.ts` — remoto inalcanzable (`http://127.0.0.1:9/x.git`) → nota "push check skipped", sin violación | no — Phase 5 |
| E7 | `guardrails.spec.ts` — repo sin remotos → ni violación ni nota | no — Phase 5 |
| E8 | `guardrails.spec.ts` — la clave de PATH se detecta sin mayúsculas y `gh.cmd` existe; la resolución en Windows se evidencia en el job `test (windows-latest, …)` de CI | no — Phase 5 |
| E9 | `guardrails.spec.ts` — con `GH_TOKEN=secret-value` en el entorno, `secret-value` no aparece en la respuesta ni en el JSONL | no — Phase 5 |

## Data changes, delivery & dependencies

- **Data changes**: — none
- **Delivery**: — ships with the normal release. Hay un valor de config nuevo, `guardrails.checkRemotePush`, que por defecto está activado y figura en `config/multiprovider.example.json` y en el README.
- **Dependencies**: — none

## Risks

| Risk | Mitigation |
|---|---|
| Un CLI de proveedor usa git por red para su propia auth o actualización y `GIT_ALLOW_PROTOCOL=file` lo rompe | Codex y agy autentican por HTTPS propio, no por git. `/mp-doctor` hace una ejecución real que lo detectaría; la opción de relajarlo queda como cambio de spec si aparece |
| Quitar `SSH_AUTH_SOCK` rompe algo que el worker necesita | El worker no tiene motivo para usar ssh; si un CLI lo necesitara, `/mp-doctor` lo mostraría |
| `ls-remote` añade latencia o pide credenciales interactivas | Timeout de 10 s, `GIT_TERMINAL_PROMPT=0` también para esta llamada, y `guardrails.checkRemotePush: false` |
| Un worker escribe con una ruta absoluta en el checkout real del usuario (fuera del worktree) | No lo cubre esta feature (non-goal); queda el sandbox del CLI. Lo anoto en los docs |
| El `gh` falso no gana si el worker usa una ruta absoluta | R4 (`GH_CONFIG_DIR` vacío y sin tokens) deja a ese `gh` sin sesión |

## Requirement coverage

| Requirement | Covered by |
|---|---|
| R1 | C5 |
| R2 | C5 |
| R3 | C2 |
| R4 | C1 |
| R5 | C1 |
| R6 | C3 |
| R7 | C4 |
| R8 | C6 |
| E1 | C5 |
| E2 | C2 |
| E3 | C4 |
| E4 | C4 |
| E5 | C1 |
| E6 | C3 |
| E7 | C3 |
| E8 | C1 |
| E9 | C1, C6 |
