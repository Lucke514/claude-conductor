<!-- Status enum: draft | in-review | approved | abandoned -->

# Tasks: Ciclo de vida seguro de las delegaciones

> Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md)
> Status: approved
> Last updated: 2026-10-18

Una tarea = una sesión. Hecha significa:
- su **Verify** pasa;
- los gates del plan pasan sin fallos nuevos contra su baseline (`npm --prefix server run typecheck`, `npm --prefix server test`, `claude plugin validate .`, `claude plugin test .`);
- `server/dist` está reconstruido y committeado si la tarea toca `server/src`;
- el diff está limpio.

Commits con prefijo `delegation-lifecycle: `, solo de Claude y sin trailers de atribución.

Orden: T1 → (T2 ∥ T3) → T4 → T5 → T6 → T7. T2 y T3 no comparten archivos y pueden ir en paralelo; el resto toca `server/src/delegate.ts` o depende del estado de T1, así que va en serie. El mínimo publicable (R1, R2, R3, R5, E1) queda con T1, T2, T4 y T6. La versión 0.5.0 se sube al integrar, cuando pasan SC1–SC4.

## T1 — Estado de ciclo de vida en la meta del worktree

- [x] Done
- **Owner**: —
- **Component**: C1 · **Implements**: R2, E1, R8
- **Files**: `server/src/worktree.ts`, `server/src/audit.ts`, `server/tests/delegate.spec.ts`, `server/tests/helpers.ts`
- **Do**:
  - `WorktreeMeta` agrega los campos opcionales `state` (`"running" | "verifying" | "awaiting_review" | "recoverable" | "discardable"`), `updatedAt`, `patchSha256` y `verification` (`{ result: "pass" | "fail" | "cancelled" | "none"; modifiedFiles?: string[] }`). Se exporta el tipo `LifecycleState`.
  - `createWorktree` escribe `state: "running"` y `updatedAt`.
  - `setMetaState(worktreePath, state, extra?)` lee la meta, aplica `state`, `updatedAt` (ISO, del reloj inyectable si existe en los helpers) y `extra`, y la escribe con `writeFileAtomic`. Registra en la auditoría `{ type: "lifecycle", id, from, to }`, sin contenido.
  - `effectiveState(meta, hasChanges)`: si `meta.state` existe, lo devuelve; si no, `awaiting_review` con cambios y `discardable` sin ellos (E1).
  - `worktreeAgeMs(meta, now)` usa `updatedAt ?? createdAt`.
  - Ningún llamador cambia de comportamiento en esta tarea: solo se agregan el estado y las funciones.
- **Acceptance**:
  - un worktree recién creado tiene `state: "running"` y `updatedAt`;
  - `setMetaState` cambia el estado, actualiza `updatedAt` y deja una línea `lifecycle` en el log de auditoría del día, sin prompt ni diff;
  - `effectiveState` con una meta sin `state` devuelve `awaiting_review` si el worktree tiene cambios y `discardable` si no;
  - `worktreeAgeMs` ignora el `mtime` del directorio;
  - los tests existentes siguen pasando sin cambiarlos.
- **Verify**: `npm --prefix server test -- delegate`
- **Notes**: Delegada a codex (delegación `20261019000322-8428b1`), revisada y aplicada por Claude. `WorktreeMeta` gana `id`, `state`, `updatedAt`, `patchSha256` y `verification`; `createWorktree` escribe `state: "running"` con `writeFileAtomic`; `setMetaState` audita `{ type: "lifecycle", id, from, to }` sin contenido y exige un id (de `extra.id` o de la meta); `effectiveState` (E1) y `worktreeAgeMs` (`updatedAt ?? createdAt`). Sin reloj inyectable en los helpers: usa `new Date()`. 3 tests nuevos en `delegate.spec.ts` (uno fija el `mtime` del directorio en 1970). Gates: typecheck 0 errores, 318 passed (315 + 3), plugin validate ok, plugin test 12 pass. Clean-code: orden de imports y línea en blanco doble en el test, corregidos por Claude · close calls: `delegate()` todavía no pasa `id` a `createWorktree`; T4 debe hacerlo antes de llamar a `setMetaState`

