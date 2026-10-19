# Ciclo de vida de las delegaciones

Spec: [`specs/delegation-lifecycle/spec.md`](../specs/delegation-lifecycle/spec.md). Desde la 0.5.0:
- un diff de un worker no se pierde ni cambia entre la revisión y el apply;
- cada fase (worker, verificación, revisión) se ve en `delegation_status` y se puede cancelar.

## Estados (R1, R2)

Cada worktree `mp/*` guarda su estado en la meta (`.git/…/mp-meta.json`), con `updatedAt` en cada cambio:

| Estado | Cuándo | ¿La limpieza lo borra? |
|---|---|---|
| `running` | El worker está trabajando | Nunca |
| `verifying` | El worker terminó bien; corren `verify.commands` o el `Verify` y los gates de la tarea | Nunca |
| `awaiting_review` | Verificación terminada (o cancelada); el diff espera que lo revises | Nunca |
| `recoverable` | El worker falló (o el servidor se reinició) después de cambiar archivos | Nunca |
| `discardable` | Sin nada que conservar | Sí, con más de 24 h |

- **Edad:** se mide con `updatedAt` de la meta, no con el `mtime` del directorio.
- **Worktrees anteriores a la 0.5.0 (E1):** no tienen estado. Cuentan como `awaiting_review` si tienen cambios y como `discardable` si no.

Cada transición queda en el log de auditoría como `{ type: "lifecycle", id, from, to }`, sin contenido (R8).

## Limpieza

- **Qué borra:** `SessionStart` y `delegation_cleanup` (sin argumentos) solo borran worktrees `discardable`, o con la meta ilegible, de más de 24 h.
- **Respuesta:** `delegation_cleanup` separa `removed` y `kept`, con el estado y la edad de cada uno.
- **`force: true`:** borra todo, incluidas las ramas `mp/*` huérfanas.
- **Diffs pendientes:** los `awaiting_review` y `recoverable` se conservan indefinidamente (Q1).
  - La card los cuenta.
  - Desde los 7 días avisa en amarillo: `⚠ 2 diffs pendientes · el más antiguo de hace 9 días`.
  - `/mp-doctor` los lista en la línea `pending worktrees`.

## Un error con cambios no se reintenta (R3)

En modo write, si un intento termina con cualquier error después de cambiar archivos, el resultado vuelve como `status: "partial"`, con `errorType`, el diff y el estado `recoverable`. Esto vale para `NON_ZERO_EXIT`, `PARSE_ERROR`, `TIMEOUT`, `STALLED` y el resto. La cadena **no** lanza otro proveedor sobre la misma tarea (Q2).

Hay tres salidas:
- **aplicar** con `delegation_apply`;
- **pedir otro proveedor:** `delegation_discard` y un `delegate` nuevo;
- **descartar.**

`CANCELLED` sigue terminando en `cancelled`. Sin cambios en el worktree, el fallback y `retryOn` siguen como antes.

## Verificación dentro del job (R4)

- **Dónde corre:** `verify.commands` (para `delegate`) y el `Verify` más los gates (para `sdd_task_delegate`) corren en el servidor, dentro del job y en la fase `verifying`. El hook `PostToolUse` ya no ejecuta comandos: solo formatea los resultados que trae la respuesta (`verification`).
- **Seguimiento:** `delegation_status` muestra el comando en curso (`detail`). La card muestra `verificando · <comando>`.
- **Cancelación:** `delegation_cancel` mata el comando en curso y no ejecuta los siguientes. El resultado queda `awaiting_review` con `verification.result: "cancelled"`.
- **Sintaxis de shell:** un comando de `verify.commands` con sintaxis de shell (`&&`, `|`, `$`…) queda `manual`, igual que en un `Verify`. Antes se partía en argumentos y se ejecutaba con el operador como argumento literal.

## Aplicar exactamente lo revisado (R5, R6)

Después de la verificación, el servidor vuelve a calcular el diff:
- devuelve `patchSha256`, el SHA-256 del patch completo;
- si la verificación cambió archivos (por ejemplo `lint --fix`), agrega la violación `verify_modified_files`, y el diff devuelto es el final.

`delegation_apply { worktreePath, expectedPatchSha256?, allowConflicts? }`:

| Caso | Resultado |
|---|---|
| El hash no coincide con el diff actual | `code: "PATCH_CHANGED"` con el hash nuevo. No toca el checkout y queda en la auditoría |
| Sin `expectedPatchSha256` | Aplica y lo dice en `notes` (Q3: opcional por compatibilidad) |
| `git apply --check` pasa | Aplica y borra el worktree |
| Conflictos | `applied: false`, `conflicts` y `patchFile`, con el checkout **intacto** |
| Conflictos y `allowConflicts: true` | Aplica con marcadores `--3way`, lista los archivos y conserva el worktree |
| Parche corrupto o salida de git que no se puede interpretar (E4) | El error de git; no toca nada |
| El worktree ya se aplicó o descartó (E5) | `code: "NOT_FOUND"` |

`git apply --3way --check` sale con 0 aunque haya conflictos. Por eso se prueba primero el `--check` estricto, y los conflictos se leen del texto de git con `LC_ALL=C`.

## Una tarea, una delegación (R7)

`sdd_task_delegate` reserva `<repo>/<slug>/<T#>` con un archivo en `~/.claude/multi-provider/locks/`, creado con `O_EXCL`.

- **Segunda llamada:** falla con `TASK_IN_FLIGHT` y el id de la delegación que ya corre, sin arrancar un worker. Queda en la auditoría.
- **Fin de la reserva:** se libera al terminar, por cualquier motivo.
- **Locks huérfanos (E6):** un lock con el PID muerto, o más antiguo que `writeTimeoutMs + verify.timeoutMs`, se reemplaza con una nota. Si dos llamadas ven el mismo huérfano, solo una lo toma.
