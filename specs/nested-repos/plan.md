<!-- Status enum: draft | in-review | approved | implemented | superseded | abandoned -->

# Plan: Delegación sobre repos anidados (workspace multi-repo)

> Spec: [spec.md](./spec.md)
> Status: implemented
> Last updated: 2026-10-18

## Approach

El camino actual (`delegate()` → `createWorktree` → `runChain` → adapter) no cambia de forma. Lo que cambia es de dónde sale el repo: hoy siempre es `repoRootOf(projectDir)`, y pasa a ser un **repo destino** validado.
- Lo da el parámetro `repo` de `delegate`, o el `**Repo**` de la tarea en `sdd_task_*`.
- Lo valida un módulo nuevo, `server/src/repo.ts`, antes de crear nada.
- Desde ahí fluye a todo lo que hoy usa `projectDir` como raíz de código: worktree, `files`, `symlink`, deriva y `Verify`.

Casi todo lo de después del worktree ya funciona con cualquier repo, porque usa `meta.repoRoot`:
- `delegation_apply` / `delegation_discard` (`applyWorktree`, `removeWorktree`);
- `collectChanges`;
- `verifyTask`, que ya corre en `r.worktreePath`.

Lo que no lo encuentra son los listados (`listWorktrees` / `cleanupWorktrees` parten de `projectDir`). Por eso se agrega un registro de repos en `state.json`.

R3 tiene dos fugas que hay que cerrar además del worktree. Las dos dan la ruta absoluta del repo de origen al worker:
1. `buildChildEnv` hereda `CLAUDE_PROJECT_DIR` (y `MP_PROJECT_DIR`, `PWD`, `OLDPWD`, `INIT_CWD`) del servidor (`server/src/process.ts:52`, solo quita `MP_CLAUDE_COMMIT`).
2. `workerEnv` fija `core.hooksPath` en `<gitDir>/mp-hooks`. En un worktree, `gitDir` está dentro del `.git` del repo de origen (`…/backend-monolith/.git/worktrees/<x>/mp-hooks`).

El puntero `gitdir:` del archivo `.git` del worktree sigue existiendo y git lo necesita: es el riesgo residual aceptado en Q1.

Se descartaron:
- un `projectDir` por llamada que reemplace al del proceso: rompería la lectura de `specs/` y de la config, que deben seguir en la raíz;
- clonar en vez de usar worktree (Q1, opción c).

## Current state

- **Architecture**: servidor MCP plano en `server/src/`.
  - `index.ts` registra las herramientas con `projectDir()` fijo por proceso.
  - `delegate.ts` orquesta. `worktree.ts` crea, recoge, aplica y lista worktrees `mp/*` bajo `~/.claude/multi-provider/worktrees/<basename>-<hash>/`.
  - `sdd/` contiene `artifacts.ts` (parseo), `task-delegation.ts`, `verify.ts` y `pipeline.ts`.
  - Los tests usan repos temporales (`tests/helpers.ts`) y CLIs falsos (`tests/fixtures/fake-*.mjs`).
  - Esta feature sigue ese reparto. Lo nuevo es `repo.ts` y `secrets-scan.ts`.
- `server/src/delegate.ts:137`: `repoRootOf(ctx.projectDir)`, worktree desde esa raíz, y `buildPrompt({ projectDir: ctx.projectDir })`.
- `server/src/worktree.ts`:
  - `createWorktree` enlaza `opts.symlink` relativo a `repoRoot` sin filtrar rutas sensibles;
  - los hooks van en `<gitDir>/mp-hooks`;
  - `listWorktrees(cwd)` y `cleanupWorktrees(cwd)` solo miran `repoRootOf(cwd)`.
