<!-- Status enum: draft | in-review | approved | implemented | superseded | abandoned -->

# Plan: Integración robusta con Codex y Antigravity

> Spec: [spec.md](./spec.md)
> Status: approved
> Last updated: 2026-10-18

## Approach

Se refuerza el camino que ya existe (`delegate()` → `runChain` → adapter → `runProcess`), sin reescribirlo. Se cambian tres cosas en todas sus capas:

1. **Una señal de cancelación y un callback de progreso** viajan desde la herramienta MCP hasta el proceso del worker.
   - La señal es el `extra.signal` que el SDK de MCP entrega a cada handler, o `delegation_cancel`. Con ella `runProcess` mata el árbol de procesos y `runChain` deja de probar proveedores.
   - El progreso son los eventos del worker. Alimenta el timeout por inactividad y el registro de trabajos.
2. **Cada fallo se clasifica** como atribuible al proveedor o no (cancelación, stall, permiso, timeout con trabajo hecho). Solo los atribuibles tocan el circuit breaker y el estado `! inestable`.
3. **Un timeout o stall en modo write con cambios corta la cadena** y devuelve `partial` con el diff, en vez de reintentar.

Sobre esa base se agregan dos transportes:
- **Codex por `codex app-server`.** Es JSON-RPC por stdio con el mismo protocolo que usa el plugin oficial de OpenAI (`openai-codex` 1.0.6, `scripts/lib/app-server.mjs` y `codex.mjs`): `initialize` y `initialized`, después `thread/start { cwd, sandbox, approvalPolicy: "never", ephemeral: true }` y `turn/start { threadId, input: [{ type: "text", text }] }`. Los eventos llegan como notificaciones `item/completed` (con `agentMessage`), `turn/completed` (con `turn.status`) y `error`. Se cancela con `turn/interrupt`, y a toda solicitud del servidor se responde `-32601`. Si el transporte falla, se usa el adapter `exec` actual.
- **agy con `--output-format stream-json`.** Da eventos para detectar stalls y pedidos de permiso. En modo write corre con `--dangerously-skip-permissions` por defecto (Q1).

Se descartaron tres alternativas:
- un broker persistente de `app-server` como el de OpenAI: una delegación por proceso basta para este plugin, y el broker suma ciclo de vida y sockets;
- reanudar threads (non-goal);
- reimplementar los adapters desde cero: el parseo, la clasificación y los tests actuales siguen sirviendo para `exec` y para el modo `text` de agy.

## Current state

- **Architecture**: servidor MCP plano en `server/src/`.
  - Cada adapter (`providers/codex.ts`, `providers/antigravity.ts`) implementa `ProviderAdapter.run(ProviderRequest) → ProviderResult` sobre `runProcess` (`process.ts`).
  - `fallback.ts` (`classifyFailure`, `runChain`) aplica cadena, reintentos y breaker (`circuit-breaker.ts`).
  - `delegate.ts` orquesta worktrees, verificación y registro, e `index.ts` registra las herramientas.
  - Los tests usan CLIs falsos (`server/tests/fixtures/fake-codex.mjs`, `fake-agy.mjs`) controlados por variables `FAKE_*`.
  - Esta feature sigue ese reparto. Lo nuevo es `providers/codex-app-server.ts` y `jobs.ts`.
- `server/src/process.ts`:
  - `RunOptions` tiene `timeoutMs`, pero no `signal`, `idleTimeoutMs` ni callback de salida.
  - `killTree` ya mata el grupo de procesos (y `taskkill /T` en Windows).
- `server/src/providers/types.ts` — `ProviderRequest`, `ProviderResult` y `ERROR_TYPES` (sin `CANCELLED`, `STALLED` ni `PERMISSION_BLOCKED`).
- `server/src/fallback.ts`:
  - `runChain` llama a `breaker.onFailure` en todo fallo y reintenta según `retryOn` (`TIMEOUT` incluido por defecto) sin mirar si el worktree tiene cambios. Es lo que relanzó a agy desde cero.
  - `classifyFailure` trata `exitCode === null` (proceso matado) como `NON_ZERO_EXIT`.
