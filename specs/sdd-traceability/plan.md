<!-- Status enum: draft | in-review | approved | implemented | superseded | abandoned -->

# Plan: Pipeline y trazabilidad SDD

> Spec: [spec.md](./spec.md)
> Status: implemented
> Last updated: 2026-10-18

## Approach

El estado de una feature se calcula en un único lugar: un módulo puro nuevo del servidor, `server/src/sdd/pipeline.ts`, sobre los parsers que ya existen en `server/src/sdd/artifacts.ts`. Lo exponen la herramienta MCP `sdd_feature_status` y el comando `/sdd-status`.

La card no reimplementa la lógica. Cada 15 s, en el mismo ciclo en que hoy lee `specs/`, llama a esa herramienta con `$.mcp.connect("multi-provider")` + `$.mcp.call(...)`, y combina el resultado con la delegación en curso que ya conoce por su hook `tool.call`. Así se cumple la decisión Q2 (refresco ≤ 15 s con la misma lógica que el servidor) sin un tercer paquete. El sandbox de mods no puede importar código del servidor, y el servidor compila con `rootDir: src`: es la razón por la que `sdd-task-delegation` dejó duplicado `parseTasks`. Si el servidor no está conectado, la card cae a la línea actual (`specProgress`/`pickActiveSpec`).

Se descartaron dos alternativas:
- copiar la lógica de etapas a `hooks/conductor/model.ts`: una segunda implementación que derivaría con el tiempo;
- que el servidor escriba un resumen en `state.json`: los cambios hechos a mano en `tasks.md` no se verían hasta la siguiente herramienta `sdd_*`.

La trazabilidad (R5) es un campo opcional `sdd` que `sdd_task_delegate` pasa a `delegate()`, el cual lo copia a la entrada de audit y a la delegación reciente. El usage (R9) sale de `$.session.usage().rateLimits`, que la card ya llama para ctx y costo, más un handler de `session.measure`.

## Current state

- **Architecture**: servidor MCP plano en `server/src/` con la carpeta de dominio `server/src/sdd/` (`artifacts`, `brief`, `claim`, `verify`, `task-delegation`). Herramientas registradas en `server/src/index.ts`, slash commands en `commands/*.md`. La card es un mod (`hooks/conductor/card.tsx`) con su view model puro en `hooks/conductor/model.ts`, testeado desde vitest (`server/tests/card-model.spec.ts`, incluido por `tsconfig.test.json`) y con `claude plugin test .` (`tests/conductor-card.test.tsx`). Los tipos del mod viven en `types/index.d.ts`. Esta feature sigue ese mismo reparto.
- `server/src/sdd/artifacts.ts`:
  - `loadFeature` lanza `FEATURE_NOT_FOUND` en una feature Standard sin `tasks.md` (por ejemplo, esta misma hoy). El pipeline necesita una lectura tolerante: se añade `readFeatureArtifacts` y `loadFeature` pasa a usarla, sin cambiar su contrato.
  - `parseStatus`, `parseTasks` y `listSlugs` se reutilizan. No hay parser de `## Verification reports` ni de `scope.md`.
- `server/src/delegate.ts` — `delegate(params, ctx)` escribe `appendAudit` (l. 265) y `recordRecent` (l. 251): ahí se añade `sdd`.
- `server/src/audit.ts` (`AuditEntry`) y `server/src/state.ts` (`RecentDelegation`, `MAX_RECENT = 8`) — se añade el campo opcional `sdd`.
- `server/src/sdd/task-delegation.ts` — llama a `delegate()`; pasa `sdd: { slug, taskId }`.
- `hooks/conductor/card.tsx`:
  - `loadSpec` (l. 126) lee `specs/*/tasks.md` cada 15 s y elige una feature con `pickActiveSpec`;
  - `loadMeta` (l. 98) ya llama a `$.session.usage()` pero solo usa `context` y `cost`;
  - la cabecera de sesión se dibuja en l. 284–293;
  - no hay handler de `session.measure`.
- `hooks/conductor/model.ts` — `SpecProgress`, `parseTasks`, `specProgress`, `pickActiveSpec`, `bar`, `ctxBar`, `fmtDuration`, `PALETTE`.
- **Overlap scan**: `ls specs/` → `sdd-guardrails` (implemented), `sdd-task-delegation` (approved, verificación no convergida, toca `server/src/sdd/*` y `delegate.ts` pero sin tareas abiertas) y `sdd-integration` (solo `scope.md`). Ramas locales: `feature/auto-delegate` (ya fusionada). Ningún plan abierto reclama estos archivos.

