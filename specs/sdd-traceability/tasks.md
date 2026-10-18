<!-- Status enum: draft | in-review | approved | abandoned -->

# Tasks: Pipeline y trazabilidad SDD

> Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md)
> Status: approved
> Last updated: 2026-10-18

Una tarea = una sesión. Hecha significa:
- su **Verify** pasa;
- los gates del plan pasan sin fallos nuevos contra su baseline (`npm --prefix server run typecheck`, `npm --prefix server test`, `claude plugin validate .`, `claude plugin test .`);
- `server/dist` está reconstruido y committeado si la tarea toca `server/src`;
- el diff está limpio.

Commits con prefijo `sdd-traceability: `, solo de Claude y sin trailers de atribución.

Orden: T1, T3 y T4 pueden correr a la vez (no comparten archivos); T2 espera a T1; T5 espera a T2; T6 espera a T4 y T5 (comparte archivos de la card con T4); T7 va al final.

## T1 [P] — Lectura tolerante y parsers de reportes y scope

- [x] Done
- **Owner**: —
- **Component**: C1 · **Implements**: E2, E4, E8, E10
- **Files**: `server/src/sdd/artifacts.ts`, `server/tests/sdd-artifacts.spec.ts`, `server/tests/sdd-fixtures.ts`
- **Do**: En `artifacts.ts`, añadir:
  - `readFeatureArtifacts(projectDir, slug)`, que devuelve `{ spec?, plan?, tasks?, depth }` sin lanzar por la ausencia de `plan.md` o `tasks.md`. `loadFeature` pasa a usarla, con el mismo contrato y los mismos errores.
  - `parseVerificationReports(md)`, que lee las anclas `### Verification report — … — pass N`, la línea `Converged: yes|no …` y el conteo de veredictos de la primera columna `Verdict` de su tabla.
  - `parseScope(md)`, que lee las filas `| Slug | … | Rank | Status |` de un `scope.md`.

  Solo se interpretan las anclas en inglés (E10).
- **Acceptance**: Una feature Standard con solo `spec.md` se lee sin error; `loadFeature` sigue lanzando `FEATURE_NOT_FOUND` en ese caso; el reporte de `specs/sdd-task-delegation/tasks.md` (copiado como fixture) da `pass 1`, `converged: false`; sin sección de reportes devuelve `[]` (E8); `parseScope` del `scope.md` real devuelve 6 filas con rank y Status; un spec sin `> Status:` se distingue de `draft` (E2); `sdd-artifacts.spec.ts` existente sigue pasando.
- **Verify**: `npm --prefix server test -- sdd-artifacts`
- **Notes**: Delegada a codex (delegación 20261018045707-be6d62). En `server/src/sdd/artifacts.ts`: `readFeatureArtifacts` (`loadFeature` la usa con el mismo contrato), `parseVerificationReports` y `parseScope`. En `server/tests/sdd-artifacts.spec.ts`, 7 casos con fixtures `DELEGATION_REPORT`/`INTEGRATION_SCOPE` en `sdd-fixtures.ts`. Gates: typecheck 0 errores, 207 passed (200 + 7), plugin validate ok, plugin test 7 pass. La verificación del worker falló solo porque el worktree no tenía `node_modules`; se corrió a mano en el worktree y se añadió `isolation.symlink` al proyecto. Clean-code: el conteo de veredictos con `Object.defineProperty` pasó a `Map` + `Object.fromEntries` · close calls: el fixture `DELEGATION_REPORT` copia el reporte entero — se queda, es lo que pide A3

## T2 — Pipeline de etapas