- `server/src/delegate.ts` — `execute()` crea y descarta un worktree por intento: sin cambios lo borra, y en write con cambios lo conserva solo si el intento fue `ok`.
- `server/src/index.ts`: los handlers reciben solo `args` (no usan `extra.signal`) y la llamada a `delegate()` bloquea hasta terminar. Tras `TaskStop`, el proceso del worker siguió vivo y la cadena lanzó otro proveedor (visto el 2026-10-18).
- `server/src/providers/antigravity.ts` — `outputFormat` acepta `text` o `json`; `writeModeArgs` está vacío por defecto (`config.ts`).
- `hooks/conductor/model.ts` (`providerView`) — `degraded` (`! inestable`) se activa con cualquier `lastError` reciente.
- `server/src/doctor.ts` — comprueba binario, versión, auth y una ejecución real, pero no el transporte ni los flags de agy.
- **Overlap scan**: `ls specs/`.
  - `sdd-traceability` (implemented) tocó `delegate.ts`, `worktree.ts` y la card, y ya está fusionada.
  - `sdd-task-delegation` (verificación abierta) no tiene tareas abiertas.
  - Rama abierta `fix/readonly-tool-annotations`, que toca `server/src/index.ts`: hay que fusionarla antes de empezar (ver Base).

## Quality gates

| Gate | Command | Where | Baseline |
|---|---|---|---|
| Tests | `npm --prefix server test` | `here` | `Test Files 18 passed (18) · Tests 236 passed (236)` |
| Types | `npm --prefix server run typecheck` | `here` | `tsc` (src + tests) exit 0, 0 errores |
| Plugin | `claude plugin validate .` · `claude plugin test .` | `here` | `✔ Validation passed` · `11 pass, 0 fail` |
| Dist | `git diff --exit-code --stat -- server/dist` tras `npm --prefix server run build` | `pipeline-only` (job `dist`); localmente, cada tarea que toca `server/src` reconstruye y committea `server/dist` | `—` |
| Tests multiplataforma | matriz ubuntu/macos/windows × Node 20/22 | `pipeline-only` (job `test`) | `—` |
| Lint / Format | — no configurado | — | — |

**Base**: `main` @ `94f65eb` más `fix/readonly-tool-annotations` (`61d2d5e`) fusionada antes de la primera tarea. Rama de feature `feature/provider-reliability`.

**Integration**: merge local a `main` sin PR, a pedido del usuario (ver Decisions del spec); los checks `test` (matriz, incluido Windows para `killTree`), `dist` y `plugin` corren en el CI del push.

**Task span**: `— a task is claimed for at most 7 days`

**Measurements**:
- SC1 (≤ 15 min) y SC2 se miden en la máquina del usuario con los CLIs reales.
- E6 (200 caracteres) y los límites de tiempo se miden en tests con CLIs falsos y un reloj inyectado.

## Components

### C1 — Cancelación y progreso de punta a punta

- **Implements**: R6, E3, E4
- **Where**: `server/src/process.ts`, `server/src/providers/types.ts`, `server/src/fallback.ts`, `server/src/delegate.ts`, `server/src/sdd/task-delegation.ts`, `server/src/index.ts`
- **What**:
  - `RunOptions` agrega `signal?: AbortSignal` (al abortar llama a `killTree` y devuelve `cancelled: true`) y `onOutput?(chunk)`.
  - `ProviderRequest` agrega `signal` y `onProgress?(line)`.
  - Nuevo `ErrorType` `CANCELLED`. `runChain` corta sin probar más proveedores ni llamar a `breaker.onFailure`, y `ChainStatus` agrega `cancelled`.
  - `delegate()` recibe `ctx.signal` y conserva el worktree si tiene cambios, como R5.
  - En `sdd_task_delegate`, `cancelled` no libera el Owner: devuelve el comando de `sdd_task_release`.
  - `index.ts` pasa `extra.signal` de los handlers de `delegate` y `sdd_task_delegate`.
- **Reuses**: `killTree`, `collectChanges`, `removeWorktree`.
- **Duplicates**: — none
- **Depends on**: —

### C2 — Fallos atribuibles y salud honesta