## Quality gates

| Gate | Command | Where | Baseline |
|---|---|---|---|
| Tests | `npm --prefix server test` | `here` | `Test Files 17 passed (17) · Tests 200 passed (200)` |
| Types | `npm --prefix server run typecheck` | `here` | `tsc` (src + tests) exit 0, 0 errores |
| Plugin | `claude plugin validate .` · `claude plugin test .` | `here` | `✔ Validation passed` · `7 pass, 0 fail` |
| Dist | `git diff --exit-code --stat -- server/dist` tras `npm --prefix server run build` | `pipeline-only` (job `dist`); localmente, cada tarea que toca `server/src` reconstruye y committea `server/dist` | `—` (0 archivos difieren en la base) |
| Tests multiplataforma | matriz ubuntu/macos/windows × Node 20/22 | `pipeline-only` (job `test`) | `—` |
| Lint / Format | — el proyecto no tiene linter ni formatter configurado | — | — |

**Base**: `main` @ `648bc57` — rama de feature dedicada `feature/sdd-traceability`.

**Integration**: un PR a `main` revisado y fusionado por el usuario; checks requeridos de CI: `test` (matriz), `dist`, `plugin`.

**Task span**: `— a task is claimed for at most 7 days`

**Measurements**: E9 (resumen de 50 features en < 1 s) se mide en un test con 50 fixtures y `performance.now()`.

## Components

### C1 — Pipeline de etapas

- **Implements**: R1, R2, R3, R4, R8, E1, E2, E4, E5, E6, E7, E8, E10, E11
- **Where**: `server/src/sdd/pipeline.ts` (nuevo); `server/src/sdd/artifacts.ts` (`readFeatureArtifacts`, `parseVerificationReports`, `parseScope`)
- **What**:
  - `featureStatus(projectDir, slug, recent?)` → `{ slug, depth, statuses, stage, substage?, tasks: { open, done, waived, deferred, blocked, total, openList[{id, owner}] }, verification?: { pass, converged, verdicts }, nextStep, warnings[{ code, detail, taskId? }], notes[] }`.
  - `listFeatureStatus(projectDir, recent?)` → resumen ordenado por el rank de `scope.md` y luego por nombre.
  - Etapas en el orden de R2. Avisos de R4: `ready_to_close`, `orphan_claim` (contra `recent` de `state.json`, Q3), `closed_with_open_tasks`, `scope_mismatch` y `violations`. El aviso `violations` se lee de `recent[].violations` solo si la delegación lleva `sdd`, porque la auditoría completa no se relee.
  - `readFeatureArtifacts` devuelve los textos presentes sin lanzar error por la ausencia de `plan.md` o `tasks.md`. Un Status ilegible da etapa `Desconocida` + `malformed` (E2), sin afectar a las demás features.
  - Funciones puras salvo la lectura de archivos; nunca escriben (R8).
- **Reuses**: `parseStatus`, `parseTasks`, `smallTasksSection`, `listSlugs`, `SddError`, el patrón `SLUG` de `artifacts.ts`; `readState` de `state.ts`.
- **Duplicates**: `hooks/conductor/model.ts → parseTasks/specProgress` sigue existiendo, pero solo como fallback de la card cuando el servidor no responde (C4). La lógica de etapas no se duplica.
- **Depends on**: —

### C2 — Trazabilidad en audit y state

- **Implements**: R5, E7
- **Where**: `server/src/audit.ts`, `server/src/state.ts`, `server/src/delegate.ts`, `server/src/sdd/task-delegation.ts`
- **What**: `AuditEntry.sdd?` y `RecentDelegation.sdd?` de tipo `{ slug: string; taskId: string }`. `DelegateParams` acepta `sdd?`, solo lo rellena `sdd_task_delegate` y `delegate()` lo copia a ambos registros. El esquema zod de la herramienta pública `delegate` no lo expone.
- **Reuses**: `appendAudit`, `recordRecent`.
- **Duplicates**: — none
- **Depends on**: —

### C3 — Herramienta MCP y comando

- **Implements**: R6, E3, E9
- **Where**: `server/src/index.ts`; `commands/sdd-status.md` (nuevo)
- **What**: `sdd_feature_status({ slug?, projectDir? })` en modo solo lectura, sin hook PreToolUse, que devuelve JSON. `/sdd-status [slug]` instruye a Claude a llamarla y a dibujar el pipeline como texto (etapas con `✓`, `▸` y `·`, progreso, avisos y siguiente paso), sin ejecutar el siguiente paso.
- **Reuses**: el `json`/`fail` de `index.ts`; el formato de `commands/sdd-delegate.md`.
- **Duplicates**: — none
- **Depends on**: C1

