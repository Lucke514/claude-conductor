<!-- Status enum: draft | in-review | approved | abandoned -->

# Tasks: Delegación sobre repos anidados (workspace multi-repo)

> Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md)
> Status: approved
> Last updated: 2026-10-18

Una tarea = una sesión. Hecha significa:
- su **Verify** pasa;
- los gates del plan pasan sin fallos nuevos contra su baseline (`npm --prefix server run typecheck`, `npm --prefix server test`, `claude plugin validate .`, `claude plugin test .`);
- `server/dist` está reconstruido y committeado si la tarea toca `server/src`;
- el diff está limpio.

Commits con prefijo `nested-repos: `, solo de Claude y sin trailers de atribución.

Orden: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9. Casi todas tocan `server/src/delegate.ts`, así que van en serie. T1–T4 son la prioridad 1 del usuario (SC1, SC2, SC3, SC8). La versión 0.4.0 se sube al integrar, cuando pasan SC1–SC8.

## T1 — Repo destino validado en `delegate`

- [x] Done
- **Owner**: —
- **Component**: C1 · **Implements**: R1, R2, E1, E2, E6
- **Files**: `server/src/repo.ts`, `server/src/delegate.ts`, `server/src/prompt-builder.ts`, `server/src/worktree.ts`, `server/src/index.ts`, `server/src/config.ts`, `server/tests/repo.spec.ts`, `server/tests/delegate.spec.ts`, `server/tests/helpers.ts`
- **Do**:
  - Crear `server/src/repo.ts` con `RepoError` (`code`: `REPO_INVALID` | `REPO_NOT_GIT` | `REPO_NOT_FOUND`) y `resolveRepo(projectDir, rel)`, que aplica las reglas de R1 comparando con `realOrResolved` (se exporta desde `worktree.ts`). E2: un subdirectorio sugiere la raíz real relativa a `projectDir`.
  - `DelegateParams.repo?`: se valida antes de `jobs.start` y de cualquier worktree o worker. Con `repo`, `delegate()` hace todo sobre ese repo:
    - `repoRoot` = el repo resuelto;
    - `buildPrompt` resuelve los `files` contra él y quita el prefijo `<repo>/`;
    - `symlink` sale de `isolation.symlinkByRepo[rel] ?? isolation.symlink`, y `symlinkByRepo` se agrega a `config.ts` con `{}` por defecto;
    - la respuesta trae `repo`.
  - E1: el error de "no commits" nombra el repo.
  - `index.ts` agrega `repo` al `inputSchema` de `delegate` y `fail()` reporta `code` también para `RepoError`.
  - `helpers.ts` gana `makeWorkspace()`: un repo raíz que ignora `backend-monolith/`, más un `backend-monolith/` con repo propio, `package.json` versionado y `.env` sin versionar.
- **Acceptance**:
  - `repo` con `..`, absoluto, con un symlink que sale de `projectDir`, o que no es repo git → `REPO_INVALID` / `REPO_NOT_GIT`, sin que el adapter falso registre llamadas ni se cree un worktree (SC3);
  - un subdirectorio de un repo → `REPO_NOT_GIT`, con la raíz sugerida;
  - `delegate` read con `repo: "backend-monolith"` crea el worktree desde ese repo (`meta.repoRoot`), con `backend-monolith/package.json` presente en su cwd;
  - `files` con y sin el prefijo `backend-monolith/` se incluyen en el prompt;
  - `symlinkByRepo` enlaza la entrada del repo;
  - dos repos distintos usan dos directorios `repoKey`;
  - sin `repo`, los tests existentes siguen pasando sin cambiarlos (SC8).