- `server/src/worker-env.ts` — quita las credenciales de git/GitHub, pero no las variables con rutas del proyecto.
- `server/src/sdd/artifacts.ts` — `parseTasks` no lee `**Repo**`. `backticked()` ya separa varios comandos de `Verify` (R10 se cumple hoy, sin test que lo fije).
- `server/src/sdd/verify.ts` — corre en el worktree recibido, y la columna `Where` solo distingue `pipeline-only`.
- `server/src/config.ts` — `chain` es global, `isolation` no tiene `symlinkByRepo` ni `allowCwdWithSecrets`, y `readModeArgs` de agy no tiene valor por defecto.
- `server/src/delegate.ts:296` — el audit ya guarda `requestedProvider`, pero la respuesta no lo trae.
- `server/src/hooks.ts:254` — `SessionStart` limpia solo los worktrees del repo de la raíz.
- **Overlap scan**: `ls specs/`.
  - `provider-reliability` está implementada y fusionada (`b8fc123`).
  - `sdd-task-delegation` (verificación abierta) no tiene tareas abiertas.
  - No hay ramas abiertas que toquen `server/src`.

## Quality gates

| Gate | Command | Where | Baseline |
|---|---|---|---|
| Tests | `npm --prefix server test` | `here` | `Test Files 21 passed (21) · Tests 272 passed (272)` — 1 fallo intermitente en 1 de 4 ejecuciones del 2026-10-18 (sin identificar; pre-existing flaky) |
| Types | `npm --prefix server run typecheck` | `here` | `tsc` (src + tests) exit 0, 0 errores |
| Plugin | `claude plugin validate .` · `claude plugin test .` | `here` | `✔ Validation passed` · `12 pass, 0 fail` |
| Dist | `git diff --exit-code --stat -- server/dist` tras `npm --prefix server run build` | `pipeline-only` (job `dist`); localmente, cada tarea que toca `server/src` reconstruye y committea `server/dist` | `—` |
| Tests multiplataforma | matriz ubuntu/macos/windows × Node 20/22 | `pipeline-only` (job `test`) | `—` |
| Lint / Format | — no configurado | — | — |

**Base**: `main` @ `b8fc123`. Rama de feature `feature/nested-repos`.

**Integration**: merge local a `main` sin PR, como 0.2.0 y 0.3.0. Los checks `test` (matriz, incluido Windows para `realpath` y symlinks), `dist` y `plugin` corren en el CI del push. La última tarea sube la versión a 0.4.0 en `server/package.json`, `server/src/index.ts` (`VERSION`), `.claude-plugin/plugin.json` y `.claude-plugin/marketplace.json`.

**Task span**: `— a task is claimed for at most 7 days`

**Measurements**: todos los SC se miden en tests con repos temporales y CLIs falsos. Después del release, el usuario repite la delegación real desde el workspace Organizer (fuera de esta spec).

## Components

### C1 — Repo destino validado en `delegate`

- **Implements**: R1, R2, E1, E2, E6
- **Where**: `server/src/repo.ts` (nuevo), `server/src/delegate.ts`, `server/src/prompt-builder.ts`, `server/src/index.ts`, `server/src/sdd/artifacts.ts` (códigos de error)
- **What**:
  - `resolveRepo(projectDir, rel): Promise<{ rel: string; root: string }>` aplica las tres reglas de R1 con `realpath` en los dos lados (en macOS, `/var` se lista como `/private/var`; en Windows hay nombres 8.3).
  - Errores: `RepoError` con `code` `REPO_INVALID`, `REPO_NOT_GIT` o `REPO_NOT_FOUND`. `fail()` de `index.ts` reporta `code` para `SddError` y para `RepoError`.
  - E2: si `show-toplevel` difiere, el mensaje sugiere la raíz real, relativa a `projectDir`.
  - `DelegateParams.repo?`. Con él, `delegate()`:
    - valida antes de `jobs.start` y de cualquier worktree;
    - usa `root` como `repoRoot` para `createWorktree` y como base de `buildPrompt` (que acepta `<rel>/…` quitando el prefijo);
    - toma `symlink` de `isolation.symlinkByRepo[rel] ?? isolation.symlink`;
    - devuelve `repo: rel`.
  - E1: el error de "no commits" nombra el repo.
  - `index.ts` agrega `repo` al `inputSchema` de `delegate`.
