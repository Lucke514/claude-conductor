<!-- Status enum: draft | in-review | approved | implemented | superseded | abandoned -->

# Plan: Ciclo de vida seguro de las delegaciones

> Spec: [spec.md](./spec.md)
> Status: implemented
> Last updated: 2026-10-18

## Approach

La **meta del worktree** (`WorktreeMeta`, que ya se escribe al crear cada worktree `mp/*`) pasa a ser la fuente de verdad del ciclo de vida. Agrega `state`, `updatedAt`, `patchSha256` y el resultado de la verificación. Todo lo que hoy decide por inferencia pasa a leer ese estado:
- la limpieza (`mtime` del directorio);
- `applyWorktree` (recalcula el diff sin compararlo con nada);
- la política de conservación (`KEEP_ON`).

La verificación de `verify.commands` **se mueve del hook `post-delegate` al servidor**. Hoy corre en otro proceso (`cli hook post-delegate`), fuera del `JobRegistry` y sin señal, así que no hay forma limpia de mostrarla ni de cancelarla. Dentro de `delegate()` corre en el mismo job, en una fase `verifying`, con el mismo `AbortSignal` que el worker, y el hash se calcula cuando termina, en un solo lugar para `delegate` y `sdd_task_delegate`. El hook queda como formateador: convierte los resultados de la respuesta en `additionalContext`, igual que hoy.

La reserva de R7 reutiliza el patrón de lock que ya existe (`withLock` en `fsutil.ts`), pero es de larga duración y guarda el PID para detectar locks huérfanos.

Se descartaron dos alternativas:
- **Dejar la verificación en el hook y que `delegation_cancel` mate un PID ajeno.** Obliga a registrar procesos de otro proceso en `state.json` y a matar por PID entre procesos. Es frágil en Windows y no resuelve que el hash se calcule antes de la verificación.
- **Un registro durable aparte (`DelegationRecord` en `state.json`), como propuso Codex.** Duplica lo que ya guarda la meta de cada worktree, y `state.json` solo conserva 8 entradas recientes. La meta vive y muere con el worktree, que es justo el ciclo que hay que seguir.

## Current state

- **Architecture**: servidor MCP plano en `server/src/`.
  - `delegate.ts` orquesta la cadena (`fallback.ts`) y los worktrees (`worktree.ts`).
  - `jobs.ts` (`JobRegistry`) sigue las delegaciones en curso y las refleja en `state.json`.
  - Los hooks de Claude Code se ejecutan como proceso aparte (`cli.ts` → `hooks.ts`).
  - Los tests usan CLIs falsos (`server/tests/fixtures/fake-*.mjs`, controlados con `FAKE_*`).
  - Esta feature sigue ese reparto y no crea módulos nuevos, salvo `server/src/reservations.ts`.
- `server/src/worktree.ts`:
  - `WorktreeMeta` (línea 20) no tiene estado ni fechas de actualización; `readMeta` está en la línea 172.
  - `collectChanges` (línea 204) genera `diff`, `files` y `patchFile`.
  - `applyWorktree` (línea 283) vuelve a ejecutar `collectChanges`, prueba `--3way` y, si falla por el índice, reintenta sin él. No hace `--check` antes.
  - `cleanupRepo` (línea 369) usa `fs.stat(b.path).mtimeMs` y `removeWorktree` con `--force`.
- `server/src/delegate.ts`:
  - `KEEP_ON = ["CANCELLED","TIMEOUT","STALLED"]` y `STOP_ON = ["TIMEOUT","STALLED"]` (líneas 101–103).
  - Si un intento de write termina con otro error, `removeWorktree` se ejecuta aunque haya cambios (línea 251 y siguientes).
- `server/src/hooks.ts`:
  - `postDelegate` (línea 166) ejecuta `runVerify` (línea 142) si la respuesta trae `diff` y `worktreePath`.
  - `sessionStart` (línea 261) llama a `cleanupWorktrees(…, 24 h)`.