- **Verify**: `npm --prefix server test -- repo delegate`
- **Notes**: Hecha por Claude. `server/src/repo.ts` (`RepoError`, `resolveRepo`) valida con `realOrResolved` (ahora exportado desde `worktree.ts`) antes de `jobs.start`; un path inexistente da `REPO_NOT_FOUND`. `delegate()` usa el repo resuelto como `repoRoot`, base de `buildPrompt` (quita el prefijo `<repo>/` de `files`) y cwd sin worktree; `isolation.symlinkByRepo` en `config.ts`. Como hoy, el error de "no commits" se lanza (no `failed`) y ahora nombra el repo. `makeWorkspace()` en `tests/helpers.ts`; `tests/repo.spec.ts` (4) y 5 casos en `delegate.spec.ts`. Gates: typecheck 0 errores, 281 passed (272 + 9), plugin validate ok, plugin test 12 pass. Clean-code: none · close calls: none

## T2 — Sin rutas ni secretos del origen en el worker

- [x] Done
- **Owner**: —
- **Component**: C2 · **Implements**: R3, E4
- **Files**: `server/src/worktree.ts`, `server/src/worker-env.ts`, `server/src/delegate.ts`, `server/tests/fixtures/fake-codex.mjs`, `server/tests/delegate.spec.ts`, `server/tests/guardrails.spec.ts`
- **Do**:
  - `createWorktree` omite las entradas de `symlink` que cumplen `isSensitivePath` y las devuelve en `meta.skippedSymlinks`. `delegate()` las anota en `notes`.
  - Los hooks bloqueantes pasan a `worktreesDir()/<repoKey>/.hooks/<ts>/`, y `removeWorktree` borra ese directorio.
  - `workerEnv` quita `CLAUDE_PROJECT_DIR`, `MP_PROJECT_DIR`, `PWD`, `OLDPWD` e `INIT_CWD`.
  - `fake-codex.mjs` agrega `FAKE_MODE=probe-secrets`. Lista su cwd, intenta leer `package.json` y `.env` (relativos) y dice si alguna variable de entorno contiene `FAKE_FORBIDDEN_PATH`.
- **Acceptance**:
  - SC1 sobre `makeWorkspace()`: el worker ve `package.json`, su lectura de `.env` falla con `ENOENT`, ninguna variable de su entorno contiene la ruta del workspace y el prompt tampoco;
  - un `symlinkByRepo` con `.env` se omite y aparece en `notes`;
  - `core.hooksPath` del worker apunta fuera del `.git` del repo de origen, y un commit del worker sigue bloqueado;
  - un `Files` con un `.env` versionado queda fuera del prompt (E4);
  - los tests existentes siguen pasando.
- **Verify**: `npm --prefix server test -- delegate guardrails`
- **Notes**: Hecha por Claude. `createWorktree` omite las entradas de `symlink` con `isSensitivePath` (`meta.skippedSymlinks`, nota en `delegate`). Los hooks bloqueantes pasan a `hooksDirFor(wtPath)` = `<repoKey>/.hooks/<worktree>` bajo el directorio del plugin, que `removeWorktree` borra; los worktrees antiguos conservan su `hooksDir` en `meta`. `workerEnv` quita `PROJECT_PATH_ENV` (`CLAUDE_PROJECT_DIR`, `MP_PROJECT_DIR`, `PWD`, `OLDPWD`, `INIT_CWD`). `fake-codex.mjs` gana `FAKE_MODE=probe-secrets`. 4 casos nuevos en `delegate.spec.ts` (SC1, symlink/hooks, commit bloqueado, E4). Gates: typecheck 0 errores, 285 passed, plugin validate ok, plugin test 12 pass. Clean-code: none · close calls: el puntero `gitdir:` del `.git` del worktree sigue nombrando el repo de origen (riesgo residual aceptado en Q1)

## T3 — `**Repo**` en `sdd_task_*` y gates por repo

