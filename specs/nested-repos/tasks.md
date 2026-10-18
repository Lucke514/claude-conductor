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

- [x] Done
- **Owner**: —
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
- **Notes**: Hecha por Claude. `server/src/secrets-scan.ts` hace un recorrido en anchura acotado (profundidad 6, 20 000 entradas, 5 hallazgos), sin seguir symlinks y saltando `node_modules` y `.git`. `delegate()` sin worktree (`readMode: "cwd"`) lanza `UNSAFE_READ_MODE` (código en `RepoError`) antes de lanzar al worker, salvo con `isolation.allowCwdWithSecrets`, que deja una nota. agy en read usa `DEFAULT_READ_ARGS = ["--mode", "plan"]`, comprobado contra `agy --help` 1.4.2 (`--mode accept-edits|auto|plan`). En el ejemplo de config, `readModeArgs` muestra ese mismo valor en vez de `[]`, que lo anulaba. Se actualizó **un test existente**: `adapters.spec.ts::"plain spawn…"` fijaba los args exactos de agy en read; el cambio es el default deliberado de R7, no algo de `repo`, así que SC8 sigue cumpliéndose para `repo`/`**Repo**`. Tests nuevos: `secrets-scan.spec.ts` (3), SC4 en `delegate.spec.ts` y R7 en `adapters.spec.ts`. Gates: typecheck 0 errores, 299 passed, plugin validate ok, plugin test 12 pass. Clean-code: none · close calls: `UNSAFE_READ_MODE` vive en `RepoErrorCode` para reutilizar el reporte de `code` de `fail()`, aunque no es un error de repo

## T6 — Cadena por modo

- [x] Done
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
- **Notes**: Hecha por Claude. `chainByMode` (`read`/`write`, cada uno `.min(1)`) en `config.ts`, y `chainFor(config, mode)` en `fallback.ts`. En `delegate()`, una ruta de `auto` fuera de la cadena del modo se ignora con una nota (`routing` queda sin definir), y un proveedor explícito se intenta primero. `pickProvider` de `sdd_task_claim` usa la cadena de write. `state.chain` sigue mostrando `chain`. Tests: 3 en `delegate.spec.ts` (SC5, write/failed/sin config, explícito y `auto`) y 1 en `config.spec.ts`. Gates: typecheck 0 errores, 303 passed, plugin validate ok, plugin test 12 pass. Clean-code: none · close calls: none

## T7 — `requestedProvider` y `Verify` con varios comandos

- [x] Done
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
- **Notes**: Hecha por Claude. `DelegateResponse.requestedProvider` = `params.provider` (en `sdd_task_delegate`, el proveedor del Owner). Si quien respondió no es el esperado (el explícito, el ruteado en `auto` o el primero de la cadena del modo), se añade la nota `requested <x>, answered by <y> (fallback after <x>: <errorType|skipped>)`. `recent.requested` y el audit ya guardaban lo pedido, así que `state.ts` no cambió. R10 ya funcionaba y queda fijado por un test en `sdd-verify.spec.ts` (dos comandos → dos ítems; `&&` en un backtick → `manual`). Tests: SC6 en `delegate.spec.ts` y en `sdd-task-delegation.spec.ts`, SC7 en `sdd-verify.spec.ts`. Gates: typecheck 0 errores, 306 passed, plugin validate ok, plugin test 12 pass. Clean-code: none · close calls: none

## T8 — `/mp-doctor`: repos anidados y aislamiento de lectura

- [x] Done
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
- **Notes**: Hecha por Claude. `workspaceChecks(projectDir, config)` en `doctor.ts` (lo llama `runDoctor` después del check de `.mcp.json`) añade `workspace repos` (repos de primer nivel y de `.claude/worktrees/<slug>/`, marcando `(.env)` con `scanSecrets`) y `read isolation` (`cwd` con `.env*` → `warn` con fix; `worktree` → `ok` con el riesgo residual de Q1). `antigravity: flags` también comprueba `--mode … plan` cuando `readModeArgs` no está fijado; el `--help` de `fake-agy.mjs` gana esa línea (copiada del formato real de agy 1.4.2). Tests: 2 en `doctor.spec.ts` (SC9, sin repos más `runDoctor`). Gates: typecheck 0 errores, 308 passed, plugin validate ok, plugin test 12 pass. Clean-code: none · close calls: none

## T9 — Documentación