- **Reuses**: `repoRootOf`, `createWorktree`, `outsideScope`, `realOrResolved` (se exporta desde `worktree.ts`).
- **Duplicates**: — none
- **Depends on**: —

### C2 — Sin rutas ni secretos del origen en el worker

- **Implements**: R3, E4
- **Where**: `server/src/worktree.ts`, `server/src/worker-env.ts`, `server/src/process.ts`, `server/src/prompt-builder.ts`, `server/tests/fixtures/fake-codex.mjs`
- **What**:
  - `createWorktree` omite las entradas de `symlink` con `isSensitivePath` (que se exporta desde `prompt-builder.ts`) y las devuelve en `skippedSymlinks`. `delegate()` las anota en `notes`.
  - Los hooks bloqueantes pasan de `<gitDir>/mp-hooks` a `worktreesDir()/<repoKey>/.hooks/<ts>/`. `removeWorktree` los borra.
  - `meta` sigue guardándose en `<gitDir>/mp-meta.json`: la lee el servidor, no el worker.
  - `workerEnv` quita `CLAUDE_PROJECT_DIR`, `MP_PROJECT_DIR`, `PWD`, `OLDPWD` e `INIT_CWD`.
  - `fake-codex.mjs` agrega `FAKE_MODE=probe-secrets`. Escribe en su salida:
    - la lista del cwd;
    - si pudo leer `package.json` y `.env` (relativos al cwd);
    - si alguna variable de entorno contiene un valor de `FAKE_FORBIDDEN_PATH`.
  - Test SC1 con el fixture de la spec.
- **Reuses**: `isSensitivePath`, `BLOCK_HOOK`, `gitConfigEnv`.
- **Duplicates**: — none
- **Depends on**: C1

### C3 — Repo de tarea en `sdd_task_*` y gates por repo

- **Implements**: R4, R5, E3
- **Where**: `server/src/sdd/artifacts.ts`, `server/src/sdd/task-delegation.ts`, `server/src/sdd/verify.ts`, `server/src/repo.ts`, `server/tests/sdd-fixtures.ts`
- **What**:
  - `SddTask.repo?` sale del campo `**Repo**` (con `unclaimed()` para `—`).
  - `resolveTaskRepo(projectDir, slug, repo)` prueba `.claude/worktrees/<slug>/<Repo>` y después `<Repo>`, cada uno con `resolveRepo`. Si el primero existe pero no es un repo git, se anota (E3). Si no hay ninguno, `REPO_NOT_FOUND` con las rutas probadas.
  - `sdd_task_claim` resuelve el repo **antes** de `writeOwner` y lo devuelve.
  - `sdd_task_delegate` lo pasa a `delegate` como `repo`, y quita el prefijo `<Repo>/` de `task.files` para `scopeFiles`.
  - `claimCommitted` sigue usando `projectDir`.
  - `verifyTask(…, { repo, workspaceRepos })`: un gate cuyo `Where` es el nombre de otro repo de `workspaceRepos` queda `manual` con el motivo `runs in <repo>`.
  - `workspaceRepos` sale de los directorios de primer nivel de `projectDir` que son repos git.
  - Test SC2: `backend-monolith` anidado, más un worktree de spec `.claude/worktrees/<slug>/backend-monolith` en `feat/<slug>`.
- **Reuses**: `resolveRepo` (C1), `checkDelegable`, `verifyTask`.
- **Duplicates**: — none
- **Depends on**: C1

### C4 — Registro de repos y listados

