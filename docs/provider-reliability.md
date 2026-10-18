<!-- Status enum: active | deprecated -->

# Integración robusta con Codex y Antigravity

> Spec history: [../specs/provider-reliability/](../specs/provider-reliability/)
> Status: active
> Last updated: 2026-10-18

## What it does

Hace que una delegación a Codex o Antigravity termine con el trabajo del worker o con un motivo concreto, y que la salud de cada proveedor refleje fallos del proveedor y no de la integración:

- **Codex por `codex app-server`.** Usa JSON-RPC con eventos, igual que el plugin oficial de OpenAI, con fallback automático a `codex exec`.
- **agy con `--output-format stream-json` y sin PTY.** En modo write no pide permisos.
- **Dos límites de tiempo.** Uno por inactividad (`STALLED`) y otro total, más largo en write.
- **Nada se pierde por un timeout.** Un write que se queda sin tiempo con cambios devuelve `partial` con su diff, en lugar de reintentar desde cero.
- **Cancelar de verdad.** Se mata el árbol de procesos del worker, no se prueba otro proveedor y el circuit breaker no se toca.
- **Delegaciones en curso visibles y cancelables** con `delegation_status` y `delegation_cancel`. La conductor card las muestra con su proveedor real y su último paso.
- **`! inestable` solo** con 2 fallos seguidos atribuibles al proveedor.

## Usage

Una delegación larga que pasa a segundo plano se puede seguir y cortar:

```text
delegation_status {}                       → { jobs: [{ id, provider, phase, elapsedMs, progress, files, … }] }
delegation_status { "id": "20261018…" }    → solo ese trabajo
delegation_cancel { "id": "20261018…" }    → { cancelled: true, id }   (la segunda vez: "already cancelled")
```

La llamada `delegate` / `sdd_task_delegate` que estaba corriendo vuelve entonces con `status: "cancelled"`. Si el worker ya había cambiado archivos, vuelve también con su `diff` y su `worktreePath`.

## Interface

### Estados nuevos de `delegate` y `sdd_task_delegate`

| `status` | Cuándo | Qué trae |
|---|---|---|
| `partial` | Un write agotó el tiempo (`TIMEOUT`) o se quedó sin eventos (`STALLED`) **después de cambiar archivos**. No se reintenta ni se pasa a otro proveedor | `diff`, `worktreePath`, `patchFile` y pasos para aplicar, pedir el resto o descartar |
| `cancelled` | Cancelación del cliente MCP o `delegation_cancel` | `diff` y `worktreePath` si había cambios; si no, nada |

En `sdd_task_delegate`, `partial` y `cancelled` dejan el Owner reclamado y no corren el Verify. La respuesta nombra `sdd_task_release` por si quieres devolver la tarea.

### Errores nuevos

| `errorType` | Significa | ¿Cuenta para el breaker? |
|---|---|---|
| `CANCELLED` | Lo cancelaste | No |
| `STALLED` | Sin salida durante `defaults.idleTimeoutMs` | No |
| `PERMISSION_BLOCKED` | agy esperó una aprobación que un run headless no puede dar | No; el mensaje trae el fix |

Solo cuentan `AUTH`, `QUOTA`, `RATE_LIMIT`, `PARSE_ERROR`, `EMPTY_OUTPUT`, `NON_ZERO_EXIT` y `TIMEOUT`. Los que no cuentan se guardan en `state.json → providers.*.metrics.lastNotice`, y la card los muestra como `aviso <tipo>`, no como `! inestable`.

### Config nueva

| Campo | Por defecto | Para volver a lo anterior |
|---|---|---|
| `defaults.writeTimeoutMs` | `1800000` (30 min) | `600000` |
| `defaults.idleTimeoutMs` | `120000` | un valor alto |
| `providers.codex.transport` | `"app-server"` | `"exec"` |
| `providers.antigravity.outputFormat` | `"stream-json"` (sin PTY por defecto) | `"text"` (con PTY por defecto) |
| `providers.antigravity.writeModeArgs` | `["--dangerously-skip-permissions"]` | `[]`, o `["--mode", "auto"]` como alternativa más conservadora |

### `/mp-doctor`

- **`codex: transport`:** `app-server`, o `exec` con su fix si la versión instalada no lo tiene.
- **`antigravity: flags`:** si agy acepta `stream-json` y `--dangerously-skip-permissions`.

## Behavior notes

- **agy y los permisos.** En print mode y sin PTY, agy 1.4.2 ejecutó comandos (incluido `rm`) sin pedir permiso. Bajo PTY se comporta como interactivo y puede esperar una respuesta, que es la causa probable del cuelgue de 10 min que motivó esta feature. Por eso `stream-json` va sin PTY. El evento de pedido de permiso se detecta por estado (`WAITING`/`PENDING`/approval, `requires_approval`, herramientas `ask_permission`), aunque no se observó en vivo. La red de seguridad es `STALLED`.
- **`app-server`.**
  - El servidor no puede pedir aprobaciones: cada solicitud suya recibe `-32601`.
  - Al cancelar se envía `turn/interrupt`, se esperan hasta 5 s a que el turno termine y después se mata el proceso.
  - Si `app-server` no arranca o no responde a `initialize`, el mismo intento usa `exec` y lo anota en `notes`.
- **Progreso sin contenido.** Las líneas de `delegation_status` y `state.json` llevan etiquetas de evento y, como mucho, la línea de comando (`command: npm test`), recortadas a 200 caracteres. Nunca llevan el prompt, la respuesta del worker ni contenido de archivos. En modo texto agy no reporta progreso.
- **Trabajos perdidos.** Si el servidor MCP se reinicia con un trabajo en curso, ese trabajo aparece como `lost` en `delegation_status` y su worktree queda para `delegation_cleanup`.

## Operating

- **Signal**:
  - `delegation_status` durante una delegación;
  - `state.json → jobs` y `providers.*.metrics.lastNotice`;
  - en el log de auditoría, `attempts[].errorType` con `CANCELLED`, `STALLED` o `PERMISSION_BLOCKED`.