- [x] Done
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
- **Notes**: Hecha por Claude. `docs/nested-repos.md` (nuevo) cubre `repo`, `**Repo**` y su orden de resolución, los errores `REPO_*` y `UNSAFE_READ_MODE`, la config nueva, `requestedProvider`, el `Verify` con varios comandos, `/mp-doctor` y el riesgo residual de Q1. README: filas de `chainByMode`, `allowCwdWithSecrets`, `symlinkByRepo` y `readModeArgs` de agy, una sección "Workspaces con repos anidados", 3 filas de troubleshooting y 2 limitaciones (incluido el riesgo residual). El skill, `commands/delegate.md` (`--repo`), `commands/sdd-delegate.md` y los dos agentes (`repo`, `requestedProvider` en el veredicto) quedan actualizados. Gates: typecheck 0 errores, 308 passed, plugin validate ok, plugin test 12 pass. Clean-code: none · close calls: `config/multiprovider.example.json` no muestra `chainByMode` ni `symlinkByRepo` (no estaba en Files); el README y la doc los documentan con ejemplo

---

## Gaps found in verification

Hallazgos de una revisión independiente en modo read con codex (delegación 20261018065508-4a491e, ~120 s). Claude verificó cada uno contra el código; se resolvieron en un mismo commit, con tests.

- [x] **G1** — `secrets-scan.ts`: no entraba en directorios enlazados (un `config -> /otro/dir` con `.env` pasaba como seguro), un `readdir` fallido contaba como vacío, y el patrón no cubría `.envrc`, `.env-local` ni `.env_prod`. Ahora sigue los symlinks de directorio (cada directorio real una vez, sin bucles), un directorio ilegible da `truncated`, y cuenta cualquier nombre `.env*`. El mismo patrón amplio pasa a `isSensitivePath`. Se reemplazó el test que fijaba "no sigue symlinks".
- [x] **G2** — `delegate.ts`: con el worktree de la spec, `symlinkByRepo` se buscaba por `.claude/worktrees/<slug>/<Repo>` y no por `<Repo>` (R5). Además, el prefijo `<Repo>/` se quitaba dos veces (`task-delegation` y `delegate`), y `repo: ""` usaba la raíz. Ahora `delegate` recibe `repoName`, busca `symlinkByRepo[rel] ?? symlinkByRepo[repoName]`, quita un solo prefijo (de `files` y de `scopeFiles`), y rechaza `repo: ""` con `REPO_INVALID`.
- [x] **G3** — `verify.ts`: una tarea **sin** `**Repo**` dejaba `manual` un gate cuyo `Where` nombraba un repo anidado, un cambio frente a hoy (R4/SC8). Ahora la regla de R5 solo aplica a tareas con `**Repo**`.
- [x] **G4** — R3 por symlinks, ligado al requisito no negociable del usuario:
  - un `files` que es un symlink a `.env` (`settings.txt -> .env`) entraba en el prompt. Ya pasaba antes de esta rama. Ahora `prompt-builder` resuelve la ruta real, rechaza destinos fuera del proyecto y vuelve a aplicar `isSensitivePath`;
  - una entrada de `symlink`/`symlinkByRepo` con un nombre inocente que apunta a un secreto, o un directorio con `.env*` dentro, se enlazaba. Ahora se omite y se anota (`node_modules` no se recorre: son paquetes);
  - el `PATH` heredado podía nombrar el repo de origen (`<repo>/node_modules/.bin`). Ahora `workerEnv` quita las entradas que están bajo el proyecto o el repo de origen.
- [x] **G5** — `repo.ts`: `inside()` rechazaba nombres que solo empiezan por `..` (`..backend`). Ahora compara `..` como segmento.
- [>] **G6** — Deferred: `managedWorktrees` lista todos los `mp/*` del git dir compartido. Si el proyecto contiene un worktree enlazado de un repo externo, `delegation_cleanup` también limpia los `mp/*` creados desde ese repo. Ya pasaba antes de esta rama con un proyecto que fuera un worktree enlazado, y el escenario es poco realista. Queda como deuda.
- [x] **G8** — CI en Windows (run 39106269117): 4 tests nuevos comparaban rutas con `realpathSync`, que no expande los nombres 8.3 (`RUNNER~1`), contra rutas que git devuelve en forma larga. Los tests pasan a `realpathSync.native`, como ya hacía el código (`realOrResolved`). Solo cambian tests; Linux y macOS ya pasaban.
- [~] **G7** — Waived: el texto del brief de la tarea muestra los `Files` con el prefijo `<Repo>/` aunque los adjuntos van sin él. Es cosmético; el worker recibe las dos formas y las rutas del worktree son relativas al repo.

---

## Verification reports

### Verification report — nested-repos — 2026-10-18 — pass 1

Change set: `main@b8fc123...HEAD` (`feature/nested-repos`)
Converged: yes — G6 diferido (pre-existente, poco realista) y G7 descartado (cosmético)