- **Implements**: R7
- **Where**: `server/src/providers/types.ts`, `server/src/fallback.ts`, `server/src/circuit-breaker.ts`, `server/src/delegate.ts`, `server/src/state.ts`, `hooks/conductor/model.ts`, `statusline/index.js`
- **What**:
  - `isAttributable(error)`: `true` para `AUTH`, `QUOTA`, `RATE_LIMIT`, `PARSE_ERROR`, `EMPTY_OUTPUT` y `NON_ZERO_EXIT` con código de salida.
  - Es `false` para `CANCELLED`, `STALLED`, `PERMISSION_BLOCKED`, `TIMEOUT` en write con cambios, y `exitCode === null` con señal enviada por el plugin.
  - `runChain` solo llama a `breaker.onFailure` con los atribuibles. Los demás quedan en `metrics.lastNotice` y no en `lastError`.
  - `providerView`: `degraded` solo con `breaker.consecutiveFailures ≥ 2` o el circuito abierto. Un aviso de configuración se muestra en tono `dim` con su `fix`.
  - La status line usa el mismo criterio.
- **Reuses**: `classifyFailure`, `recordCall`.
- **Duplicates**: el criterio de salud existe en `model.ts` (card) y `statusline/index.js`. Se mantienen los dos porque la status line es un script sin imports del mod, y un test en cada lado fija el mismo umbral.
- **Depends on**: C1

### C3 — Timeouts separados y diff parcial

- **Implements**: R4, R5
- **Where**: `server/src/config.ts`, `server/src/process.ts`, `server/src/fallback.ts`, `server/src/delegate.ts`
- **What**:
  - En `config.ts`: `defaults.idleTimeoutMs` (120 000) y `defaults.writeTimeoutMs` (1 800 000). `providers.*.timeoutMs` sigue ganando.
  - `runProcess` reinicia el reloj de inactividad con cada `onOutput`. Al vencerse mata el árbol y devuelve `stalled: true`, que se clasifica como `STALLED`.
  - `runChain` recibe `shouldStop(provider, result)` desde `delegate()`. Es `true` en write cuando el worktree del intento tiene cambios y el error es `TIMEOUT` o `STALLED`. Entonces no reintenta ni pasa al siguiente proveedor.
  - `DelegateStatus` agrega `partial`: trae `diff`, `worktreePath` y `patchFile`, con `nextSteps` para aplicar, pedir más o descartar.
  - `retryOn` solo se aplica si no hay cambios.
- **Reuses**: `collectChanges` (ya genera `patchFile`).
- **Duplicates**: — none
- **Depends on**: C1, C2

### C4 — agy sin prompts y con eventos

- **Implements**: R2, R3, E2
- **Where**: `server/src/providers/antigravity.ts`, `server/src/config.ts`, `server/tests/fixtures/fake-agy.mjs`, `config/multiprovider.example.json`
- **What**:
  - `writeModeArgs` por defecto pasa a `["--dangerously-skip-permissions"]` y `outputFormat` acepta `stream-json`, que es el nuevo valor por defecto.
  - El primer paso de la tarea es capturar el formato real con `agy -p "reply OK" --output-format stream-json` en la máquina del usuario y guardarlo como fixture. El formato no está documentado.
  - `parseAgyStream(lines)` extrae la respuesta final, el uso de tokens y los eventos de herramienta. Un evento de pedido de permiso, o el texto de prompt de aprobación bajo PTY, termina con `PERMISSION_BLOCKED` y el comando pedido.
  - Cada evento llama a `onProgress`, recortado a 200 caracteres (E6).
  - Si el flag no existe en la versión instalada (salida de error de flag desconocido), se reintenta una vez con `text` y queda una nota (E2).
- **Reuses**: `parseAgyJson`, `classifyFailure`, `runProcess` con PTY.
- **Duplicates**: — none
- **Depends on**: C1, C3

### C5 — Codex por app-server

- **Implements**: R1, E1
- **Where**: `server/src/providers/codex-app-server.ts` (nuevo), `server/src/providers/codex.ts`, `server/src/config.ts`, `server/tests/fixtures/fake-codex.mjs`
- **What**:
  - `CodexAppServerAdapter.run(req)` lanza `codex app-server` (sin shell, en el `cwd` del worktree y con `workerEnv`). Usa un cliente JSON-RPC por líneas mínimo: request/response por `id`, notificaciones y `-32601` a toda solicitud del servidor, de modo que no hay aprobaciones.
  - Secuencia: `initialize { clientInfo, capabilities: { optOutNotificationMethods: deltas } }` → `initialized` → `thread/start` → `turn/start`.
  - Lee las notificaciones `item/completed`, cuya respuesta es la última `agentMessage` con `phase: "final_answer"` o la última `agentMessage`. `turn/completed` aporta `turn.status` y el uso de tokens si viene, y `error` alimenta `classifyFailure` con su mensaje.
  - Cada notificación llama a `onProgress`.
  - Si se aborta: `turn/interrupt`, espera de 5 s y después `killTree`.
  - `CodexAdapter` elige el transporte con `providers.codex.transport` (`app-server` por defecto, o `exec`). Si el spawn falla, `initialize` falla o la respuesta es `-32601`, usa `exec` en el mismo intento y lo anota en `notes` (E1).
  - `fake-codex.mjs` agrega `FAKE_MODE=app-server-*`.