- [x] Done
- **Owner**: —
- **Component**: C1 · **Implements**: R1, R2, R3, R4, R8, E1, E2, E5, E6, E7, E8, E10, E11
- **Files**: `server/src/sdd/pipeline.ts`, `server/tests/sdd-pipeline.spec.ts`, `server/tests/sdd-fixtures.ts`
- **Do**: Implementar `featureStatus(projectDir, slug, recent?)` y `listFeatureStatus(projectDir, recent?)` según C1:
  - etapas en el orden de R2, con el subestado de `Verificación`;
  - `nextStep` por etapa (R3);
  - avisos `ready_to_close`, `orphan_claim` (contra `recent`, Q3), `closed_with_open_tasks`, `scope_mismatch`, `violations` y `malformed` (R4, E2);
  - orden por el rank de `scope.md` y luego por nombre;
  - un directorio sin `spec.md` no cuenta como feature (E4);
  - sin `recent`, se añade la nota "delegation state unavailable" y no se evalúa `orphan_claim` (E6).

  No escribe ningún archivo (R8). La salida no incluye texto de `Do`/`Files` ni contenido de código (E11).
- **Acceptance**:
  - una fixture por etapa da la etapa esperada;
  - la copia de `sdd-task-delegation` da `Verificación · pass 1 no convergido`;
  - la copia de `sdd-guardrails` da `Cerrada`;
  - cada código de aviso tiene un caso que lo produce y uno que no;
  - una feature Small no pasa por `Plan` ni `Tasks`;
  - un slug inexistente lista los disponibles;
  - `specs/` tiene el mismo hash antes y después, y dos llamadas devuelven el mismo JSON.
- **Verify**: `npm --prefix server test -- sdd-pipeline`
- **Notes**: Delegada a codex (delegación 20261018050508-a861e9). `server/src/sdd/pipeline.ts` (`featureStatus`, `listFeatureStatus`) y `server/tests/sdd-pipeline.spec.ts` (17 casos). Al integrar: `VerificationReport.pending` (el texto tras `Converged: no —`) pasa al `nextStep` para que nombre lo que falta (SC1). Contra este repo: `sdd-guardrails` Cerrada, `sdd-task-delegation` `Verificación · pass 1 no convergido` con la decisión R10/SC1 en el siguiente paso. Gates: typecheck 0 errores, 228 passed (211 + 17), plugin validate ok, plugin test 9 pass. El gate automático marcó `statusline.spec.ts` por `NO_COLOR` en el entorno (G2), no por T2. Clean-code: none · close calls: `PipelineDelegation` amplía `RecentDelegation` con `sdd` mientras T3 no esté integrada — se simplifica al integrar T3

## T3 [P] — `slug` y `taskId` en audit y state

- [x] Done
- **Owner**: —
- **Component**: C2 · **Implements**: R5, E7
- **Files**: `server/src/audit.ts`, `server/src/state.ts`, `server/src/delegate.ts`, `server/src/sdd/task-delegation.ts`, `server/tests/sdd-task-delegation.spec.ts`, `server/tests/delegate.spec.ts`
- **Do**:
  - Añadir `sdd?: { slug: string; taskId: string }` a `AuditEntry`, `RecentDelegation` y `DelegateParams`.
  - `delegate()` lo copia a `appendAudit` y `recordRecent`, y `sdd_task_delegate` lo rellena.
  - El esquema zod de la herramienta pública `delegate` en `index.ts` no se toca.
- **Acceptance**: Tras un `sdd_task_delegate` con el CLI falso, la última línea del JSONL de audit y `recent[0]` de `state.json` llevan `sdd: { slug, taskId }`; un `delegate` normal no lleva `sdd`; `delegate.spec.ts` y `sdd-task-delegation.spec.ts` existentes siguen pasando.
- **Verify**: `npm --prefix server test -- sdd-task-delegation delegate`
- **Notes**: Delegada a antigravity (delegación 20261018045859-13e576). El intento agotó el timeout de 10 min con el trabajo hecho y el reintento empezó de cero. Se integró el patch guardado del primer intento (`~/.claude/multi-provider/patches/20261018045859-13e576-antigravity.patch`, sin `server/dist`) y se detuvieron a mano el reintento y el fallback a codex. Archivos: `sdd?` en `AuditEntry`, `RecentDelegation` y `DelegateParams` (`delegate()` lo copia a audit y recent; `sdd_task_delegate` lo rellena), y tests en `delegate.spec.ts` y `sdd-task-delegation.spec.ts`. Al integrar: `RecentDelegation.violations` también se guarda en `state.json`, porque sin eso el aviso `violations` de T2 nunca se disparaba, y `PipelineDelegation` queda como `Partial<RecentDelegation>`. Gates: typecheck 0 errores, 230 passed, plugin validate ok, plugin test 9 pass. Clean-code: none · close calls: none

