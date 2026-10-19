<!-- Status enum: draft | in-review | approved | implemented | superseded | abandoned -->

# Spec: Ciclo de vida seguro de las delegaciones

> Status: implemented
> Owner: Lucas Gonzalez Espinosa (@Lucke514)
> Sign-off: — the session's user holds all of these
> Tracking: — this project tracks work in the repo only
> Last updated: 2026-10-18

## Objective

Que el trabajo de un worker no se pierda ni cambie entre el momento en que Claude y el usuario lo revisan y el momento en que se aplica: ningún diff pendiente se borra solo, lo que se aplica es exactamente lo revisado, y cada fase de una delegación (worker, verificación, revisión) se puede ver y cancelar.

En la sesión del 2026-10-18 se pidió a Codex, en modo read, una revisión cruzada del roadmap del plugin. Además de criticarlo, encontró estos fallos, y Claude los confirmó en el código:
- **Limpieza destructiva**: `session-start` llama a `cleanupWorktrees(…, 24 h)` (`server/src/hooks.ts:261`). `cleanupRepo` (`server/src/worktree.ts:369`) mide la edad con el `mtime` del directorio raíz del worktree, que no cambia al editar archivos en subcarpetas, y borra con `worktree remove --force` sin mirar si hay un diff que el usuario aún no aplicó.
- **Parche revisado ≠ parche aplicado**: `applyWorktree` (`server/src/worktree.ts:283`) vuelve a ejecutar `collectChanges` al aplicar. Si `verify.commands`, el `Verify` de la tarea o un gate modificaron archivos del worktree (por ejemplo `lint --fix`), se aplica algo distinto del diff mostrado. Si `git apply --3way` falla con conflictos, el checkout puede quedar con marcadores aunque la respuesta diga `applied: false`.
- **Cambios perdidos ante un error**: `KEEP_ON` es `["CANCELLED", "TIMEOUT", "STALLED"]` (`server/src/delegate.ts:101`). Un worker que termina con `NON_ZERO_EXIT` (o `PARSE_ERROR`) después de cambiar archivos pierde su worktree, y la cadena lanza otro proveedor desde cero.
- **Verificación fuera del job**: `sddTaskDelegate` ejecuta `verifyTask` después de que `delegate` cerró su job (`server/src/sdd/task-delegation.ts:165`), y `run` en `server/src/sdd/verify.ts:65` no recibe ninguna señal. Durante los tests, `delegation_status` no muestra nada, la card aparece inactiva y `delegation_cancel` no los detiene.
- **Claims duplicados**: `claimCommitted` (`server/src/sdd/claim.ts:78`) solo compara el `**Owner**`, así que dos `sdd_task_delegate` simultáneos de la misma tarea arrancan dos workers.

## Users & scenarios

- **Diff pendiente de un día para otro**: como desarrollador, si dejo un diff de un worker sin aplicar y vuelvo al día siguiente, quiero encontrarlo intacto, no que `SessionStart` lo haya borrado.
- **Aplicar lo que vi**: como desarrollador, cuando apruebo un diff, quiero que se aplique byte a byte ese diff y no uno recalculado después de la verificación.
- **Worker que falla a mitad**: como desarrollador, si un worker hizo la mitad del trabajo y salió con error, quiero recibir lo que hizo como resultado recuperable antes de que se pruebe otro proveedor.
- **Tests largos**: como desarrollador, mientras corre el `Verify` de una tarea, quiero verlo en `delegation_status` y en la card, y poder cancelarlo.
- **Dos sesiones, una tarea**: como desarrollador con dos sesiones abiertas, no quiero que la misma tarea se delegue dos veces.
- **Surfaces**: `server/src/worktree.ts` (meta, limpieza y apply) · `server/src/delegate.ts` (política de conservación y fallback) · `server/src/jobs.ts` (fases) · `server/src/sdd/{task-delegation,verify,claim}.ts` · herramientas MCP `delegate`, `delegation_apply`, `delegation_discard`, `delegation_cleanup`, `delegation_status`, `delegation_cancel`, `sdd_task_delegate` · hooks `session-start` y `post-delegate` · conductor card.
- **Operational criteria** — una `R#`/`E#`/`SC#` o `non-goal` por ítem:
  - Load & volume: R7 (concurrencia entre sesiones) · Text & locale: non-goal · Operational signal: SC1–SC4 · Degradation: E2, E4 · Partial failure: R3, E3
  - Accessibility: non-goal (solo textos nuevos en la card)