- `server/src/jobs.ts` — `JobPhase = "running" | "cancelled" | "done" | "lost"` (línea 19); no hay fase de verificación.
- `server/src/sdd/task-delegation.ts:165` — `verifyTask` corre después de `delegate()`, y `run` en `server/src/sdd/verify.ts:65` llama a `runProcess` sin `signal`.
- `server/src/sdd/claim.ts:78` — `claimCommitted` solo compara el Owner en `HEAD` y en el working tree.
- `server/src/index.ts`:
  - `delegation_apply` recibe solo `{ worktreePath }` (línea 125).
  - `delegation_cleanup` recibe `{ olderThanMinutes? }` (línea 204) y borra sin mirar el estado.
- **Overlap scan**: `ls specs/`. Todas las features están `implemented`, salvo `sdd-integration`, que es un scope y no una feature. No hay ramas de feature abiertas con cambios sobre estos archivos que no estén en `main`.

## Quality gates

| Gate | Command | Where | Baseline |
|---|---|---|---|
| Tests | `npm --prefix server test` | `here` | `Test Files 23 passed (23) · Tests 315 passed (315)` |
| Types | `npm --prefix server run typecheck` | `here` | `tsc` (src + tests) exit 0, 0 errores |
| Plugin | `claude plugin validate .` · `claude plugin test .` | `here` | `✔ Validation passed` · conductor card tests pass |
| Dist | `git diff --exit-code --stat -- server/dist` tras `npm --prefix server run build` | `pipeline-only` (job `dist`); localmente, cada tarea que toca `server/src` reconstruye y committea `server/dist` | `—` |
| Tests multiplataforma | matriz ubuntu/macos/windows × Node 20/22 | `pipeline-only` (job `test`) | `—` |
| Lint / Format | — no configurado | — | — |

**Base**: `main` @ `0f0557d`. Rama de feature `feature/delegation-lifecycle`.

**Integration**: merge local a `main` sin PR, como las features anteriores. Los checks `test` (matriz, incluido Windows para los locks y `--check`), `dist` y `plugin` corren en el CI del push.

**Task span**: `— a task is claimed for at most 7 days`

**Measurements**: SC1–SC4 se miden con tests de integración, usando CLIs falsos, repos git temporales y un reloj inyectado para las edades (SC1) y los locks huérfanos (E6).

## Components

### C1 — Estado de ciclo de vida en la meta del worktree

- **Implements**: R1 (el estado), R2, E1, R8 (transiciones)
- **Where**: `server/src/worktree.ts`, `server/src/audit.ts`
- **What**:
  - `WorktreeMeta` agrega:
    - `state?: "running" | "verifying" | "awaiting_review" | "recoverable" | "discardable"`;
    - `updatedAt?: string`;
    - `patchSha256?: string`;
    - `verification?: { result: "pass" | "fail" | "cancelled" | "none"; modifiedFiles?: string[] }`.
  - `setMetaState(path, state, extra?)` escribe la meta con `writeFileAtomic` y `updatedAt`, y registra la transición en la auditoría (`type: "lifecycle"`, id, estado anterior y nuevo, sin contenido).
  - `effectiveState(meta, hasChanges)` resuelve E1: sin `state`, devuelve `awaiting_review` si hay cambios y `discardable` si no.
  - `worktreeAgeMs(meta)` usa `updatedAt ?? createdAt`.
- **Reuses**: `readMeta`, `writeFileAtomic`, `audit.ts`.
- **Duplicates**: — none
- **Depends on**: —

### C2 — Limpieza que respeta el estado

- **Implements**: R1 (la regla de limpieza)
- **Where**: `server/src/worktree.ts` (`cleanupRepo`, `cleanupWorktrees`), `server/src/hooks.ts` (`sessionStart`), `server/src/index.ts` (`delegation_cleanup`)
- **What**:
  - `cleanupWorktrees(dirs, { maxAgeMs, force })`. Sin `force`, solo borra worktrees en `discardable` (o sin meta legible) con una edad (C1) mayor que `maxAgeMs`. Con `force`, borra todo, como hoy.
  - La respuesta separa `removed` y `kept`, con el estado y la edad de cada uno.
  - `delegation_cleanup` agrega `force?: boolean`, y su descripción dice qué conserva.
  - Las ramas `mp/*` huérfanas, sin worktree, se siguen borrando solo con `force` o con `maxAgeMs === 0`, como hoy.