## T2 — Limpieza que respeta el estado

- [x] Done
- **Owner**: —
- **Component**: C2 · **Implements**: R1
- **Files**: `server/src/worktree.ts`, `server/src/hooks.ts`, `server/src/index.ts`, `server/tests/delegate.spec.ts`, `server/tests/hooks-setup.spec.ts`
- **Do**:
  - `cleanupWorktrees(dirs, opts?: { maxAgeMs?: number; force?: boolean; now?: number })` devuelve `{ removed: string[]; kept: { path, state, ageMs }[] }`.
    - Sin `force`, `cleanupRepo` solo borra los worktrees cuyo `effectiveState` es `discardable`, o cuya meta no se puede leer, y cuya `worktreeAgeMs` supera `maxAgeMs`. El resto va a `kept`.
    - Con `force`, borra todo, como hoy.
    - Las ramas `mp/*` huérfanas se siguen borrando solo con `force` o `maxAgeMs === 0`.
  - `sessionStart` llama a `cleanupWorktrees(…, { maxAgeMs: 24 h })`.
  - `delegation_cleanup` agrega `force?: boolean` al `inputSchema`, pasa `olderThanMinutes` como `maxAgeMs` y responde con `removed` y `kept`. Su descripción explica qué conserva sin `force`.
  - Se actualizan todos los llamadores de `cleanupWorktrees`, incluidos `doctor.ts` y los tests.
- **Acceptance**:
  - SC1: un worktree `awaiting_review` con `updatedAt` de hace 3 días sigue existiendo tras `sessionStart`;
  - uno `discardable` de hace 3 días se borra;
  - uno con el `mtime` del directorio antiguo y `updatedAt` reciente se conserva (R2);
  - `running`, `verifying` y `recoverable` nunca se borran sin `force`;
  - `delegation_cleanup { force: true }` borra todos y lo dice en la respuesta;
  - un worktree sin meta legible y antiguo se borra.
- **Verify**: `npm --prefix server test -- delegate hooks-setup`
- **Notes**: Delegada a codex (delegación `20261019001812-ffac1a`), revisada y aplicada por Claude. `cleanupWorktrees(dirs, { maxAgeMs = 24 h, force })` devuelve `{ removed, kept }` con `path`, `branch`, `state` y `ageMs`; sin `force` solo borra `discardable` o sin meta legible más antiguos que `maxAgeMs`; una meta antigua sin `state` usa `effectiveState` y, si no puede mirar los cambios, la conserva; una meta corrupta usa el `mtime` del archivo de meta, y una ausente el del directorio. `delegation_cleanup` gana `force` y, sin `olderThanMinutes`, usa 24 h (antes 0 = todo). Las ramas `mp/*` huérfanas solo se borran con `force` o `maxAgeMs: 0`. Tests: 2 en `delegate.spec.ts` y el caso SC1 en `hooks-setup.spec.ts`; dos tests existentes pasan a `force: true`. Gates: typecheck 0 errores, 320 passed, plugin validate ok, plugin test 12 pass. Clean-code: `unlinkSync` importado dinámicamente en el test, movido al import por Claude · close calls: el atajo `3` de la card y la skill siguen diciendo "huérfanos" y "stale ones after 24 h" — T7 los actualiza

## T3 — Reserva exclusiva por tarea SDD