- [x] Done
- **Owner**: —
- **Component**: C3 · **Implements**: R4, R5, E3
- **Files**: `server/src/sdd/artifacts.ts`, `server/src/sdd/task-delegation.ts`, `server/src/sdd/verify.ts`, `server/src/repo.ts`, `server/tests/sdd-fixtures.ts`, `server/tests/sdd-task-delegation.spec.ts`, `server/tests/sdd-verify.spec.ts`, `server/tests/sdd-artifacts.spec.ts`
- **Do**:
  - `parseTasks` lee `**Repo**` en `SddTask.repo` (`—` cuenta como sin repo).
  - `resolveTaskRepo(projectDir, slug, repo)` en `repo.ts` prueba `.claude/worktrees/<slug>/<Repo>` y después `<Repo>`. E3 anota el descarte del primero. Si no encuentra ninguno, `REPO_NOT_FOUND` con las rutas probadas.
  - `sdd_task_claim` lo resuelve antes de `writeOwner` y devuelve `repo`.
  - `sdd_task_delegate` pasa `repo` a `delegate` y quita el prefijo `<Repo>/` de `scopeFiles`. `claimCommitted` sigue en `projectDir`.
  - `verifyTask` recibe `{ repo, workspaceRepos }`: un gate cuyo `Where` es otro repo de primer nivel queda `manual` con `runs in <repo>`.
- **Acceptance**:
  - SC2: con `.claude/worktrees/<slug>/backend-monolith` en `feat/<slug>`, `sdd_task_delegate` crea `mp/*` con base en el `HEAD` de esa rama, el `Verify` corre allí y pasa, y `delegation_apply` deja el diff en ese worktree sin cambiar `git status` en la raíz ni en el `backend-monolith` de la raíz;
  - sin el worktree de spec, se usa `backend-monolith` de la raíz;
  - un `**Repo**` inexistente → `REPO_NOT_FOUND`, con el Owner sin escribir;
  - un worktree de spec que no es repo → raíz + nota;
  - un gate con `Where` = otro repo → `manual`;
  - una tarea sin `**Repo**` se comporta como hoy.
- **Verify**: `npm --prefix server test -- sdd`
- **Notes**: Hecha por Claude. `SddTask.repo` sale de `**Repo**` (con o sin backticks). En `repo.ts`, `resolveTaskRepo` prueba el worktree de la spec y después la raíz (E3 anota el descarte), y `workspaceRepos` lista los repos de primer nivel. `sdd_task_claim` resuelve el repo antes de `writeOwner` y lo devuelve. `sdd_task_delegate` pasa `repo` y quita el prefijo `<Repo>/` de `files` y `scopeFiles`. `verifyTask` acepta `{ repo, workspaceRepos }` y deja `manual` un gate cuyo `Where` es otro repo. `claimCommitted` no cambia (raíz). 5 casos en `sdd-task-delegation.spec.ts` (SC2 con un worktree de spec en `feat/demo`, raíz, `REPO_NOT_FOUND`, E3, gate de otro repo) y 1 en `sdd-artifacts.spec.ts`. Gates: typecheck 0 errores, 291 passed, plugin validate ok, plugin test 12 pass. Clean-code: none · close calls: `resolveTaskRepo` corre dos veces (claim y delegate) porque el repo resuelto no se guarda en `tasks.md`; es barato y refleja el estado actual del disco

## T4 — Registro de repos y listados

- [x] Done
- **Owner**: —
- **Component**: C4 · **Implements**: R11, E5
- **Files**: `server/src/state.ts`, `server/src/worktree.ts`, `server/src/delegate.ts`, `server/src/index.ts`, `server/src/hooks.ts`, `server/src/sdd/pipeline.ts`, `server/tests/guardrails.spec.ts`, `server/tests/hooks-setup.spec.ts`, `server/tests/sdd-pipeline.spec.ts`
- **Do**:
  - `MpState.repos?: string[]`: `delegate()` con `repo` registra el `repoRoot`, sin duplicados.
  - `knownRepos(projectDir, state)` = la raíz más los registrados que existen y siguen bajo `projectDir`.
  - `listWorktrees` y `cleanupWorktrees` aceptan una lista de raíces. `delegation_cleanup`, `SessionStart` y `sdd_feature_status` usan `knownRepos`.
  - `SessionStart` poda del registro los repos que ya no existen.