## T4 [P] — Usage de Claude Code en la card

- [x] Done
- **Owner**: —
- **Component**: C5 · **Implements**: R9, E12, E13, E14
- **Files**: `hooks/conductor/model.ts`, `hooks/conductor/card.tsx`, `types/index.d.ts`, `server/tests/card-model.spec.ts`, `tests/conductor-card.test.tsx`
- **Do**:
  - En `model.ts`, añadir `rateLimitView(limits, now)` según C5: etiquetas `5h`/`7d`/`gasto` (cualquier otro tipo usa su `kind`), barra de 6, porcentaje tal cual, reinicio con `fmtDuration`, tono `warn` desde 80 y `error` desde 95, y `usage —` sin ventanas.
  - En `card.tsx`:
    - `loadMeta` guarda `usage.rateLimits` en `SessionMeta`;
    - un `on('session.measure')` refresca `meta`;
    - la cabecera dibuja las ventanas en la línea de modelo/ctx/costo en `side` y en una línea propia en `below` (E14).
- **Acceptance**:
  - el ejemplo de R9 da `5h ▮▮▮▯▯▯ 42% · 2h10m` y `7d ▮▯▯▯▯▯ 18.5%`;
  - 80 → `warn` y 95 → `error`;
  - `[]` → `usage —`;
  - sin `resetsAt` se muestra sin tiempo de reinicio, y `112` se muestra tal cual con la barra llena (E13);
  - el test de la card muestra las ventanas en `side` y en `below`;
  - los tests existentes de la card siguen pasando.
- **Verify**: `npm --prefix server test -- card-model` · `claude plugin test .`
- **Notes**: Hecha por Claude en la sesión principal. En `hooks/conductor/model.ts`, `rateLimitView`/`rateLimitText`. En `card.tsx`: `loadMeta` guarda `rateLimits`, un `on('session.measure')` refresca ctx/costo/ventanas, y la cabecera las dibuja en la línea de modelo/ctx/costo cuando la card es ancha (≥ 100 columnas) y en una línea propia debajo cuando es angosta, que es el caso del panel lateral y de la banda angosta. `SessionMeta.rateLimits` está en `types/index.d.ts`. Tests: 4 casos en `card-model.spec.ts` y 2 en `conductor-card.test.tsx`. Gates: typecheck 0 errores, 211 passed (207 + 4), plugin validate ok, plugin test 9 pass (7 + 2). Clean-code: none · close calls: el criterio ancho/angosto usa el `wide` que ya tenía la cabecera en lugar de mirar el placement — se queda, el panel lateral (46 columnas) no cabe en una sola línea. El test de la card comprueba el texto en los tres sitios, pero no la estructura de línea propia, porque `ui.find` no ve keys de `Text` anidados

## T5 — Herramienta `sdd_feature_status` y `/sdd-status`

- [ ] Done
- **Owner**: claude (sesión principal) since 2026-10-18
- **Component**: C3 · **Implements**: R6, E3, E9
- **Files**: `server/src/index.ts`, `commands/sdd-status.md`, `server/tests/sdd-pipeline.spec.ts`
- **Do**:
  - Registrar `sdd_feature_status({ slug?, projectDir? })`: llama a `featureStatus`/`listFeatureStatus` con `recent` de `readState` y devuelve JSON. Es solo lectura y no lleva hook PreToolUse.
  - Escribir `commands/sdd-status.md`: instruye a Claude a llamarla y a dibujar el pipeline en texto (`✓` etapa pasada, `▸` actual, `·` pendiente), con progreso, avisos y siguiente paso, sin ejecutar el siguiente paso.