### C4 — Líneas SDD en la card

- **Implements**: R7, E3, E6, E9
- **Where**: `hooks/conductor/card.tsx` (`loadSpec`, dibujo de la línea), `hooks/conductor/model.ts` (`pipelineView`), `types/index.d.ts`
- **What**:
  - `loadSpec` intenta `sdd_feature_status` sin `slug` vía `$.mcp`; si el servidor no está conectado o la llamada falla, usa el cálculo actual con `specProgress`.
  - `pipelineView(summary, running)` es pura: elige hasta 3 features en `Implementación`/`Verificación` y produce `slug ▸ Impl 3/8 · codex T4 ⏳ · ⚠ 1`. Toma la tarea en curso del `taskId` del argumento de `sdd_task_delegate` capturado por el hook `tool.call`.
  - El estado se comunica con texto; el color solo lo refuerza.
- **Reuses**: el átomo `spec` (cambia su tipo a la lista), `PALETTE`, el `$.clock.every` de 15 s.
- **Duplicates**: — none
- **Depends on**: C3

### C5 — Usage de Claude Code en la card

- **Implements**: R9, E12, E13, E14
- **Where**: `hooks/conductor/card.tsx` (`loadMeta`, handler `session.measure`, cabecera), `hooks/conductor/model.ts` (`rateLimitView`), `types/index.d.ts` (`SessionMeta.rateLimits`)
- **What**:
  - `loadMeta` guarda `usage.rateLimits`, y `on('session.measure')` refresca `meta` con `e.rateLimits`.
  - `rateLimitView(limits, now)` es pura: etiqueta (`five_hour` → `5h`, `seven_day` → `7d`, `spend_limit` → `gasto`, cualquier otro tipo → su `kind`), barra de 6, porcentaje tal cual, reinicio con `fmtDuration(resetsAt − now)` y tono `warn` desde 80 y `error` desde 95.
  - Sin ventanas, o si `usage()` falla, muestra `usage —` (E12).
  - En `side` las ventanas comparten la línea de modelo, ctx y costo; en `below` van en una línea propia (E14).
- **Reuses**: `bar`, `fmtDuration`, `PALETTE`.
- **Duplicates**: — none
- **Depends on**: —

### C6 — Documentación

- **Implements**: R6 (documentación de la superficie)
- **Where**: `README.md` (tabla de comandos, sección de la feature y fila de la card); `skills/multi-provider/SKILL.md` (consultar `sdd_feature_status` antes de `/sdd-delegate`); `docs/sdd-traceability.md` (nuevo: etapas, avisos y formato de la respuesta)
- **What**: documenta el pipeline, los avisos, el campo `sdd` del audit y la cabecera de usage.
- **Reuses**: el formato de `docs/sdd-task-delegation.md`.
- **Duplicates**: — none
- **Depends on**: C3, C4, C5

## Build order

1. C1, C2, C5 (parallel)
2. C3
3. C4
4. C6

## Evidence per requirement