| Req | Verdict | Evidence (case · assertion · clause) |
|---|---|---|
| R1 | met | `repo.spec.ts` (5 casos: `..`, absoluta, symlink que sale, inexistente, subdirectorio con la raíz sugerida, `..backend` válido); `delegate.spec.ts::"R1/SC3…"` (el adapter espía no registra llamadas; `git worktree list` sin cambios) y `"G2…"` (`repo: ""`) |
| R2 | met | `delegate.spec.ts::"R2: the worktree comes from the nested repo…"` (`meta.repoRoot`, `files` con y sin prefijo, rama `mp/*` en el repo anidado, `apply` en él) y `"R2: symlinkByRepo…"` |
| R3 | met | `delegate.spec.ts::"R3/SC1…"` (`package.json` sí, `.env` `ENOENT`, sin la ruta del workspace en el env ni en el prompt), `"R3: a symlink entry naming secrets…"` (hooks fuera del `.git` de origen), `"R3: … still cannot commit"`, `"G4…"` (symlink en `files`, directorios con `.env`, `PATH`). **Prueba real** con codex: worker en `backend-monolith`, `ls -la` sin `.env`, la palabra canario no aparece. Riesgo residual documentado (Q1) |
| R4 | met | `sdd-task-delegation.spec.ts::"SC2…"`, `"R4: without a spec worktree…"`, `"R4: an unknown **Repo**…"` (Owner sin escribir); `sdd-artifacts.spec.ts::"nested-repos R4…"` |
| R5 | met | `sdd-task-delegation.spec.ts::"SC2…"` (Verify en el `mp/*` del worktree de spec), `"R5: a gate whose Where names another repo…"`, `"G2: … symlinkByRepo is keyed by the task's **Repo** name"`, `"G3…"` |
| R6 | met | `delegate.spec.ts::"R6/SC4…"`; `secrets-scan.spec.ts` (6 casos, incluidos symlinks, bucles, `.env*` y directorio ilegible) |
| R7 | met | `adapters.spec.ts::"nested-repos R7…"`; `agy --help` 1.4.2 lista `--mode … plan` |
| R8 | met | `delegate.spec.ts` (3 casos de `chainByMode`: SC5, write intacto / `failed` / sin config, explícito y `auto`); `config.spec.ts` |
| R9 | met | `delegate.spec.ts::"R9/SC6…"`; `sdd-task-delegation.spec.ts::"nested-repos R9/SC6…"`; prueba real: `requestedProvider: "codex"` |
| R10 | met | `sdd-verify.spec.ts::"nested-repos R10/SC7…"` |
| R11 | met | `delegate.spec.ts::"R11…"`, `sdd-pipeline.spec.ts::"nested-repos R11…"`, `hooks-setup.spec.ts::"nested-repos R11/E5…"` |
| R12 | met | `doctor.spec.ts::"SC9…"` y `"without nested repos…"` |
| E1 | met | `delegate.spec.ts::"E1…"` |
| E2 | met | `repo.spec.ts::"rejects a missing path, a plain directory and a subdirectory…"` |
| E3 | met | `sdd-task-delegation.spec.ts::"E3…"` |
| E4 | met | `delegate.spec.ts::"E4…"` y `"G4…"` |
| E5 | met | `hooks-setup.spec.ts::"nested-repos R11/E5…"` |
| E6 | met | `delegate.spec.ts::"E6…"` |

Gates: typecheck ✅ exit 0 · tests ✅ `Test Files 23 passed (23) · Tests 315 passed (315)` (local y matriz de CI tras G8) (baseline 272; +43 nuevos, 0 omitidos salvo el caso `chmod` en Windows/root) · `claude plugin validate .` ✅ · `claude plugin test .` ✅ `12 pass, 0 fail` · Dist ✅ reconstruido · CI multiplataforma: en el push a `main` (merge sin PR, decisión del plan)
Cross-review: codex en modo read (delegación 20261018065508-4a491e) → 11 hallazgos, todos verificados; 9 resueltos (G1–G5), 1 diferido (G6), 1 descartado (G7)
Dead-code sweep: `tsc --noUnusedLocals --noUnusedParameters` → 0
Tests changed: `adapters.spec.ts::"plain spawn…"` (args de agy en read, por el default deliberado de R7) y `secrets-scan.spec.ts` ("no sigue symlinks" → G1). Ninguno por `repo`/`**Repo**`, así que SC8 se cumple
Success criteria: SC1–SC9 met by tests; SC1 también en una delegación real con codex
Attribution: none
Shortcuts declared: R3 es una garantía a nivel de cwd (Q1 a): el puntero `gitdir:` del worktree sigue nombrando el repo de origen