- **Acceptance**:
  - después de un `delegate` write con `repo`, `delegation_cleanup` elimina su worktree y su rama `mp/*`;
  - `sdd_feature_status` ve un worktree vivo de una tarea en un repo anidado;
  - un repo registrado y borrado no rompe nada y desaparece del registro tras `SessionStart`;
  - un repo registrado fuera de `projectDir` se ignora;
  - los tests existentes siguen pasando.
- **Verify**: `npm --prefix server test -- guardrails hooks-setup sdd-pipeline`
- **Notes**: Hecha por Claude. `MpState.repos` y `registerRepo` en `state.ts`; `delegate()` registra el repo resuelto. `knownRepoDirs` en `repo.ts` = la raíz más los registrados que existen bajo `projectDir`. `listWorktrees` y `cleanupWorktrees` aceptan una o varias rutas y deduplican raíces y worktrees por `realpath`. `delegation_cleanup`, `SessionStart` (que antes poda del registro los repos que no existen) y `sdd_feature_status` (con `store` opcional en su ctx) usan `knownRepoDirs`. Tests: 1 en `delegate.spec.ts`, 1 en `sdd-pipeline.spec.ts` (orphan_claim resuelto por el registro) y 1 en `hooks-setup.spec.ts` (SessionStart). Gates: typecheck 0 errores, 294 passed, plugin validate ok, plugin test 12 pass. Clean-code: none · close calls: none

## T5 — Guardia de `readMode: "cwd"` y agy en plan

- [ ] Open
- **Owner**: claude (sesión principal) since 2026-10-18
- **Component**: C5 · **Implements**: R6, R7
- **Files**: `server/src/secrets-scan.ts`, `server/src/delegate.ts`, `server/src/config.ts`, `server/src/providers/antigravity.ts`, `config/multiprovider.example.json`, `server/tests/secrets-scan.spec.ts`, `server/tests/delegate.spec.ts`, `server/tests/adapters.spec.ts`
- **Do**:
  - `scanSecrets(dir, { maxDepth: 6, maxEntries: 20_000 })`: no sigue symlinks, salta `node_modules` y `.git`, para en el sexto hallazgo y devuelve `{ found, truncated }`.
  - `delegate()` en read con `readMode: "cwd"` la corre sobre el directorio efectivo. Con `found` o `truncated` y sin `isolation.allowCwdWithSecrets`, falla con `UNSAFE_READ_MODE` sin lanzar a ningún worker. Con el flag, deja una nota.
  - `config.ts` agrega `allowCwdWithSecrets: false`.
  - En agy, `readModeArgs` es `["--mode", "plan"]` por defecto, y en el ejemplo de config se quita `readModeArgs: []`.
- **Acceptance**:
  - SC4: `cwd` con un `.env` en un repo anidado → `UNSAFE_READ_MODE` con su ruta relativa y el adapter sin llamar; con `allowCwdWithSecrets: true` corre y lo dice en `notes`;
  - llegar al límite de entradas también rechaza;
  - `node_modules/.env` no cuenta;
  - agy en read lleva `--mode plan`, y un `readModeArgs` explícito lo reemplaza;
  - los tests existentes siguen pasando.
- **Verify**: `npm --prefix server test -- secrets-scan delegate adapters`

## T6 — Cadena por modo

- [ ] Open
- **Owner**: —
- **Component**: C6 · **Implements**: R8
- **Files**: `server/src/config.ts`, `server/src/fallback.ts`, `server/src/delegate.ts`, `server/src/sdd/task-delegation.ts`, `server/tests/config.spec.ts`, `server/tests/delegate.spec.ts`
- **Do**:
  - `chainByMode: { read?, write? }`, cada uno con `.min(1)`.
  - `chainFor(config, mode)` alimenta a `resolveOrder` en `delegate()`. Con `auto`, una ruta fuera de la cadena del modo se ignora con una nota.
  - `pickProvider` de `sdd_task_claim` usa `chainFor(config, "write")`.