- [x] Done
- **Owner**: —
- **Component**: C6 · **Implements**: R7, E6, R8
- **Files**: `server/src/reservations.ts`, `server/src/paths.ts`, `server/src/sdd/task-delegation.ts`, `server/src/sdd/artifacts.ts`, `server/tests/reservations.spec.ts`, `server/tests/sdd-task-delegation.spec.ts`
- **Do**:
  - `paths.ts` agrega `locksDir()` = `~/.claude/multi-provider/locks/` (respetando el mismo override de home que usan los tests).
  - `reservations.ts`:
    - `reserve(key, { id, maxAgeMs, now? })` crea `<locksDir>/<sha1(key)>.json` con `fs.open(…, "wx")` y escribe `{ key, id, pid, startedAt }`.
    - Si el archivo existe y su PID está muerto (`isPidAlive`), o su antigüedad supera `maxAgeMs`, lo reemplaza y devuelve `{ ok: true, note }` (E6).
    - En cualquier otro caso devuelve `{ ok: false, heldBy: id }`.
    - `release(key, id)` borra el archivo solo si su `id` coincide.
  - `sddTaskDelegate` reserva `<repoRoot>/<slug>/<taskId>` con `maxAgeMs = writeTimeoutMs + verify.timeoutMs` justo después de `claimCommitted`, y la libera en un `finally`.
    - Si no obtiene la reserva, lanza `SddError("TASK_IN_FLIGHT", …)` con el id que la tiene, sin arrancar ningún worker.
    - La nota de un lock huérfano reemplazado va a `notes`.
  - `TASK_IN_FLIGHT` se agrega a los códigos de `SddError` y queda en la auditoría.
- **Acceptance**:
  - SC4 (parte R7): dos `sddTaskDelegate` simultáneos de la misma tarea con `fake-codex` lento → uno corre y el otro falla con `TASK_IN_FLIGHT`, y el adapter falso registra una sola llamada;
  - al terminar (éxito, error o cancelación), el archivo de lock ya no existe;
  - un lock con un PID inexistente se reemplaza con una nota;
  - un lock con el PID vivo pero más antiguo que `maxAgeMs` (reloj inyectado) se reemplaza con una nota;
  - `release` con otro id no borra el lock.
- **Verify**: `npm --prefix server test -- reservations sdd-task-delegation`
- **Notes**: Delegada a antigravity (delegación `20261019002037-31b643`, 24 min), revisada, corregida y aplicada por Claude. `locksDir()` en `paths.ts`; `reservations.ts` con `reserve` (`open(…, "wx")`, registro `{ key, id, pid, startedAt }`), `release` (solo con el mismo id) y `lockFilePath`; `SddError` gana `TASK_IN_FLIGHT` y `heldBy`; `sddTaskDelegate` reserva `<repoRoot>/<slug>/<taskId>` con `maxAgeMs = (timeoutMs ?? writeTimeoutMs) + verify.timeoutMs` tras `claimCommitted` y libera en un `finally`. Correcciones de Claude: (1) la toma de un lock huérfano sobrescribía el archivo con `writeFileAtomic`, y dos llamadas que veían el mismo huérfano ganaban las dos; ahora lo borra bajo `withLock` solo si el archivo sigue siendo ese huérfano y vuelve a competir por `wx` (test nuevo con dos `reserve` simultáneos); (2) la auditoría de `TASK_IN_FLIGHT` usaba `as never`: tipo `ReservationAuditEntry` en `audit.ts` (fuera de los `Files`); (3) quitada la opción `timeoutMs` sin uso y una línea en blanco doble. El worker también reconstruyó `server/dist` (drift fuera de los `Files`, de ahí `verified: false`); Claude lo regeneró. Gates: typecheck 0 errores, 344 passed, plugin validate ok, plugin test 12 pass. Clean-code: las tres correcciones de arriba · close calls: la clave usa la raíz del repo del proyecto y no la del `**Repo**` de la tarea; basta porque `<slug>/<taskId>` ya es único por proyecto

## T4 — Conservar cualquier write fallido con cambios