- **Reuses**: `managedWorktrees`, `removeWorktree`.
- **Duplicates**: — none
- **Depends on**: C1

### C3 — Conservar cualquier write fallido con cambios

- **Implements**: R3
- **Where**: `server/src/delegate.ts`
- **What**:
  - En modo write, `keep` pasa a ser `changes.files.length > 0` sin importar el `errorType`.
  - `shouldStop` corta la cadena con cualquier error cuando el worktree tiene cambios. `KEEP_ON` y `STOP_ON` desaparecen.
  - `CANCELLED` sigue terminando en `cancelled`. Los demás errores terminan en `partial`, con `errorType`, `nextSteps` (aplicar, `delegation_discard` + `delegate` a otro proveedor, o descartar) y el estado `recoverable` en la meta.
  - Un intento `ok` con cambios queda en `verifying` (C4).
- **Reuses**: el camino `partial` de `provider-reliability` (C3 de ese plan).
- **Duplicates**: — none
- **Depends on**: C1

### C4 — Verificación dentro del job, cancelable

- **Implements**: R4, E3
- **Where**: `server/src/jobs.ts`, `server/src/delegate.ts`, `server/src/hooks.ts` (`runVerify`, `postDelegate`), `server/src/sdd/verify.ts`, `server/src/sdd/task-delegation.ts`, `hooks/conductor/model.ts`
- **What**:
  - `JobPhase` agrega `verifying`, y `JobRegistry.setPhase(id, phase, detail?)` guarda el comando en curso.
  - `delegate()` recibe un parámetro interno `verify?: (worktreePath, signal) => Promise<VerifyOutcome>`.
    - Para `delegate` es `runVerify` con `config.verify.commands`, que se mueve a `server/src/verify-commands.ts`.
    - Para `sdd_task_delegate` es `verifyTask` con su `Verify` y sus gates.
  - Corre después de `collectChanges`, dentro del job y con el `AbortSignal` del job, que se pasa a `runProcess`.
  - `delegation_cancel` en fase `verifying` mata el comando en curso, salta los siguientes y deja `verification.result: "cancelled"`.
  - `postDelegate` deja de ejecutar comandos: lee `verification` de la respuesta y arma el mismo `additionalContext` de hoy. Si la respuesta no trae `verification` (un servidor anterior), mantiene el comportamiento actual.
  - El hook `PostToolUse` de `delegate` baja su `timeout` de 900 a 30 s.
  - La card muestra `verificando · <comando> · 00:42` con el mismo borde de "en curso".
- **Reuses**: `runProcess` (ya acepta `signal`), `progressLine`.
- **Duplicates**: `runVerify` (`verify.commands`) y `verifyTask` (`Verify` + gates) siguen separados porque sus entradas son distintas. Los dos pasan por `runProcess` con la misma señal.
- **Depends on**: C1, C3

### C5 — Hash del parche verificado y apply sin efectos parciales

- **Implements**: R5, R6, E4, E5, R8 (`PATCH_CHANGED`)
- **Where**: `server/src/worktree.ts` (`collectChanges`, `applyWorktree`), `server/src/delegate.ts`, `server/src/index.ts`, `skills/multi-provider/SKILL.md`, `agents/codex-worker.md`, `agents/agy-worker.md`, `commands/delegate.md`, `commands/sdd-delegate.md`
- **What**:
  - Después de la verificación (C4), `delegate()` vuelve a ejecutar `collectChanges`. Si los archivos difieren del diff del worker, devuelve ese diff final con `violations: [{ type: "verify_modified_files", files }]`. Guarda `patchSha256` (SHA-256 del `patchFile`) en la meta, deja el estado en `awaiting_review` y lo devuelve en la respuesta.
  - `applyWorktree(path, id, { expectedPatchSha256? })`:
    1. recalcula el diff; si se pasó el hash y no coincide, devuelve `PATCH_CHANGED` con el hash actual sin tocar el checkout, y lo registra en la auditoría;
    2. sin hash, aplica y agrega una nota en `notes`;
    3. ejecuta `git apply --check` (estricto, sin `--3way`); si pasa, aplica igual que hoy;
    4. si falla, ejecuta `git apply --3way --check`. Ese comando **sale con 0 aunque haya conflictos** (verificado con git 2.54: imprime `Applied patch to '<f>' with conflicts.`), así que los conflictos se detectan por esas líneas y no por el código de salida;
    5. sin conflictos, aplica con `--3way`;
    6. con conflictos, devuelve `applied: false`, `conflicts: [archivos]` y el `patchFile`, con el checkout intacto.
  - `delegation_apply` agrega `expectedPatchSha256?` y `allowConflicts?`. Con `allowConflicts`, aplica `--3way` como hoy y lista los archivos con marcadores.
  - Si el worktree ya no existe, la respuesta es `NOT_FOUND` (E5).
  - La skill, los dos agentes y los comandos pasan siempre el `patchSha256` que revisaron.