- **Reuses**: `classifyFailure`, `effectiveErrorPatterns`, `buildChildEnv`, `killTree`.
- **Duplicates**: — none
- **Depends on**: C1, C3

### C6 — Trabajos con estado

- **Implements**: R8, E5, E6
- **Where**: `server/src/jobs.ts` (nuevo), `server/src/delegate.ts`, `server/src/state.ts`, `server/src/index.ts`, `hooks/conductor/card.tsx`, `hooks/conductor/model.ts`, `types/index.d.ts`
- **What**:
  - `JobRegistry` en memoria: `{ id, provider, mode, sdd?, phase, startedAt, progress (últimas 20 líneas ≤ 200 caracteres), filesChanged, controller: AbortController }`.
  - `delegate()` registra el trabajo y conecta `onProgress`, y `state.json → jobs` refleja los activos para la card.
  - `delegation_status({ id? })` devuelve un trabajo o todos los activos, y `delegation_cancel({ id })` aborta su controller, como en C1.
  - Al arrancar el servidor, los trabajos de `state.json` sin proceso vivo se marcan `lost` (E5).
  - La card toma la delegación en curso de `state.json → jobs`, con proveedor real, tarea y última línea de progreso. El hook `tool.call` queda como respaldo.
- **Reuses**: `StateStore`, `recordRecent`, `listWorktrees`.
- **Duplicates**: — none
- **Depends on**: C1

### C7 — Doctor y documentación

- **Implements**: E1, E2 (diagnóstico), R1–R8 (documentación)
- **Where**: `server/src/doctor.ts`, `README.md`, `docs/provider-reliability.md` (nuevo), `skills/multi-provider/SKILL.md`, `agents/codex-worker.md`, `agents/agy-worker.md`
- **What**:
  - `/mp-doctor` informa el transporte efectivo de codex. Para agy indica si acepta `--output-format stream-json` y `--dangerously-skip-permissions` (por `agy --help`), con su `fix`.
  - Los agentes y el skill explican `partial`, `cancelled`, `delegation_status` y `delegation_cancel`.
- **Reuses**: el formato de checks de `doctor.ts`.
- **Duplicates**: — none
- **Depends on**: C4, C5, C6

## Build order

1. C1
2. C2, C6 (parallel)
3. C3
4. C4, C5 (parallel)
5. C7

## Evidence per requirement