- [x] Done
- **Owner**: —
- **Component**: C3 · **Implements**: R3
- **Files**: `server/src/delegate.ts`, `server/tests/delegate.spec.ts`, `server/tests/fixtures/fake-codex.mjs`
- **Do**:
  - `delegate()` pasa su `id` a `createWorktree` (T1 lo dejó opcional), para que `setMetaState` pueda auditar cada transición.
  - En modo write, un intento con cambios en el worktree se conserva siempre (`keep = changes.files.length > 0`), sea cual sea el `errorType`. `KEEP_ON` y `STOP_ON` desaparecen.
  - `shouldStop` corta la cadena con cualquier error cuando el worktree tiene cambios: no hay reintento ni siguiente proveedor.
  - `CANCELLED` sigue terminando en `cancelled`. Cualquier otro error con cambios termina en `partial`, con `errorType` en la respuesta, `setMetaState(…, "recoverable")` y `nextSteps` con tres opciones:
    - aplicar con `delegation_apply`;
    - pedir otro proveedor: `delegation_discard` + `delegate` con `provider` explícito;
    - descartar.
  - Un intento `ok` con cambios pasa a `setMetaState(…, "awaiting_review")` (T5 lo cambia a `verifying` antes de verificar).
  - Sin cambios, el fallback y `retryOn` siguen como hoy.
  - `fake-codex.mjs` agrega `FAKE_MODE=write-then-fail`: escribe un archivo y sale con código 1.
- **Acceptance**:
  - SC3: con `FAKE_MODE=write-then-fail` y la cadena `codex → antigravity → claude`, la respuesta es `partial` con `errorType: "NON_ZERO_EXIT"` y el diff, `attempts` tiene un solo intento, `git worktree list` muestra un solo worktree `mp/*` y su meta dice `recoverable`;
  - un `NON_ZERO_EXIT` sin cambios sigue pasando al siguiente proveedor;
  - los casos existentes de `TIMEOUT`, `STALLED` y `CANCELLED` siguen pasando.
- **Verify**: `npm --prefix server test -- delegate fallback`
- **Notes**: Delegada a codex (delegación `20261019002418-883ccf`), revisada, corregida y aplicada por Claude. `delegate()` pasa su `id` a `createWorktree`; `KEEP_ON`/`STOP_ON` desaparecen: en write, un intento con cambios se conserva siempre y `shouldStop` corta la cadena ante cualquier error con cambios; un error deja la meta `recoverable` y un éxito `verifying` (T5 la pasa a `awaiting_review`); la respuesta gana `errorType` y los `nextSteps` de `partial` nombran aplicar, otro proveedor (`delegation_discard` + `delegate`) o descartar. `fake-codex.mjs` gana `FAKE_MODE=crash-write` (en lugar de `write-then-fail`; sale con 3). Tests: un `it.each(ERROR_TYPES)` y SC3 con el CLI falso. El gate Tests falló en el worktree (`guardrails.spec.ts`: el test tomaba la primera línea de auditoría con el id de la delegación, que ahora es la `lifecycle`); Claude lo corrigió filtrando `type !== "lifecycle"` — fuera de los `Files` de la tarea. Gates tras el arreglo: typecheck 0 errores, 333 passed, plugin validate ok, plugin test 12 pass. Clean-code: línea en blanco doble en el test, corregida · close calls: la caída deliberada `crash-write` → `crash` del switch del fixture no tiene `eslint` que la marque (no hay lint configurado)

## T5 — Verificación dentro del job, cancelable