- **Acceptance**:
  - sin `slug`, con `a` (3/8) y `b` Cerrada, se listan las dos;
  - un repo sin `specs/` devuelve lista vacía y la nota "no SDD features" (E3);
  - 50 fixtures se resuelven en < 1000 ms (E9);
  - `claude plugin validate .` acepta el comando.
- **Verify**: `npm --prefix server test -- sdd-pipeline` · `claude plugin validate .`
- **Notes**: —

## T6 — Líneas SDD en la card

- [ ] Done
- **Owner**: —
- **Component**: C4 · **Implements**: R7, E3, E6, E9
- **Files**: `hooks/conductor/model.ts`, `hooks/conductor/card.tsx`, `types/index.d.ts`, `server/tests/card-model.spec.ts`, `tests/conductor-card.test.tsx`
- **Do**:
  - En `model.ts`, añadir `pipelineView(summary, running)`: hasta 3 features en `Implementación`/`Verificación`, con el formato `slug ▸ Impl 3/8 · codex T4 ⏳ · ⚠ 1`.
  - En `card.tsx`, `loadSpec`:
    - usa `$.mcp.connect("multi-provider")` + `$.mcp.call(server, "sdd_feature_status", {})`, y no llama si hay una llamada anterior pendiente;
    - si falla, cae a `specProgress`/`pickActiveSpec`.
  - `running` guarda el `taskId` del argumento de `sdd_task_delegate` capturado en `tool.call`.
  - El átomo `spec` pasa a contener la lista.
- **Acceptance**:
  - con 4 features activas se muestran 3;
  - con una delegación viva aparecen proveedor y tarea;
  - con avisos aparece `⚠ N`;
  - sin features activas no hay línea (E3);
  - con `$.mcp.call` rechazando se dibuja la línea de `specProgress` (E6);
  - los tests existentes de la card siguen pasando.
- **Verify**: `npm --prefix server test -- card-model` · `claude plugin test .` · manual: `claude --plugin-dir .` en este repo muestra `sdd-task-delegation ▸ Verif …`
- **Notes**: —

## T7 — Document the feature

- [ ] Done
- **Owner**: —
- **Component**: C6 · **Implements**: all (documentation)
- **Files**: `docs/sdd-traceability.md`, `README.md`, `skills/multi-provider/SKILL.md`
- **Do**:
  - Escribir `docs/sdd-traceability.md`: etapas, avisos, formato de la respuesta, campo `sdd` del audit y cabecera de usage.
  - En el README: `/sdd-status` en la tabla de comandos, la herramienta y lo nuevo de la card.
  - En el skill: consultar `sdd_feature_status` antes de `/sdd-delegate`.
- **Acceptance**: La doc describe el comportamiento real; cada ejemplo coincide con el esquema registrado en `index.ts`.
- **Verify**: comparar cada ejemplo con `server/src/index.ts` y ejecutar `/sdd-status` en este repo (SC1)
- **Notes**: —

---

## Gaps found in verification

- **G1** — `orphan_claim` marca como huérfana una tarea cuya delegación sigue en curso, porque `state.json` solo registra una delegación al terminar (visto con T3 corriendo). Se corrige en T5: la herramienta considera también los worktrees `mp/*` vivos de esa tarea.
- **G2** — `server/tests/statusline.spec.ts` ("shows not installed / no auth in red") falla cuando el entorno tiene `NO_COLOR`, porque `statusline/index.js` decide el color al cargar el módulo. Hace que el gate Tests de cada delegación salga "NEW FAILURE". Fuera del alcance de esta feature: el test debe fijar `NO_COLOR` antes de importar.
- **G3** — El brief de `sdd_task_delegate` muestra `Do: —` cuando el `**Do**` de la tarea es una lista con viñetas en las líneas siguientes (visto con T3): `parseTasks` en `server/src/sdd/artifacts.ts` solo lee el texto de la misma línea. Fuera del alcance de esta feature (`sdd-task-delegation`).

---

## Verification reports
