<!-- Status enum: draft | in-review | approved | abandoned -->

# Tasks: Integración robusta con Codex y Antigravity

> Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md)
> Status: draft
> Last updated: 2026-10-18

Una tarea = una sesión. Hecha significa:
- su **Verify** pasa;
- los gates del plan pasan sin fallos nuevos contra su baseline (`npm --prefix server run typecheck`, `npm --prefix server test`, `claude plugin validate .`, `claude plugin test .`);
- `server/dist` está reconstruido y committeado si la tarea toca `server/src`;
- el diff está limpio.

Commits con prefijo `provider-reliability: `, solo de Claude y sin trailers de atribución.

Orden: T1 → T2 → T3 → T4 → T5. Después, T6 y T7 a la vez (no comparten archivos: T5 deja hechos los campos de config de ambos). Al final, T8 → T9. Mientras esta feature no esté integrada, las tareas no se delegan a agy ni a codex: es justo lo que se está arreglando.

## T1 — `runProcess`: cancelación, salida en vivo y timeout por inactividad

- [ ] Done
- **Owner**: —
- **Component**: C1, C3 · **Implements**: R4, R6
- **Files**: `server/src/process.ts`, `server/tests/process.spec.ts`
- **Do**: Agregar a `RunOptions`:
  - `signal?: AbortSignal`: al abortar, `killTree` y resultado con `cancelled: true`;
  - `onOutput?(chunk: string)`, llamado con cada trozo de stdout/stderr, también bajo PTY;
  - `idleTimeoutMs?`: el reloj se reinicia con cada salida y al vencerse mata el árbol y devuelve `stalled: true`.

  `timeoutMs` sigue siendo el límite total. `RunResult` agrega `cancelled` y `stalled`.
- **Acceptance**:
  - un proceso que escribe cada 50 ms sobrevive a `idleTimeoutMs: 200`;
  - uno callado 300 ms con `idleTimeoutMs: 200` termina con `stalled: true` y su pid ya no existe;
  - abortar la señal mata el proceso y su hijo y devuelve `cancelled: true`;
  - una señal ya abortada no lanza el proceso;
  - `onOutput` recibe la salida en orden;
  - los tests existentes siguen pasando.
- **Verify**: `npm --prefix server test -- process`
- **Notes**: —

## T2 — Cancelación en la cadena, `delegate` y las herramientas

- [ ] Done
- **Owner**: —
- **Component**: C1 · **Implements**: R6, E3
- **Files**: `server/src/providers/types.ts`, `server/src/providers/codex.ts`, `server/src/providers/antigravity.ts`, `server/src/fallback.ts`, `server/src/delegate.ts`, `server/src/sdd/task-delegation.ts`, `server/src/index.ts`, `server/tests/delegate.spec.ts`, `server/tests/sdd-task-delegation.spec.ts`, `server/tests/fixtures/fake-codex.mjs`
- **Do**:
  - Agregar `CANCELLED` a `ERROR_TYPES`, y `signal` y `onProgress` a `ProviderRequest`. Los dos adapters los pasan a `runProcess` como `signal` y `onOutput`.
  - `runChain` acepta `signal`: con la señal abortada no lanza más intentos, no llama a `breaker.onFailure` y devuelve `status: "cancelled"`.
  - `DelegateContext.signal`. `DelegateStatus` y `ChainStatus` agregan `cancelled`, y el worktree se conserva si tiene cambios (E3), con `diff` y `worktreePath`.
  - `sdd_task_delegate` cancelado no libera el Owner y devuelve el comando de `sdd_task_release` en `nextSteps`.
  - `index.ts` pasa `extra.signal` a `delegate` y a `sdd_task_delegate`.
  - `fake-codex.mjs` agrega `FAKE_MODE=hang-write`: escribe un archivo y espera.
- **Acceptance**:
  - abortar a los 300 ms un `delegate` write con `FAKE_MODE=hang-write` devuelve `cancelled`, con 1 solo intento (no prueba antigravity);
  - `consecutiveFailures` sigue en 0;
  - el pid del fake ya no existe;
  - el worktree se conserva con el archivo en `diff`;
  - en `sdd_task_delegate`, el Owner queda intacto y `nextSteps` nombra `sdd_task_release`;
  - los tests existentes siguen pasando.
- **Verify**: `npm --prefix server test -- delegate sdd-task-delegation`
- **Notes**: —

## T3 — Fallos atribuibles y salud honesta

- [ ] Done
- **Owner**: —
- **Component**: C2 · **Implements**: R7
- **Files**: `server/src/providers/types.ts`, `server/src/fallback.ts`, `server/src/delegate.ts`, `server/src/state.ts`, `hooks/conductor/model.ts`, `types/index.d.ts`, `statusline/index.js`, `server/tests/fallback.spec.ts`, `server/tests/card-model.spec.ts`, `server/tests/statusline.spec.ts`
- **Do**:
  - Agregar `STALLED` y `PERMISSION_BLOCKED` a `ERROR_TYPES` y la función `isAttributable(error, run)` según C2.
  - `runChain` solo llama a `breaker.onFailure` con fallos atribuibles. Los demás se guardan en `metrics.lastNotice { type, message, at }` en vez de `lastError`.
  - `providerView` y la status line marcan `degraded` / `! inestable` solo con `breaker.consecutiveFailures ≥ 2` o el circuito abierto. `lastNotice` se muestra en tono `dim`.
  - `classifyFailure`: `exitCode === null` con la señal enviada por el plugin no es `NON_ZERO_EXIT` atribuible.
  - Arreglar G2 de `sdd-traceability`: `statusline.spec.ts` fija `NO_COLOR` antes de importar.