| R#/E# | Evidence | Exists today? |
|---|---|---|
| R1 | `server/tests/codex-app-server.spec.ts` — con `fake-codex` en modo app-server: respuesta, uso, `sandbox` según el modo, `approvalPolicy: "never"`; `-32601` a una solicitud del servidor | no — Phase 5 |
| R2 | `adapters.spec.ts` — args de agy en write incluyen `--dangerously-skip-permissions`; read no | sí, parcial — existe el test de args |
| R3 | `adapters.spec.ts` — `fake-agy` emite un pedido de permiso → `PERMISSION_BLOCKED` con el comando; sin eventos 120 s (reloj falso) → `STALLED` | no — Phase 5 |
| R4 | `process.spec.ts` (nuevo) — salida periódica sobrevive a `idleTimeoutMs`; silencio lo dispara; `timeoutMs` total sigue vigente | no — Phase 5 |
| R5 | `delegate.spec.ts` — write con cambios + `TIMEOUT` → `partial`, 1 intento, sin segundo worktree; sin cambios → reintento | no — Phase 5 |
| R6 | `delegate.spec.ts` — abortar a mitad: proceso falso muerto (`pgrep` del pid), `cancelled`, 1 intento, breaker sin cambios; `sdd-task-delegation.spec.ts` — Owner intacto con comando de release | no — Phase 5 |
| R7 | `fallback.spec.ts` — `CANCELLED`/`STALLED`/`PERMISSION_BLOCKED` no tocan el breaker; `card-model.spec.ts` — 1 fallo atribuible no es `degraded`, 2 sí; `statusline.spec.ts` igual | sí, parcial — tests del breaker existen |
| R8 | `jobs.spec.ts` (nuevo) — `delegation_status` con progreso y archivos; `delegation_cancel` aborta; `state.json → jobs`; `conductor-card.test.tsx` — la card muestra el trabajo de `state.json` | no — Phase 5 |
| E1 | `codex-app-server.spec.ts` — `FAKE_MODE=app-server-missing` → usa `exec`, nota en `notes` | no — Phase 5 |
| E2 | `adapters.spec.ts` — flag desconocido → reintento con `text` y nota; `doctor.spec.ts` — fix de flags | no — Phase 5 |
| E3 | `delegate.spec.ts` — cancelar tras escribir → worktree conservado con diff | no — Phase 5 |
| E4 | `jobs.spec.ts` — segundo `delegation_cancel` → `already cancelled` | no — Phase 5 |
| E5 | `jobs.spec.ts` — `state.json` con un trabajo de otro pid → `lost` al arrancar | no — Phase 5 |
| E6 | `jobs.spec.ts` — línea de 1 000 caracteres → 200; el prompt nunca aparece en `progress` | no — Phase 5 |
| SC1 | Manual: repetir la T3 de `sdd-traceability` con agy en la máquina del usuario | no — Phase 7 |
| SC2 | Manual: cancelar una delegación y comprobar procesos, `state.json` y `git worktree list` | no — Phase 7 |

## Data changes, delivery & dependencies

- **Data changes**:
  - `state.json` gana `jobs[]` y `providers.*.metrics.lastNotice`, y `ErrorType` agrega `CANCELLED`, `STALLED` y `PERMISSION_BLOCKED`. Todo es aditivo: los lectores ignoran los campos nuevos.
  - `DelegateStatus` gana `partial` y `cancelled`.
- **Delivery**:
  - Sale en una versión menor (0.3.0) porque cambian defaults: agy sin prompts en write, codex por `app-server`, timeout de write de 30 min.
  - `providers.codex.transport: "exec"` y `providers.antigravity.writeModeArgs: []` restauran el comportamiento anterior.
- **Dependencies**: — none (el cliente JSON-RPC se escribe en el plugin; no se depende del código de `openai-codex`)

## Risks

| Risk | Mitigation |
|---|---|
| El formato `stream-json` de agy no está documentado | C4 empieza capturando el formato real y guardándolo como fixture; si no trae eventos de permiso, R3 se cumple por stall (`idleTimeoutMs`) y por el texto del prompt bajo PTY |
| `codex app-server` es experimental y su protocolo puede cambiar | Fallback automático a `exec` (E1) y `/mp-doctor` muestra el transporte; los métodos usados son los mismos que el plugin oficial de OpenAI |
| Claude Code no envía `notifications/cancelled` al servidor con `TaskStop` | `delegation_cancel` cubre la cancelación explícita (R8), y C1 también corta al cerrarse el transporte del servidor |
| `--dangerously-skip-permissions` deja a agy ejecutar cualquier comando | Solo en write, solo dentro del worktree desechable y con el entorno sin credenciales de `sdd-guardrails` R4/R5; documentado con la alternativa `--mode auto` (Q1) |
| Matar árboles de procesos en Windows | `killTree` ya usa `taskkill /T /F`; R6 se prueba en la matriz de CI (job `test` en windows-latest) |
| Subir el timeout de write a 30 min deja trabajos colgados más tiempo | El stall por inactividad (120 s sin eventos) los corta antes; el timeout total es solo el techo |

## Requirement coverage

| Requirement | Covered by |
|---|---|
| R1 | C5, C7 |
| R2 | C4 |
| R3 | C4 |
| R4 | C3 |
| R5 | C3 |
| R6 | C1 |
| R7 | C2 |
| R8 | C6 |
| E1 | C5, C7 |
| E2 | C4, C7 |
| E3 | C1, C3 |
| E4 | C6 |
| E5 | C6 |
| E6 | C4, C6 |