- **Sensitive ground**: R1 y R5 deciden qué se borra y qué se aplica en el checkout del usuario.
  - Access control: non-goal (sin cambios de permisos) · Traceability: R8 · Data handling: non-goal · Data lifecycle: R1, R2 · Repeat-request correctness: R5, R6, R7

## Requirements

- **R1** — Cada worktree `mp/*` registra en su meta un estado de ciclo de vida: `running`, `verifying`, `awaiting_review`, `recoverable` o `discardable`. La limpieza automática (`session-start`) solo borra worktrees `discardable` o sin meta legible, con más de 24 h desde la última escritura de la meta. Nunca borra un worktree `running`, `verifying`, `awaiting_review` ni `recoverable`, por antigua que sea. `delegation_cleanup` sin argumentos sigue la misma regla; con `{ force: true }` borra todo, como hoy, y lo dice en la respuesta.
- **R2** — La edad de un worktree se mide con el `updatedAt` de su meta (escrito en cada cambio de estado), no con el `mtime` del directorio.
- **R3** — En modo write, un intento que termina con cualquier error (no solo `CANCELLED`, `TIMEOUT` o `STALLED`) y deja cambios en el worktree conserva ese worktree como `recoverable`. La cadena no lanza otro proveedor sobre la misma tarea: la respuesta es `status: "partial"` con el diff, el `errorType` del intento y los pasos para aplicar, pedir otro proveedor (`delegation_discard` + un `delegate` nuevo) o descartar. Sin cambios en el worktree, el fallback sigue como hoy.
- **R4** — Después del worker, el job sigue vivo en una fase `verifying` mientras corren `verify.commands` (hook `post-delegate`) o el `Verify` y los gates de la tarea (`sdd_task_delegate`). `delegation_status` muestra la fase, el comando en curso y el tiempo. `delegation_cancel` mata el proceso de verificación en curso, no ejecuta los siguientes y deja el resultado como `awaiting_review` con la verificación marcada `cancelled`.
- **R5** — Al terminar la verificación, el servidor recalcula el diff final del worktree, guarda su SHA-256 (`patchSha256`) en la meta y lo devuelve en la respuesta, junto con el aviso `verify_modified_files` si la verificación cambió archivos respecto del diff del worker. `delegation_apply` acepta `{ worktreePath, expectedPatchSha256? }`: si se pasa y el diff actual no coincide, no aplica nada y devuelve `PATCH_CHANGED` con el hash actual. La skill y los agentes `codex-worker`/`agy-worker` pasan siempre el hash que revisaron.
- **R6** — `delegation_apply` no deja el checkout del usuario a medio aplicar: primero comprueba el parche con `git apply --check` (y `--3way --check`). Si no aplica limpio, no toca el checkout y devuelve los archivos en conflicto con el `patchFile` para resolverlo a mano. Si el usuario pide aplicar con conflictos, la respuesta lista los archivos que quedaron con marcadores.
- **R7** — `sdd_task_delegate` toma una reserva exclusiva por `<repo>/<slug>/<task>`: un archivo de lock en `~/.claude/multi-provider/locks/` creado con `O_EXCL`, con el id de la delegación, el PID del servidor y la fecha. Una segunda llamada para la misma tarea falla con `TASK_IN_FLIGHT` y el id de la que ya corre. La reserva se libera al terminar, al cancelar o, si el PID ya no existe, al detectarla como huérfana.
- **R8** — Cada transición de estado (R1), cada `PATCH_CHANGED` (R5) y cada reserva rechazada (R7) quedan en el log de auditoría con el id de la delegación, sin contenido.

**Minimum shippable**: R1, R2, R3, R5, E1.

## Non-goals