- **Implements**: R11, E5
- **Where**: `server/src/state.ts`, `server/src/worktree.ts`, `server/src/delegate.ts`, `server/src/index.ts`, `server/src/hooks.ts`, `server/src/sdd/pipeline.ts`
- **What**:
  - `MpState.repos?: string[]` guarda los `repoRoot` absolutos y sin duplicados. `delegate()` con `repo` lo agrega.
  - `knownRepos(projectDir, state)` = la raíz más los registrados que existen y siguen bajo `projectDir`.
  - `listWorktrees` y `cleanupWorktrees` aceptan una lista de raíces. `delegation_cleanup`, `SessionStart` y `sdd_feature_status` pasan `knownRepos`.
  - `SessionStart` quita del registro los repos que ya no existen (E5).
- **Reuses**: `managedWorktrees`, `StateStore.update`.
- **Duplicates**: — none
- **Depends on**: C1

### C5 — Guardia de `readMode: "cwd"` y agy en plan

- **Implements**: R6, R7
- **Where**: `server/src/secrets-scan.ts` (nuevo), `server/src/delegate.ts`, `server/src/config.ts`, `server/src/providers/antigravity.ts`, `config/multiprovider.example.json`
- **What**:
  - `scanSecrets(dir, { maxDepth: 6, maxEntries: 20_000 })` recorre sin seguir symlinks y salta `node_modules` y `.git`. Devuelve `{ found: string[] (relativas), truncated: boolean }`, y para en el sexto hallazgo.
  - `delegate()` en read con `readMode: "cwd"` la corre sobre el directorio efectivo. Con `found` o `truncated` y sin `isolation.allowCwdWithSecrets`, falla con `UNSAFE_READ_MODE` sin lanzar a ningún worker. Con el flag, deja una nota.
  - `config.ts` agrega `isolation.allowCwdWithSecrets` (`false`) e `isolation.symlinkByRepo` (`{}`).
  - `antigravity.ts`: `DEFAULT_READ_ARGS = ["--mode", "plan"]`, usado como `DEFAULT_WRITE_ARGS` cuando `readModeArgs` no está definido.
  - En `multiprovider.example.json`, `readModeArgs` se quita para no anular el valor por defecto.
- **Reuses**: el patrón `.env*` de `isSensitivePath`.
- **Duplicates**: — none
- **Depends on**: C1

### C6 — Cadena por modo

- **Implements**: R8
- **Where**: `server/src/config.ts`, `server/src/fallback.ts`, `server/src/delegate.ts`, `server/src/sdd/task-delegation.ts`
- **What**:
  - `chainByMode: { read?: ChainEntry[]; write?: ChainEntry[] }` con `.min(1)` en cada uno.
  - `chainFor(config, mode)` devuelve `config.chainByMode[mode] ?? config.chain`.
  - `resolveOrder(chain, first, fallback)` no cambia y recibe esa cadena.
  - Con `provider: "auto"`, si la ruta apunta fuera de `chainFor`, se ignora con una nota y el orden es la cadena del modo.
  - `pickProvider` de `sdd_task_claim` usa `chainFor(config, "write")`.
- **Reuses**: `resolveOrder`, `routeTask`.
- **Duplicates**: — none
- **Depends on**: —

### C7 — `requestedProvider` y `Verify` múltiple

- **Implements**: R9, R10
- **Where**: `server/src/delegate.ts`, `server/src/state.ts`, `server/src/sdd/task-delegation.ts`, `server/tests/sdd-verify.spec.ts`, `server/tests/sdd-artifacts.spec.ts`
- **What**:
  - `DelegateResponse.requestedProvider`.
  - Si `provider` existe y difiere del pedido (o del ruteado en `auto`), una nota del tipo `requested <x>, answered by <y> (fallback after <x>: <errorType>)`, que toma el `errorType` de `attempts`.
  - `RecentDelegation.requested` ya existe y se revisa que se rellene.
  - `sdd_task_delegate` mantiene su nota del Owner.
  - Tests SC7: `parseTasks` con `` `a` y `b` `` da dos `verifyCommands`, y `verifyTask` da dos ítems `verify`.