- [ ] Done
- **Owner**: codex (multi-provider) since 2026-10-19
- **Component**: C4 · **Implements**: R4, E3, E2
- **Files**: `server/src/jobs.ts`, `server/src/delegate.ts`, `server/src/verify-commands.ts`, `server/src/hooks.ts`, `server/src/sdd/verify.ts`, `server/src/sdd/task-delegation.ts`, `server/src/index.ts`, `hooks/hooks.json`, `hooks/conductor/model.ts`, `hooks/conductor/card.tsx`, `types/index.d.ts`, `server/tests/jobs.spec.ts`, `server/tests/delegate.spec.ts`, `server/tests/hooks-setup.spec.ts`, `server/tests/sdd-task-delegation.spec.ts`, `server/tests/card-model.spec.ts`, `server/tests/fixtures/sleep.mjs`, `server/tests/sdd-verify.spec.ts`
- **Do**:
  - `JobPhase` agrega `verifying`. `JobRegistry.setPhase(id, phase, detail?)` guarda el comando en curso (recortado con `progressLine`) y lo refleja en `state.json`.
  - `runVerify` se mueve de `hooks.ts` a `server/src/verify-commands.ts` y acepta un `signal`, que pasa a `runProcess`. Con el signal abortado, no ejecuta los comandos siguientes.
  - `verifyTask` y `run` (`sdd/verify.ts`) aceptan `signal` y lo pasan a `runProcess`; un ítem abortado queda `cancelled`.
  - `DelegateParams` agrega el parámetro interno `verify?: (worktreePath, signal) => Promise<VerifyOutcome>`, que no se expone en el `inputSchema`.
    - Si el intento final es `ok` y tiene cambios, `delegate()` pasa el job a `verifying`, marca la meta `verifying`, ejecuta `verify` con el `AbortSignal` del job y después deja la meta en `awaiting_review` con `verification`.
    - Para la herramienta `delegate`, `index.ts` pasa `runVerify` con `config.verify.commands`; con la lista vacía, `verification.result` es `none`.
    - `sddTaskDelegate` pasa `verifyTask` con el `Verify` y los gates de la tarea, y deja de ejecutarlo después de `delegate()`.
  - `delegation_cancel` en fase `verifying` aborta el signal: la respuesta trae `verification.result: "cancelled"` y el estado es `awaiting_review`.
  - `postDelegate` ya no ejecuta comandos. Si la respuesta trae `verification`, arma el mismo `additionalContext` que hoy desde ella; si no la trae (un servidor anterior), mantiene el comportamiento actual.
  - En `hooks/hooks.json`, el `timeout` del `PostToolUse` de `delegate` baja de 900 a 30.
  - E2: al arrancar, un job `running` o `verifying` marcado como `lost` deja su worktree en `recoverable`.
  - La card muestra `verificando · <comando> · mm:ss` con el borde de "en curso"; `types/index.d.ts` agrega la fase.
- **Acceptance**:
  - SC4 (parte R4): con `verify.commands: ["node <fixture>/sleep.mjs 30"]`, `delegation_status` muestra `phase: "verifying"` con el comando, y `delegation_cancel` hace que `delegate` responda en ≤ 5 s con `verification.result: "cancelled"`, sin procesos `sleep.mjs` vivos;
  - `sdd_task_delegate` devuelve la misma verificación que hoy, ahora ejecutada en el job;
  - un `Verify` con sintaxis de shell queda `manual`, y el resultado, `awaiting_review` (E3);
  - `postDelegate` con una respuesta con `verification` no ejecuta nada y produce el mismo texto que hoy; sin `verification`, ejecuta como antes;
  - un job `lost` deja su worktree `recoverable` (E2);
  - el modelo de la card muestra la fase `verifying`.
- **Verify**: `npm --prefix server test -- jobs delegate hooks-setup sdd-task-delegation card-model`
- **Notes**: —

## T6 — Hash del parche verificado y apply sin efectos parciales

- [ ] Done
- **Owner**: —
- **Component**: C5 · **Implements**: R5, R6, E4, E5, R8
- **Files**: `server/src/worktree.ts`, `server/src/delegate.ts`, `server/src/index.ts`, `server/tests/delegate.spec.ts`, `server/tests/worktree-apply.spec.ts`, `skills/multi-provider/SKILL.md`, `agents/codex-worker.md`, `agents/agy-worker.md`, `commands/delegate.md`, `commands/sdd-delegate.md`
- **Do**:
  - Después de la verificación (T5), `delegate()` vuelve a ejecutar `collectChanges`. Si la lista de archivos o el contenido del diff cambió respecto del diff del worker, agrega `violations: [{ type: "verify_modified_files", detail, files }]` y devuelve el diff final.
  - Calcula `patchSha256` (SHA-256 del `patchFile` final), lo guarda en la meta (`awaiting_review`) y lo devuelve en la respuesta.
  - `applyWorktree(path, id, opts?: { expectedPatchSha256?: string; allowConflicts?: boolean })`:
    1. Si el worktree o su meta ya no existen, devuelve `NOT_FOUND` (E5).
    2. Recalcula el diff. Si `expectedPatchSha256` no coincide, devuelve `{ applied: false, code: "PATCH_CHANGED", patchSha256: <actual> }` sin tocar el checkout y lo registra en la auditoría. Sin hash, sigue y agrega una nota.
    3. Ejecuta `git apply --check` (estricto, con `LC_ALL=C`). Si pasa, aplica igual que hoy.
    4. Si falla, ejecuta `git apply --3way --check`. Ese comando **sale con 0 aunque haya conflictos**, así que los conflictos se detectan por las líneas `Applied patch to '<f>' with conflicts.` y `error:`, no por el código de salida. Una salida que no se puede interpretar cuenta como conflicto (E4).
    5. Sin conflictos, aplica con `--3way`. Con conflictos y sin `allowConflicts`, devuelve `applied: false`, `conflicts` y `patchFile`, con el checkout intacto. Con `allowConflicts`, aplica con `--3way` y devuelve los archivos que quedaron con marcadores.
  - `delegation_apply` agrega `expectedPatchSha256?` y `allowConflicts?` al `inputSchema` y a su descripción.
  - La skill, los dos agentes y los comandos `delegate`/`sdd-delegate` indican que se pase siempre el `patchSha256` revisado y qué hacer con `PATCH_CHANGED` y `conflicts`.
