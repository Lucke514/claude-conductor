<!-- Status enum: draft | in-review | approved | implemented | superseded | abandoned -->

# Spec: Integración robusta con Codex y Antigravity

> Status: approved
> Owner: Lucas Gonzalez Espinosa (@Lucke514)
> Sign-off: — the session's user holds all of these
> Tracking: — this project tracks work in the repo only
> Last updated: 2026-10-18

## Objective

Que una delegación a Codex o a Antigravity termine con el trabajo del worker, o con un motivo concreto y accionable, y que la salud de cada proveedor refleje fallos del proveedor y no de la integración.

En la sesión del 2026-10-18, implementando `sdd-traceability`, pasó esto:
- **agy** hizo T3 completa, pero agotó el timeout fijo de 10 min. Lo más probable es que estuviera esperando permiso para ejecutar `npm test`, porque `writeModeArgs` está vacío por defecto. La política de reintentos (`retryOn: TIMEOUT`) lo relanzó desde cero en un worktree nuevo, y el trabajo solo se recuperó del patch guardado.
- Al cancelar la llamada MCP (`TaskStop`), el proceso agy siguió vivo. Al matarlo a mano, la cadena de fallback lanzó codex sobre la misma tarea.
- La card marcó a **codex** y a **agy** como `! inestable` por errores que causó la propia integración (`exit code null` de un proceso matado, `interrupted`). Un solo error reciente basta para ese estado.
- El plugin oficial de OpenAI para Claude Code (`openai-codex`) no usa `codex exec`. Habla con `codex app-server` por JSON-RPC (`thread/start`, `turn/start`, `turn/interrupt`), con eventos en streaming y trabajos en segundo plano con estado (`/codex:status`).

## Users & scenarios

- **Delegación larga**: como desarrollador, cuando delego una tarea que tarda más de 10 min, quiero que el worker siga mientras avance y ver su progreso, en vez de que lo maten a ciegas.
- **agy pide permiso**: como desarrollador, cuando agy necesita aprobar un comando en modo headless, quiero que no se quede colgado: o corre sin pedir permiso dentro del worktree aislado, o la delegación falla al momento diciendo qué permiso pidió y cómo configurarlo.
- **Timeout con trabajo hecho**: como desarrollador, si un worker se pasa del tiempo con cambios ya hechos, quiero recibir ese diff parcial y no un reintento desde cero.
- **Cancelar**: como desarrollador, cuando cancelo una delegación, quiero que el proceso del worker muera y que no arranque otro proveedor por su cuenta.
- **Salud honesta**: como desarrollador, quiero que `! inestable` signifique que el proveedor está fallando, no que yo cancelé algo.
- **Surfaces**: adapters de proveedor (`server/src/providers/*`) · cadena de fallback y circuit breaker · herramientas MCP (`delegate`, `sdd_task_delegate` y las nuevas `delegation_status`/`delegation_cancel`) · conductor card · `/mp-doctor`.
- **Operational criteria** — una `R#`/`E#`/`SC#` o `non-goal` por ítem:
  - Load & volume: non-goal (una delegación por llamada, como hoy) · Text & locale: non-goal · Operational signal: SC1, SC2 · Degradation: R1 (fallback a `exec`), E1, E2 · Partial failure: R5, R6
  - Accessibility: non-goal (sin UI nueva más allá de textos de la card)
- **Sensitive ground**: R2 hace que agy ejecute comandos sin pedir aprobación.
  - Access control: R2 (solo dentro del worktree aislado y con las credenciales de git/GitHub ya quitadas por `sdd-guardrails` R4/R5) · Traceability: R8 · Data handling: non-goal (sin datos nuevos) · Data lifecycle: non-goal · Repeat-request correctness: R6

## Requirements

- **R1** — Codex se ejecuta por defecto con `codex app-server` (JSON-RPC por stdio):
  - `thread/start` con el `cwd` del worktree, sandbox `read-only` o `workspace-write` según el modo y aprobación `never`;
  - `turn/start` con el prompt; la respuesta, el uso de tokens y los archivos se leen de los eventos del turno;
  - `turn/interrupt` al cancelar.

  `providers.codex.transport: "exec"` vuelve al adapter actual. Si `app-server` no arranca o el protocolo no coincide, la delegación usa `exec` y lo dice en `notes`.