- **Acceptance**:
  - SC5: con `chainByMode.read: ["codex", "claude"]` y Codex en `AUTH`, el resultado es `fallback_to_claude` y agy no registra ninguna llamada; en write, la cadena es `chain`;
  - sin `"claude"` en la cadena del modo, una cadena agotada termina en `failed`;
  - un `provider` explícito fuera de la cadena se intenta primero;
  - sin `chainByMode`, todo sigue igual.
- **Verify**: `npm --prefix server test -- config delegate fallback`

## T7 — `requestedProvider` y `Verify` con varios comandos

- [ ] Open
- **Owner**: —
- **Component**: C7 · **Implements**: R9, R10
- **Files**: `server/src/delegate.ts`, `server/src/state.ts`, `server/src/sdd/task-delegation.ts`, `server/tests/delegate.spec.ts`, `server/tests/sdd-task-delegation.spec.ts`, `server/tests/sdd-artifacts.spec.ts`, `server/tests/sdd-verify.spec.ts`
- **Do**:
  - `DelegateResponse.requestedProvider`.
  - Si `provider` difiere del pedido (o del ruteado en `auto`), una nota `requested <x>, answered by <y> (fallback after <x>: <errorType>)`.
  - `recent` guarda `requested` (revisarlo).
  - Tests que fijan R10.
- **Acceptance**:
  - SC6: un fallback codex → antigravity da `requestedProvider: "codex"`, `provider: "antigravity"` y la nota, en `delegate` y en `sdd_task_delegate`;
  - sin fallback, no hay nota;
  - SC7: un `Verify` `` `node -e "process.exit(0)"` y `node -e "process.exit(0)"` `` da dos ítems `kind: "verify"` que pasan;
  - un único backtick con `&&` queda `manual`.
- **Verify**: `npm --prefix server test -- delegate sdd`

## T8 — `/mp-doctor`: repos anidados y aislamiento de lectura

- [ ] Open
- **Owner**: —
- **Component**: C8 · **Implements**: R12
- **Files**: `server/src/doctor.ts`, `server/tests/doctor.spec.ts`
- **Do**:
  - Check `workspace repos`: repos git de primer nivel y de `.claude/worktrees/*/`, y para cada uno si `scanSecrets` encuentra `.env*`.
  - Check `read isolation`:
    - `cwd` con `.env*` alcanzable → `warn` con el fix `isolation.readMode: "worktree"`;
    - `worktree` → `ok`, con la nota del riesgo residual de Q1.
- **Acceptance**:
  - SC9: en `makeWorkspace()`, doctor lista `backend-monolith` con `.env` y marca `readMode: "cwd"` como `warn`;
  - sin repos anidados, el check queda `ok` o `skip` sin ruido;
  - los tests existentes siguen pasando.
- **Verify**: `npm --prefix server test -- doctor`

## T9 — Documentación

- [ ] Open
- **Owner**: —
- **Component**: C8 · **Implements**: R1–R12 (documentación), R3 (riesgo residual)
- **Files**: `README.md`, `docs/nested-repos.md`, `skills/multi-provider/SKILL.md`, `commands/delegate.md`, `commands/sdd-delegate.md`, `agents/codex-worker.md`, `agents/agy-worker.md`
- **Do**:
  - `docs/nested-repos.md`: el problema, `repo` y `**Repo**` con su orden de resolución, `symlinkByRepo`, `chainByMode`, `allowCwdWithSecrets`, `UNSAFE_READ_MODE`, el `Verify` con un backtick por comando y el riesgo residual de Q1.
  - Tabla de configuración del README y su sección de problemas comunes.
  - El skill y los agentes explican cuándo pasar `repo` y cómo leer `requestedProvider`.
- **Acceptance**:
  - cada opción nueva de config aparece en el README con su valor por defecto;
  - el riesgo residual está escrito en `docs/nested-repos.md` y en el README;
  - `claude plugin validate .` pasa.
- **Verify**: `claude plugin validate .`