- **Acceptance**:
  - `CANCELLED`, `STALLED` y `PERMISSION_BLOCKED` no cambian `consecutiveFailures`;
  - un `AUTH` sí lo cambia;
  - con un fallo atribuible la card no muestra `! inestable` y con dos sí;
  - la status line usa el mismo umbral;
  - `statusline.spec.ts` pasa con y sin `NO_COLOR` en el entorno.
- **Verify**: `npm --prefix server test -- fallback card-model statusline`
- **Notes**: —

## T4 — Trabajos con estado: `delegation_status` y `delegation_cancel`

- [ ] Done
- **Owner**: —
- **Component**: C6 · **Implements**: R8, E4, E5, E6
- **Files**: `server/src/jobs.ts`, `server/src/delegate.ts`, `server/src/state.ts`, `server/src/index.ts`, `hooks/conductor/card.tsx`, `hooks/conductor/model.ts`, `types/index.d.ts`, `server/tests/jobs.spec.ts`, `tests/conductor-card.test.tsx`
- **Do**:
  - `JobRegistry` según C6. `delegate()` registra cada delegación con su `AbortController`, unido a `ctx.signal`, y alimenta `progress` desde `onProgress`: últimas 20 líneas de 200 caracteres como máximo, nunca el prompt.
  - `state.json → jobs` refleja los activos con `{ id, provider, mode, sdd?, phase, startedAt, lastProgress, pid }`.
  - Herramientas `delegation_status({ id? })` (`readOnlyHint`) y `delegation_cancel({ id })`.
  - Al arrancar, los trabajos cuyo `pid` no existe pasan a `lost` (E5).
  - La card toma la delegación en curso de `state.json → jobs`, con su proveedor, tarea y `lastProgress`.
- **Acceptance**:
  - durante un `delegate` con `FAKE_MODE=hang-write`, `delegation_status()` lo lista con progreso y archivos cambiados;
  - `delegation_cancel` lo termina como en T2;
  - un segundo cancel responde `already cancelled` (E4);
  - un trabajo de otro pid sale `lost`;
  - una línea de 1 000 caracteres queda en 200 y el texto del prompt no aparece en `progress` (E6);
  - el test de la card muestra el trabajo leído de `state.json`.
- **Verify**: `npm --prefix server test -- jobs` · `claude plugin test .`
- **Notes**: —

## T5 — Timeouts separados, diff parcial y campos de config

- [ ] Done
- **Owner**: —
- **Component**: C3 · **Implements**: R4, R5
- **Files**: `server/src/config.ts`, `server/src/fallback.ts`, `server/src/delegate.ts`, `config/multiprovider.example.json`, `server/tests/config.spec.ts`, `server/tests/delegate.spec.ts`, `server/tests/fixtures/fake-codex.mjs`
- **Do**:
  - En `config.ts`:
    - `defaults.idleTimeoutMs` (120 000) y `defaults.writeTimeoutMs` (1 800 000);
    - `providers.codex.transport` (`"app-server"` | `"exec"`, por defecto `"app-server"`);
    - `providers.antigravity.outputFormat` acepta `"stream-json"`, que pasa a ser el valor por defecto;
    - `providers.antigravity.writeModeArgs` por defecto `["--dangerously-skip-permissions"]`.
  - `delegate()` pasa `idleTimeoutMs`, y `writeTimeoutMs` en write.
  - `runChain` recibe `shouldStop(provider, result)`. Para `TIMEOUT` o `STALLED` en write con cambios, la cadena se corta y `delegate` devuelve `status: "partial"` con diff, `worktreePath`, `patchFile` y `nextSteps`.
  - `retryOn` solo se aplica sin cambios.
  - `fake-codex.mjs` agrega `FAKE_MODE=write-then-stall`.
- **Acceptance**:
  - un write con `write-then-stall` y `idleTimeoutMs` corto devuelve `partial`, con 1 intento y un solo worktree, que contiene el archivo;
  - el mismo stall sin escribir reintenta según `retryOn`;
  - la config sin overrides da los nuevos defaults;
  - `transport: "exec"` y `writeModeArgs: []` se respetan.
- **Verify**: `npm --prefix server test -- config delegate`
- **Notes**: —

## T6 [P] — agy con `stream-json` y detección de permisos