- **Reuses**: `attempts`, `recordRecent`.
- **Duplicates**: la nota del Owner en `task-delegation.ts:186` cubre otro caso (corregir el Owner), así que se mantiene.
- **Depends on**: —

### C8 — Doctor, documentación y versión

- **Implements**: R12, R3 (documentación del riesgo residual), todas (documentación)
- **Where**: `server/src/doctor.ts`, `README.md`, `docs/nested-repos.md` (nuevo), `skills/multi-provider/SKILL.md`, `commands/sdd-delegate.md`, `commands/delegate.md`, `agents/codex-worker.md`, `agents/agy-worker.md`, archivos de versión
- **What**:
  - Check de doctor `workspace repos`: repos git anidados de primer nivel y de `.claude/worktrees/*/`, con `scanSecrets` por repo.
  - Check `read isolation`: `cwd` con `.env*` es `warn`, con el fix `isolation.readMode: "worktree"`. `worktree` es `ok`, con la nota del riesgo residual de Q1.
  - Documentación de `repo`, `**Repo**`, `symlinkByRepo`, `chainByMode`, `allowCwdWithSecrets` y el riesgo residual.
  - Subida a 0.4.0 y `server/dist` reconstruido.
- **Reuses**: `scanSecrets` (C5), formato `DoctorCheck`.
- **Duplicates**: — none
- **Depends on**: C1–C7

## Build order

1. C1
2. C2, C3, C4, C5 (parallel; C2 y C5 tocan `delegate.ts` en zonas distintas, así que se secuencian en tasks si chocan)
3. C6, C7 (parallel, independientes de C2–C5)
4. C8

## Evidence per requirement

| R#/E# | Evidence | Exists today? |
|---|---|---|
| R1 | `repo.spec.ts` (nuevo) — `..`, absoluta, symlink que escapa, subdirectorio, no-git → códigos; `delegate.spec.ts` — el adapter falso no registra llamadas | no — Phase 5 |
| R2 | `delegate.spec.ts` — `repo` anidado: `meta.repoRoot` = repo, `files` con y sin prefijo, `symlinkByRepo`, `repo` en la respuesta | no — Phase 5 |
| R3 | `delegate.spec.ts` (SC1) — `FAKE_MODE=probe-secrets`: `package.json` sí, `.env` `ENOENT`, sin la ruta del workspace en el prompt ni en el env; `guardrails.spec.ts` — hooks fuera del gitDir de origen; symlink `.env` omitido | no — Phase 5 |
| R4 | `sdd-task-delegation.spec.ts` — orden de resolución, `REPO_NOT_FOUND` sin escribir el Owner, claim en el `HEAD` de la raíz | no — Phase 5 |
| R5 | `sdd-task-delegation.spec.ts` (SC2) — `Verify` corre en el `mp/*` del worktree de spec; `sdd-verify.spec.ts` — gate con `Where` de otro repo → `manual` | no — Phase 5 |
| R6 | `delegate.spec.ts` (SC4) — `UNSAFE_READ_MODE` y `allowCwdWithSecrets`; `secrets-scan.spec.ts` — límites y saltos | no — Phase 5 |
| R7 | `adapters.spec.ts` — args de agy en read incluyen `--mode plan`; explícito lo reemplaza | sí, parcial — existe el test de args |
| R8 | `fallback.spec.ts` / `delegate.spec.ts` (SC5) — `chainByMode.read` limita el fallback; write intacto | no — Phase 5 |
| R9 | `delegate.spec.ts` (SC6) — `requestedProvider` y nota con fallback; `sdd-task-delegation.spec.ts` igual | no — Phase 5 |
| R10 | `sdd-artifacts.spec.ts`, `sdd-verify.spec.ts` (SC7) | sí, parcial — el comportamiento existe, falta el test |
| R11 | `guardrails.spec.ts` o `worktree.spec.ts` — `listWorktrees`/`cleanupWorktrees` con un repo registrado; `hooks-setup.spec.ts` — `SessionStart` limpia y poda | no — Phase 5 |
| R12 | `doctor.spec.ts` (SC9) | no — Phase 5 |
| E1 | `delegate.spec.ts` — repo anidado sin commits → mensaje con el repo | no — Phase 5 |
| E2 | `repo.spec.ts` — subdirectorio → sugerencia de la raíz | no — Phase 5 |
| E3 | `sdd-task-delegation.spec.ts` — worktree de spec vacío → raíz + nota | no — Phase 5 |
| E4 | `sdd-task-delegation.spec.ts` — `Files` con `.env` versionado → omitido | sí, parcial — `prompt-builder` ya lo omite |
| E5 | `hooks-setup.spec.ts` — repo registrado borrado → podado sin error | no — Phase 5 |
| E6 | `delegate.spec.ts` — dos `repo` distintos → dos `repoKey` | sí, parcial — `repoKey` ya incluye el hash |
| SC8 | gate Tests: los 272 tests existentes sin modificar | sí |