- **R2** — En modo write, agy corre sin prompts de permiso: por defecto `writeModeArgs` es `["--dangerously-skip-permissions"]`. El aislamiento lo dan el worktree desechable y el entorno sin credenciales de `sdd-guardrails`. `/mp-doctor` comprueba que la versión instalada acepta el flag. En modo read no se aprueba nada.
- **R3** — agy se ejecuta con `--output-format stream-json`. Una solicitud de permiso en el stream, o un tiempo sin eventos mayor que `idleTimeoutMs` (por defecto 120 s), termina el intento con el error `PERMISSION_BLOCKED` (con el comando pedido) o `STALLED`, sin esperar al timeout total. Ambos traen un `fix` concreto.
- **R4** — Hay dos límites de tiempo por intento: `idleTimeoutMs`, sin eventos de progreso, y `timeoutMs`, total, que en modo write sube por defecto a 30 min. Mientras llegan eventos, el worker sigue.
- **R5** — En modo write, un `TIMEOUT` o `STALLED` con cambios en el worktree no se reintenta ni pasa al siguiente proveedor. La respuesta tiene `status: "partial"` con el diff, el worktree y el `patchFile`, y los pasos para aplicar, pedir más o descartar. `retryOn` solo se aplica cuando el worktree no tiene cambios.
- **R6** — Cancelar la llamada MCP (cancelación del cliente o `delegation_cancel`) mata el árbol de procesos del worker, o envía `turn/interrupt` en Codex. No intenta otros proveedores y no toca el circuit breaker. Conserva el worktree si tiene cambios (como R5). En `sdd_task_delegate`, el Owner no se libera solo: la respuesta trae el comando de handback.
- **R7** — El circuit breaker y el estado `! inestable` solo cuentan fallos atribuibles al proveedor: `AUTH`, `QUOTA`, `RATE_LIMIT`, `PARSE_ERROR`, y la salida ≠ 0 que el proveedor reporta como error. No cuentan cancelaciones, procesos terminados por el plugin, `PERMISSION_BLOCKED` ni `STALLED`, que se muestran como avisos de configuración. La card muestra `! inestable` solo con 2 o más fallos atribuibles seguidos o con el circuito abierto.
- **R8** — Las delegaciones de más de 60 s corren como trabajo con estado en el servidor:
  - `delegation_status(id?)` devuelve fase, tiempo transcurrido, últimas líneas de progreso (sin el contenido del prompt) y archivos cambiados hasta ahora;
  - `delegation_cancel(id)` cancela como R6.

  La conductor card lee de ese estado las delegaciones en curso, también las de `sdd_task_delegate`.

**Minimum shippable**: R2, R3, R5, R6, R7, E1, E3.

## Non-goals

- Reanudar una conversación anterior del worker (`thread/resume` de Codex): queda para después.
- Que agy use un protocolo distinto de su modo print: no tiene app-server documentado.
- Cambiar la cadena por defecto o el routing.
- Un sandbox de red propio: sigue siendo del CLI de cada proveedor.

## Edge cases & error behavior

- **E1** — Si `codex app-server` no existe en la versión instalada (es experimental), se usa `exec` y `/mp-doctor` informa el transporte efectivo.
- **E2** — Si la versión de agy no acepta `--output-format stream-json` o `--dangerously-skip-permissions`, `/mp-doctor` lo marca con su `fix`, y el adapter usa `text` sin detección de stall, solo con `timeoutMs`.
- **E3** — Si un worker escribe en el worktree y después se cancela, el diff parcial queda disponible igual que en R5.
- **E4** — Dos cancelaciones seguidas de la misma delegación no fallan: la segunda informa que ya estaba cancelada.
- **E5** — Si el servidor MCP se reinicia con un trabajo en curso, el proceso del worker muere con él, `delegation_status` lo informa como `lost` y el worktree queda para `delegation_cleanup`.
- **E6** — Las líneas de progreso de R8 se recortan a 200 caracteres y nunca incluyen el prompt, contenido de archivos ni variables de entorno.

## Decisions

- 2026-10-18 El usuario pidió reforzar la integración con agy y codex tras ver ambos marcados como inestables y a agy perder trabajo por timeout, tomando como referencia el plugin oficial de OpenAI.
- 2026-10-18 Q1: R2 usa `--dangerously-skip-permissions` por defecto (worktree aislado y sin credenciales); `--mode auto` queda documentado como alternativa — propuesta aceptada por el usuario.
- 2026-10-18 Q2: R8 (trabajos con estado) entra en este spec — propuesta aceptada por el usuario.
- 2026-10-18 Q3: Codex por `app-server` por defecto, con fallback automático a `exec` — propuesta aceptada por el usuario.
- 2026-10-18 Spec aprobado por el usuario.
- 2026-10-18 Plan aprobado por el usuario; la integración va por PR para que la matriz de Windows pruebe la cancelación.
- 2026-10-18 Tasks aprobadas por el usuario.

## Open questions

- Ninguna.

## Success criteria

- **SC1** — Repetir la T3 de `sdd-traceability` (una tarea que necesita correr `npm test`) con `agy` termina con un diff en ≤ 15 min sin intervención · **Signal**: respuesta de `sdd_task_delegate` · **Read at**: la máquina del usuario · **Emitted by**: R2–R5.
- **SC2** — Tras cancelar una delegación, `pgrep -f "agy -p|codex"` no devuelve procesos del worker, `consecutiveFailures` no cambia y no se crea otro worktree · **Signal**: procesos, `state.json`, `git worktree list` · **Read at**: la máquina del usuario · **Emitted by**: R6, R7.