- Respuestas resumidas de `delegate` y la herramienta `delegation_diff`: van en un spec propio (reducción de tokens). Este spec solo agrega `patchSha256`.
- Compact automático y checkpoints para la compactación: dependen de este spec, pero van aparte.
- Despacho en paralelo de grupos `[P]` (`sdd-parallel-dispatch`): R7 es su prerequisito, no su implementación.
- Reintentar automáticamente desde un resultado `recoverable`: decidirlo queda en manos de Claude y del usuario.
- Retención con límite de espacio en disco: los worktrees pendientes se quedan hasta que se apliquen o descarten.

## Edge cases & error behavior

- **E1** — Los worktrees creados por versiones anteriores no tienen estado en la meta. La limpieza los trata como `awaiting_review` si tienen cambios respecto de su base, y como `discardable` si no los tienen.
- **E2** — Si el servidor MCP se reinicia durante `running` o `verifying`, el worktree pasa a `recoverable` al arrancar (no se borra), y `delegation_status` lo informa como `lost` con su ruta.
- **E3** — Si la verificación no puede arrancar (comando inexistente, `shellSyntax`), el resultado queda `awaiting_review` con ese ítem como `manual`, igual que hoy.
- **E4** — Si `git apply --check` no está disponible o falla por un motivo distinto de conflictos, `delegation_apply` devuelve el error de git y no toca el checkout.
- **E5** — `expectedPatchSha256` con un worktree ya aplicado o descartado devuelve `NOT_FOUND`, no `PATCH_CHANGED`.
- **E6** — Un lock de R7 cuyo PID sigue vivo pero tiene más de `writeTimeoutMs` + `verify.timeoutMs` se considera huérfano, y la respuesta lo dice en `notes`.

## Decisions

- 2026-10-18 El usuario pidió escribir este spec con los cinco fallos que encontró la revisión cruzada de Codex (modo read, delegación `20261018191732-c97b2f`) y que Claude verificó en el código.
- 2026-10-18 Q1: los worktrees `recoverable` y `awaiting_review` se conservan indefinidamente; la card avisa a partir de los 7 días — propuesta aceptada por el usuario.
- 2026-10-18 Q2: un `NON_ZERO_EXIT` (o cualquier error) con cambios corta siempre la cadena (R3) — propuesta aceptada por el usuario.
- 2026-10-18 Q3: `expectedPatchSha256` es opcional por compatibilidad; sin él, `delegation_apply` lo dice en `notes` — propuesta aceptada por el usuario.
- 2026-10-18 Spec aprobado por el usuario.
- 2026-10-18 Plan aprobado por el usuario; integración por merge local a `main`, como las features anteriores.
- 2026-10-18 Tasks aprobadas por el usuario.
- 2026-10-19 Verificación convergida (pass 1) y fusionado en `main` sin PR; el usuario pidió acelerar, así que la revisión cruzada queda como paso opcional antes del push.

## Open questions

- Ninguna.

## Success criteria

- **SC1** — Un worktree `awaiting_review` con la meta de hace 3 días sigue existiendo después de un `SessionStart` · **Signal**: `git worktree list` · **Read at**: test de integración y máquina del usuario · **Emitted by**: R1, R2.
- **SC2** — Con un `verify.commands` que modifica un archivo (por ejemplo `prettier --write`), `delegation_apply` con el hash previo a la verificación devuelve `PATCH_CHANGED` y el checkout no cambia · **Signal**: respuesta de la herramienta y `git status` · **Read at**: test de integración · **Emitted by**: R5.
- **SC3** — Un binario fake que modifica un archivo y sale con código 1 deja un resultado `partial` con ese diff, y no se crea un segundo worktree · **Signal**: respuesta de `delegate` y `git worktree list` · **Read at**: test de integración · **Emitted by**: R3.
- **SC4** — Dos `sdd_task_delegate` simultáneos de la misma tarea: uno corre y el otro devuelve `TASK_IN_FLIGHT`; `delegation_cancel` durante un `Verify` con `sleep` lo termina en ≤ 5 s · **Signal**: respuestas de las herramientas y procesos · **Read at**: test de integración · **Emitted by**: R4, R7.