- [ ] Done
- **Owner**: —
- **Component**: C4 · **Implements**: R2, R3, E2, E6
- **Files**: `server/src/providers/antigravity.ts`, `server/tests/adapters.spec.ts`, `server/tests/fixtures/fake-agy.mjs`, `server/tests/fixtures/agy-stream.jsonl`
- **Do**:
  - Primero, capturar el formato real en la máquina del usuario: `agy -p "reply OK" --output-format stream-json` (y un pedido que necesite un comando). Guardarlo recortado en `agy-stream.jsonl`.
  - `parseAgyStream`: respuesta final, uso de tokens, eventos de herramienta y pedido de permiso.
  - Cada evento llama a `onProgress`, con 200 caracteres como máximo.
  - Un pedido de permiso, o su texto bajo PTY, termina el intento con `PERMISSION_BLOCKED` y el comando pedido, más un `fix` que nombra `writeModeArgs`.
  - Un flag desconocido en la salida provoca un reintento con `text` y una nota (E2).
  - `fake-agy.mjs` reproduce el fixture y los modos `stream-permission` y `unknown-flag`.
- **Acceptance**:
  - el fixture real se parsea a su respuesta y uso;
  - `stream-permission` da `PERMISSION_BLOCKED` con el comando antes de 5 s;
  - en write los args incluyen `--dangerously-skip-permissions` y `--output-format stream-json`, y en read no está el primero;
  - `unknown-flag` cae a `text` con nota;
  - los tests existentes de agy siguen pasando.
- **Verify**: `npm --prefix server test -- adapters`
- **Notes**: —

## T7 [P] — Codex por `app-server`

- [ ] Done
- **Owner**: —
- **Component**: C5 · **Implements**: R1, E1
- **Files**: `server/src/providers/codex-app-server.ts`, `server/src/providers/codex.ts`, `server/tests/codex-app-server.spec.ts`, `server/tests/fixtures/fake-codex-app-server.mjs`
- **Do**:
  - Implementar `CodexAppServerAdapter` según C5:
    - cliente JSON-RPC por líneas;
    - `initialize` y `initialized` → `thread/start { cwd, sandbox, approvalPolicy: "never", ephemeral: true, model? }` → `turn/start { threadId, input: [{ type: "text", text, text_elements: [] }] }`;
    - lectura de `item/completed` (`agentMessage`, preferir `phase: "final_answer"`), `turn/completed` (`turn.status` y uso si viene) y `error`;
    - `-32601` a toda solicitud del servidor;
    - `onProgress` por notificación;
    - al abortar, `turn/interrupt`, 5 s y `killTree`.
  - `CodexAdapter.run` delega según `transport`. Un spawn fallido, un `initialize` fallido o un `-32601` del servidor usan `exec` en el mismo intento, con nota (E1).
  - El fake implementa el protocolo con modos `ok`, `error`, `server-request`, `hang` y `missing`.
- **Acceptance**:
  - `ok` devuelve la respuesta final y el uso;
  - `thread/start` lleva `sandbox: "workspace-write"` en write y `"read-only"` en read, y `approvalPolicy: "never"`;
  - `server-request` recibe `-32601` y el turno termina;
  - `hang` abortado envía `turn/interrupt` y el proceso muere;
  - `missing` usa `exec` con nota;
  - los tests existentes de codex siguen pasando.
- **Verify**: `npm --prefix server test -- codex-app-server adapters`
- **Notes**: —

## T8 — `/mp-doctor`: transporte y flags

- [ ] Done
- **Owner**: —
- **Component**: C7 · **Implements**: E1, E2
- **Files**: `server/src/doctor.ts`, `server/tests/doctor.spec.ts`
- **Do**: Agregar dos checks a `/mp-doctor`:
  - el transporte efectivo de codex: `app-server` si `codex app-server --help` sale con 0, si no `exec` con su `fix`;
  - si agy acepta `--output-format stream-json` y `--dangerously-skip-permissions`, buscándolos en `agy --help`, con su `fix`.

  La ejecución real de una línea usa el adapter con el transporte efectivo.
- **Acceptance**: Con los fakes, el doctor reporta `app-server` o `exec` según el modo, y marca el flag ausente de agy con su `fix`. `--json` incluye los dos checks.
- **Verify**: `npm --prefix server test -- doctor`
- **Notes**: —

## T9 — Document the feature

- [ ] Done
- **Owner**: —
- **Component**: C7 · **Implements**: all (documentation)
- **Files**: `docs/provider-reliability.md`, `README.md`, `skills/multi-provider/SKILL.md`, `agents/codex-worker.md`, `agents/agy-worker.md`
- **Do**:
  - Escribir `docs/provider-reliability.md`: transportes, timeouts, `partial`, `cancelled`, fallos atribuibles, `delegation_status`/`delegation_cancel`, los nuevos defaults y cómo volver a los anteriores.
  - En el README: config (campos nuevos), herramientas, troubleshooting de `PERMISSION_BLOCKED` y `STALLED`, y la alternativa `--mode auto`.
  - En el skill y los agentes: cómo tratar `partial` y `cancelled`.
- **Acceptance**: La doc describe el comportamiento real y cada ejemplo coincide con los esquemas de `index.ts` y `config.ts`.
- **Verify**: comparar cada ejemplo con `server/src/index.ts` y `server/src/config.ts`
- **Notes**: —

---

## Gaps found in verification

---

## Verification reports