## Data changes, delivery & dependencies

- **Data changes**:
  - `state.json` gana `repos[]`.
  - `WorktreeMeta` gana `skippedSymlinks?`, y `hooksDir` cambia de ubicación (los worktrees ya creados guardan su ruta vieja en `meta`, que sigue siendo válida).
  - `DelegateResponse` gana `repo?` y `requestedProvider`. Todo es aditivo.
- **Delivery**:
  - Versión menor 0.4.0, porque cambia un default (agy en read con `--mode plan`) y el `delegate` read con `readMode: "cwd"` puede rechazar llamadas que antes corrían.
  - `providers.antigravity.readModeArgs: []` e `isolation.allowCwdWithSecrets: true` restauran el comportamiento anterior.
- **Dependencies**: — none

## Risks

| Risk | Mitigation |
|---|---|
| `realpath` difiere entre plataformas (macOS `/private`, Windows 8.3, junctions) | `realOrResolved` ya resuelve los dos casos para `assertManagedPath`; los tests de C1 corren en la matriz de CI |
| `git worktree add` desde un worktree de spec (`.claude/worktrees/<slug>/<Repo>`) | git comparte el repo y la base es el `HEAD` de ese worktree; SC2 lo prueba y `removeWorktree` corre `worktree remove` desde `meta.repoRoot` |
| Mover los hooks fuera del gitDir rompe `core.hooksPath` | El path sigue siendo absoluto y fijado por `GIT_CONFIG_*` en `workerEnv`; los tests de `guardrails.spec.ts` (commit bloqueado) cubren el cambio |
| `scanSecrets` lento en un workspace grande | Límites de profundidad y entradas, y solo corre con `readMode: "cwd"` y en doctor; si llega al límite, rechaza (más seguro) |
| El worker lee `.env` por ruta absoluta siguiendo `gitdir:` | Riesgo residual aceptado (Q1 a): instrucción en el prompt, sin rutas del origen en el env, y aviso en doctor y documentación |
| Test intermitente pre-existente en la baseline | Se identifica en la primera tarea que lo vea fallar y se anota en sus Notes; no cuenta como fallo nuevo salvo que sea de un archivo tocado |

## Requirement coverage

| Requirement | Covered by |
|---|---|
| R1 | C1 |
| R2 | C1 |
| R3 | C2, C8 |
| R4 | C3 |
| R5 | C3 |
| R6 | C5 |
| R7 | C5 |
| R8 | C6 |
| R9 | C7 |
| R10 | C7 |
| R11 | C4 |
| R12 | C8 |
| E1 | C1 |
| E2 | C1 |
| E3 | C3 |
| E4 | C2 |
| E5 | C4 |
| E6 | C1 |