- **Reuses**: `collectChanges`, `git()`.
- **Duplicates**: — none
- **Depends on**: C4

### C6 — Reserva exclusiva por tarea SDD

- **Implements**: R7, E6, R8 (reservas rechazadas)
- **Where**: `server/src/reservations.ts` (nuevo), `server/src/paths.ts`, `server/src/sdd/task-delegation.ts`, `server/src/index.ts`
- **What**:
  - `reserve(key, { id, timeoutMs })` crea `~/.claude/multi-provider/locks/<sha1(key)>.json` con `open(…, "wx")` y guarda `{ key, id, pid, startedAt }`.
  - Si el archivo ya existe:
    - un PID muerto, o una antigüedad mayor que `writeTimeoutMs + verify.timeoutMs` (E6), se toma como lock huérfano: se reemplaza y se agrega una nota;
    - en cualquier otro caso devuelve `TASK_IN_FLIGHT` con el id de la delegación que ya corre.
  - `release(key, id)` solo borra si el id coincide.
  - `sddTaskDelegate` reserva `<repoRoot>/<slug>/<taskId>` antes de `delegate()` y la libera en un `finally`.
- **Reuses**: `isPidAlive` (`jobs.ts`), el patrón de `withLock` (`fsutil.ts`).
- **Duplicates**: `withLock` es un lock corto, con espera activa y `staleMs` de 5 s. Esta reserva es larga y falla en el acto. Comparten el patrón pero no el código, porque sus semánticas de espera son opuestas.
- **Depends on**: —

### C7 — Card, doctor y documentación

- **Implements**: R1 (aviso de 7 días, Q1), soporte de SC1–SC4
- **Where**: `hooks/conductor/model.ts`, `hooks/conductor/card.tsx`, `server/src/doctor.ts`, `README.md`, `docs/delegation-lifecycle.md` (nuevo), `docs/provider-reliability.md`
- **What**:
  - La card cuenta los worktrees `awaiting_review`/`recoverable` y avisa de los que tienen más de 7 días (`⚠ 2 diffs pendientes · 1 de hace 9 días`).
  - `/mp-doctor` lista los worktrees pendientes con su estado y edad.
  - La documentación explica:
    - los estados del ciclo de vida;
    - `force` en `delegation_cleanup`;
    - `expectedPatchSha256` y `allowConflicts`;
    - `TASK_IN_FLIGHT`;
    - que `verify.commands` ya no corre en el hook.
- **Reuses**: `managedWorktrees`, `readMeta`.
- **Duplicates**: — none
- **Depends on**: C1–C6

## Build order

1. C1: la meta con estado, base de todo lo demás.
2. C2 y C6, en paralelo: limpieza y reservas, independientes entre sí.
3. C3: conservación de los write fallidos.
4. C4: verificación en el job.
5. C5: hash y apply.
6. C7: card, doctor y documentación.

## Evidence per requirement

- **R1**:
  - test: con worktrees en cada estado y la meta de hace 3 días, `cleanupWorktrees` sin `force` solo borra los `discardable`;
  - test: con `force` borra todos;
  - test: `sessionStart` conserva un worktree `awaiting_review` (SC1).
- **R2** — test: un worktree con el `mtime` del directorio antiguo y `updatedAt` reciente no se borra.
- **R3** — test con `fake-codex` que escribe un archivo y sale con código 1: respuesta `partial`, un solo worktree, estado `recoverable` y un único intento en `attempts` (SC3).
- **R4**:
  - test: con `verify.commands: ["node sleep.mjs 30"]`, `delegation_status` muestra `verifying`;
  - test: `delegation_cancel` termina en ≤ 5 s con `verification.result: "cancelled"` (SC4).