| R#/E# | Evidence | Exists today? |
|---|---|---|
| R1 | `server/tests/sdd-pipeline.spec.ts` — fixture Standard: Status, conteos por casilla, open list con owners, último reporte | no — Phase 5 |
| R2 | `sdd-pipeline.spec.ts` — una fixture por etapa; caso literal de `sdd-task-delegation` → `Verificación · pass 1 no convergido` | no — Phase 5 |
| R3 | `sdd-pipeline.spec.ts` — `nextStep` por etapa (incluye `/sdd-delegate <slug> next`) | no — Phase 5 |
| R4 | `sdd-pipeline.spec.ts` — un caso por código de aviso | no — Phase 5 |
| R5 | `server/tests/sdd-task-delegation.spec.ts` — la entrada de audit y `recent[0]` llevan `sdd`; `delegate.spec.ts` — `delegate` público sin `sdd` | sí, parcial — los tests de audit existen; se añade la aserción |
| R6 | `sdd-pipeline.spec.ts` — resumen sin slug con `a` 3/8 y `b` Cerrada; `claude plugin validate .` acepta `commands/sdd-status.md` | no — Phase 5 |
| R7 | `server/tests/card-model.spec.ts` — `pipelineView` con 4 features activas muestra 3, con running y `⚠ N`; `tests/conductor-card.test.tsx` — la card dibuja la línea | no — Phase 5 |
| R8 | `sdd-pipeline.spec.ts` — hash de `specs/` igual antes y después; dos llamadas devuelven el mismo JSON | no — Phase 5 |
| R9 | `card-model.spec.ts` — `rateLimitView` con el ejemplo del spec y los umbrales 80/95; `conductor-card.test.tsx` — la cabecera muestra `5h`/`7d` | no — Phase 5 |
| E1 | `sdd-pipeline.spec.ts` — slug inexistente lista los disponibles | no — Phase 5 |
| E2 | `sdd-pipeline.spec.ts` — spec sin `> Status:` → `Desconocida` + `malformed`; la otra feature se calcula | no — Phase 5 |
| E3 | `sdd-pipeline.spec.ts` — repo sin `specs/` → lista vacía y nota; `card-model.spec.ts` — sin línea | no — Phase 5 |
| E4 | `sdd-pipeline.spec.ts` — `specs/x/scope.md` sin `spec.md` no aparece, pero ordena y alimenta `scope_mismatch` | no — Phase 5 |
| E5 | `sdd-pipeline.spec.ts` — feature Small sin etapas Plan ni Tasks | no — Phase 5 |
| E6 | `sdd-pipeline.spec.ts` — sin `state.json` → nota y sin `orphan_claim`; `card-model.spec.ts` — fallback a `specProgress` | no — Phase 5 |
| E7 | `sdd-pipeline.spec.ts` — `recent` con `taskId` inexistente → sin aviso | no — Phase 5 |
| E8 | `sdd-pipeline.spec.ts` — todo cerrado sin reportes → `sin reporte` | no — Phase 5 |
| E9 | `sdd-pipeline.spec.ts` — 50 fixtures en < 1000 ms | no — Phase 5 |
| E10 | `sdd-pipeline.spec.ts` — fixture en español, solo anclas en inglés | no — Phase 5 |
| E11 | `sdd-pipeline.spec.ts` — el JSON no contiene el texto de `Do`/`Files` ni contenido de código | no — Phase 5 |
| E12 | `card-model.spec.ts` — `rateLimits: []` → `usage —` | no — Phase 5 |
| E13 | `card-model.spec.ts` — sin `resetsAt` y `percentUsed: 112` | no — Phase 5 |
| E14 | `conductor-card.test.tsx` — placement `below` → ventanas en línea propia | no — Phase 5 |
| SC1 | Manual: `/sdd-status` en este repo | no — Phase 7 |
| SC3 | Manual: comparar la card con `/usage` en la máquina del usuario | no — Phase 7 |

## Data changes, delivery & dependencies

- **Data changes**: campo opcional `sdd` en las líneas JSONL del audit y en `state.json → recent[]`; compatible hacia atrás (los lectores ignoran el campo, las entradas viejas no lo tienen).
- **Delivery**: — ships with the normal release (sin config nueva)
- **Dependencies**: — none

## Risks

| Risk | Mitigation |
|---|---|
| `$.mcp.call` desde el mod no llega al servidor del plugin (nombre distinto, servidor no conectado al arrancar) | `$.mcp.connect("multi-provider")` devuelve el nombre real; cualquier fallo cae a la línea actual con `specProgress` (E6). Se verifica en Phase 7 con `claude --plugin-dir .` |
| Una llamada MCP cada 15 s compite con las herramientas de Claude | Se salta si hay una llamada anterior pendiente; E9 acota el coste a < 1 s con 50 features |
| El formato del `## Verification reports` cambia en spec-driven | Solo se leen las anclas `### Verification report — … — pass N` y `Converged:`; si no se encuentran, el subestado es `sin reporte` y queda una nota |
| `rateLimits` vacío en planes sin ventanas (API key, gateway) | E12: `usage —`, sin errores |
| El campo `sdd` en `DelegateParams` se filtra a la herramienta pública | El esquema zod de `delegate` no lo declara; un test lo comprueba (R5) |

## Requirement coverage

| Requirement | Covered by |
|---|---|
| R1 | C1 |
| R2 | C1 |
| R3 | C1, C3 |
| R4 | C1 |
| R5 | C2 |
| R6 | C3, C6 |
| R7 | C4 |
| R8 | C1 |
| R9 | C5 |
| E1 | C1 |
| E2 | C1 |
| E3 | C3, C4 |
| E4 | C1 |
| E5 | C1 |
| E6 | C1, C4 |
| E7 | C1, C2 |
| E8 | C1 |
| E9 | C3, C4 |
| E10 | C1 |
| E11 | C1 |
| E12 | C5 |
| E13 | C5 |
| E14 | C5 |