- **Acceptance**:
  - SC2: con un `verify.commands` que reescribe un archivo del worktree, la respuesta trae `verify_modified_files`, y `delegation_apply` con el hash del diff del worker devuelve `PATCH_CHANGED` sin cambiar el `git status` del checkout;
  - con el hash final aplica;
  - con un conflicto preparado en el checkout (la misma línea cambiada), `delegation_apply` devuelve `conflicts`, el checkout no tiene marcadores `<<<<<<<` y el `git status` no cambia;
  - con `allowConflicts`, lista los archivos con marcadores;
  - si `git apply --check` falla por un parche corrupto, devuelve el error y no toca nada (E4);
  - sobre un worktree descartado devuelve `NOT_FOUND` (E5);
  - el log de auditoría tiene el `PATCH_CHANGED` sin contenido.
- **Verify**: `npm --prefix server test -- worktree-apply delegate`
- **Notes**: —

## T7 — Card, doctor y documentación

- [ ] Done
- **Owner**: —
- **Component**: C7 · **Implements**: R1 (aviso de 7 días)
- **Files**: `hooks/conductor/model.ts`, `hooks/conductor/card.tsx`, `types/index.d.ts`, `server/src/state.ts`, `server/src/doctor.ts`, `server/tests/card-model.spec.ts`, `server/tests/doctor.spec.ts`, `tests/conductor-card.test.tsx`, `README.md`, `docs/delegation-lifecycle.md`, `docs/provider-reliability.md`
- **Do**:
  - `state.ts` guarda en `state.json` un resumen `pending: { count, oldestDays }` de los worktrees `awaiting_review` y `recoverable`, actualizado al cambiar de estado y en `SessionStart`.
  - La card muestra `⚠ N diffs pendientes` y, si alguno tiene más de 7 días, `· 1 de hace 9 días`, con el atajo de `delegation_cleanup`.
  - `/mp-doctor` agrega la línea `pending worktrees`: estado, edad y repo de cada uno, y el `fix:` para aplicarlos o descartarlos.
  - `docs/delegation-lifecycle.md` explica:
    - los cinco estados y sus transiciones;
    - qué borra la limpieza;
    - `force`;
    - `patchSha256`, `PATCH_CHANGED` y `allowConflicts`;
    - `TASK_IN_FLIGHT`;
    - que `verify.commands` ya no corre en el hook.
  - El README agrega una sección corta y una fila en Troubleshooting, y `docs/provider-reliability.md` actualiza la política de `partial`.
- **Acceptance**:
  - el modelo de la card muestra el aviso con 2 pendientes, uno de 9 días;
  - `/mp-doctor --no-live --json` lista los worktrees pendientes;
  - `claude plugin test .` pasa;
  - la documentación nombra cada `R#` de la spec.
- **Verify**: `npm --prefix server test -- card-model doctor`
- **Notes**: —

## Gaps found in verification

- Ninguno todavía.

## Verification reports