- **R5**:
  - test: con un `verify.commands` que modifica un archivo, la respuesta trae `verify_modified_files`;
  - test: `delegation_apply` con el hash anterior devuelve `PATCH_CHANGED` y `git status` del checkout no cambia (SC2).
- **R6**:
  - test: con un conflicto preparado en el checkout, `delegation_apply` devuelve `conflicts` y el checkout no tiene marcadores;
  - test: con `allowConflicts`, los lista.
- **R7** — test: dos `sddTaskDelegate` simultáneos con `fake-codex` lento; uno corre y el otro devuelve `TASK_IN_FLIGHT` (SC4).
- **R8** — test: el log de auditoría tiene las transiciones, el `PATCH_CHANGED` y el `TASK_IN_FLIGHT`, sin contenido de prompt ni diff.
- **E1** — test: un worktree con meta sin `state` se trata como `awaiting_review` si tiene cambios y como `discardable` si no.
- **E2** — test: un job `running` cuyo PID ya no existe pasa a `lost`, y su worktree queda `recoverable`.
- **E3** — test: un `Verify` con sintaxis de shell queda `manual`, y el resultado, `awaiting_review`.
- **E4** — test: si `git apply --check` falla por un motivo que no es un conflicto, la herramienta devuelve el error y el checkout no cambia.
- **E5** — test: `delegation_apply` sobre un worktree ya descartado devuelve `NOT_FOUND`.
- **E6** — test con reloj inyectado: un lock con el PID vivo y más antiguo que el límite se reemplaza, con una nota.

## Data changes, delivery & dependencies

- **Data**:
  - la meta del worktree gana campos opcionales; las metas anteriores se leen por E1, sin migración;
  - aparece el directorio `~/.claude/multi-provider/locks/`;
  - `state.json` no cambia de forma.
- **Delivery**:
  - `delegation_apply` y `delegation_cleanup` ganan parámetros opcionales;
  - el campo nuevo `patchSha256` y la violación `verify_modified_files` son aditivos;
  - el hook `post-delegate` sigue siendo compatible con respuestas sin `verification`;
  - versión 0.5.0.
- **Dependencies**: ninguna nueva.

## Risks

| Risk | Mitigation |
|---|---|
| Mover `verify.commands` al servidor alarga la llamada a `delegate` | Ya hoy el usuario espera al hook `PostToolUse` (hasta 900 s). Ahora la espera es visible en `delegation_status` y en la card, y se puede cancelar |
| Conservar los diffs pendientes indefinidamente (Q1) llena el disco | Aviso en la card a partir de los 7 días, `/mp-doctor` los lista, y `delegation_cleanup { force: true }` los borra |
| Cortar la cadena en cualquier error con cambios (Q2) quita el fallback automático cuando un proveedor falla a mitad | La respuesta `partial` trae el comando para pedir otro proveedor. Sin cambios en el worktree, el fallback sigue igual |
| Los locks con `O_EXCL` y la detección de PIDs se comportan distinto en Windows | `open("wx")` es atómico en NTFS. `isPidAlive` ya se usa para los jobs `lost` en las tres plataformas, y la matriz de CI cubre Windows |
| `git apply --3way --check` informa los conflictos solo por texto (sale con 0) y ese texto puede cambiar entre versiones o con otro idioma | Se ejecuta con `LC_ALL=C`, primero se prueba el `--check` estricto (código de salida fiable), y un test fija el formato con el git del CI; si la salida no se puede interpretar, se trata como conflicto (E4) |

## Requirement coverage

| Requirement | Covered by |
|---|---|
| R1 | C1, C2, C7 |
| R2 | C1 |
| R3 | C3 |
| R4 | C4 |
| R5 | C5 |
| R6 | C5 |
| R7 | C6 |
| R8 | C1, C5, C6 |
| E1 | C1 |
| E2 | C1, C4 |
| E3 | C4 |
| E4 | C5 |
| E5 | C5 |
| E6 | C6 |
