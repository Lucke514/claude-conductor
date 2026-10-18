<!-- Status enum: draft | in-review | approved | implemented | superseded | abandoned -->

# Spec: Pipeline y trazabilidad SDD

> Status: approved
> Owner: Lucas Gonzalez Espinosa (@Lucke514)
> Sign-off: — the session's user holds all of these
> Tracking: — this project tracks work in the repo only
> Last updated: 2026-10-18

## Objective

Saber en qué etapa está cada feature SDD sin abrir sus artefactos a mano, y relacionar cada delegación con la tarea que implementa:
- una vista de pipeline por feature (Spec → Plan → Tasks → Implementación → Verificación → Cerrada) deducida de `spec.md`, `plan.md`, `tasks.md` y el último reporte de verificación;
- avisos cuando los artefactos se contradicen (todo cerrado pero el spec sin `implemented`, claims huérfanos, scope desalineado);
- `slug` y `taskId` registrados en el log de auditoría y en `state.json`, y el avance visible en la conductor card;
- el usage de Claude Code (ventanas de rate limit de 5 h y 7 días) visible en la conductor card, que en modo lado tapa la status line.

Hoy el estado de una feature solo se conoce leyendo sus archivos: en este mismo repo `sdd-task-delegation` tiene las 8 tareas en `[x]` pero su verificación no convergió, y nada lo muestra. Además, `sdd-parallel-dispatch` necesita este estado (qué tareas están libres, reclamadas o en curso) para repartir trabajo.

## Users & scenarios

- **Desarrollador que retoma el trabajo**: como dueño del repo, al abrir una sesión quiero ver qué features están en curso, en qué etapa y cuál es el siguiente paso, sin leer cada `tasks.md`.
- **Claude como orquestador**: como Claude, antes de delegar o cerrar una tarea quiero consultar el estado de la feature con una herramienta, en lugar de parsear los artefactos en la conversación.
- **Revisor que busca incoherencias**: como revisor, quiero que se marque cuando los artefactos se contradicen (tareas cerradas con el spec abierto, un `Owner` sin delegación viva, una fila del scope que no coincide con la feature).
- **Auditoría**: como dueño del repo, quiero saber qué delegaciones del log pertenecen a qué tarea de qué feature.
- **Usuario con la card al lado**: como usuario con `/conductor lado`, quiero ver en la card cuánto llevo usado de mis límites de Claude Code y cuándo se reinician, porque en ese modo no tengo otro lugar donde verlo.
- **Surfaces**: API o contrato (herramienta MCP `sdd_feature_status`, campo `sdd` en audit y `state.json`) · CLI (slash command `/sdd-status`) · UI (línea SDD y línea de usage en la conductor card).
- **Operational criteria** — una `R#`/`E#`/`SC#` o `non-goal` por ítem:
  - Load & volume: E9 · Text & locale: E10 · Operational signal: SC1 · Degradation: E2, E6 · Partial failure: E2, E6
  - Accessibility: R7 (el estado se entiende sin color: etapa y avisos en texto)
- **Sensitive ground**: la feature lee artefactos del repo y el log de auditoría, que ya excluye prompts, contenidos y diffs.
  - Access control: non-goal (se ejecuta con los permisos del usuario local) · Traceability: R5 · Data handling: E11 · Data lifecycle: non-goal (reutiliza la retención actual de logs y de `state.json`) · Repeat-request correctness: R8

## Requirements

- **R1** — Para una feature `specs/<slug>/`, el estado se calcula solo a partir de sus artefactos y de `state.json`, de forma determinista y sin LLM, e incluye:
  - el `Status` de cada artefacto existente;
  - la profundidad (`small` | `standard`);
  - el conteo de tareas por estado de casilla (abiertas, `[x]`, `[~]`, `[>]`, `[!]`) y la lista de tareas abiertas con su `Owner`;
  - el último reporte de verificación (número de pass, `Converged`, conteo de `R#`/`E#` por veredicto);
  - la etapa (R2), los avisos (R4) y el siguiente paso sugerido (R3).
- **R2** — La etapa es la primera que aplica de esta lista:
  1. `Cerrada` si el spec está `implemented`; `Descartada` si está `superseded` o `abandoned`;
  2. `Spec` si el spec no está `approved`;
  3. `Plan` si la feature es Standard y `plan.md` falta o no está `approved`;
  4. `Tasks` si la feature es Standard y `tasks.md` falta o no está `approved`;
  5. `Implementación` si queda alguna tarea abierta o bloqueada;
  6. `Verificación` en otro caso (todas las tareas cerradas y el spec aún no `implemented`), con el subestado `sin reporte`, `pass N no convergido` o `convergido`.

  En una feature Small se omiten `Plan` y `Tasks`.
  - Given `sdd-task-delegation` como está en este repo (spec `approved`, 8 tareas `[x]`, reporte pass 1 `Converged: no`), when se calcula su estado, then la etapa es `Verificación` con subestado `pass 1 no convergido`.
- **R3** — Cada estado trae un siguiente paso en texto, derivado de la etapa: aprobar el artefacto pendiente, `/sdd-delegate <slug> next` cuando hay tareas libres, resolver lo que falta para converger, o marcar el spec `implemented` cuando la verificación convergió. Es solo una sugerencia: nada se ejecuta.
- **R4** — El estado incluye avisos cuando se cumple alguno de estos casos:
  - `ready_to_close`: verificación convergida y spec sin `implemented`;
  - `orphan_claim`: tarea abierta con `Owner` de un proveedor y sin delegación en curso ni reciente para ese `taskId` en `state.json`;
  - `closed_with_open_tasks`: spec `implemented` con tareas abiertas;
  - `scope_mismatch`: la fila de la feature en un `scope.md` de `specs/` tiene un `Status` que no corresponde a la etapa (p. ej. `done` y etapa `Implementación`);
  - `violations`: delegaciones de la feature con violaciones de guardrails (`specs_modified`, `worker_push`, drift), con su `taskId`.
- **R5** — `sdd_task_delegate` registra `sdd: { slug, taskId }` en la entrada del log de auditoría y en la delegación reciente de `state.json`. `delegate` no lo registra. Solo se guardan esos dos identificadores.
- **R6** — Herramienta MCP `sdd_feature_status`:
  - con `slug`, devuelve el estado completo de R1;
  - sin `slug`, devuelve un resumen por feature (slug, etapa, progreso de tareas, número de avisos), ordenado por el rank del `scope.md` si existe y si no por nombre.

  Slash command `/sdd-status [slug]`, que muestra lo mismo formateado como pipeline.
  - Given un repo con `specs/a/` en `Implementación` (3/8) y `specs/b/` `Cerrada`, when se llama sin `slug`, then el resultado lista las dos con su etapa y `3/8` para `a`.
- **R7** — La línea SDD que la conductor card ya muestra (hoy una sola feature con su progreso de tareas, `pickActiveSpec`) pasa a mostrar una línea por feature en `Implementación` o `Verificación`, como máximo 3, con etapa, progreso, la tarea en curso con su proveedor si hay una delegación viva, y `⚠ N` si hay avisos. La etapa y los avisos se leen en texto, no solo por color. Sin features activas, la línea no aparece.
- **R8** — Calcular el estado nunca escribe en `specs/` ni cambia ningún `Status`, casilla u `Owner`. Dos llamadas seguidas sin cambios en los artefactos devuelven el mismo resultado.

- **R9** — La cabecera de sesión de la conductor card, junto a modelo, ctx y costo, muestra cada ventana de rate limit que reporta `$.session.usage().rateLimits` (`five_hour` como `5h`, `seven_day` como `7d`, `spend_limit` como `gasto`): porcentaje usado con barra y tiempo hasta el reinicio (`resetsAt`). Se actualiza con `session.measure`, sin sondear la API.
  - Given `rateLimits` = `[{ kind: "five_hour", percentUsed: 42, resetsAt: <en 2 h 10 m> }, { kind: "seven_day", percentUsed: 18.5, ... }]`, when se dibuja la card, then se lee `5h ▮▮▮▯▯▯ 42% · 2h10m` y `7d ▮▯▯▯▯▯ 18.5%`.
  - Con 80 % o más, la ventana se dibuja en tono `warn`; con 95 % o más, en `error`. El porcentaje va siempre en texto.

**Minimum shippable**: R1, R2, R3, R4, R6, R8, R9, E1, E2, E3, E12.

## Non-goals

- Ejecutar los pasos sugeridos o corregir los avisos (marcar `implemented`, liberar claims, editar el scope): siguen siendo decisiones del usuario o de Claude con los comandos existentes.
- Repartir tareas en paralelo (`sdd-parallel-dispatch`), aunque esa feature consuma este estado.
- Un historial temporal de etapas (cuándo pasó cada feature de una a otra).
- Leer tareas o specs de otros repos o de un tracker externo.

## Edge cases & error behavior

- **E1** — Cuando el `slug` no existe, la respuesta es un error con la lista de slugs disponibles.
- **E2** — Cuando un artefacto no tiene `> Status:` o no se puede leer, la etapa es `Desconocida`, con un aviso `malformed` que nombra el archivo. Las demás features se siguen calculando.
- **E3** — Cuando el repo no tiene `specs/`, la herramienta devuelve una lista vacía con la nota "no SDD features" y la card no muestra la línea.
- **E4** — Un directorio de `specs/` sin `spec.md` (como `specs/sdd-integration/`, que solo tiene `scope.md`) no es una feature: no aparece en la lista, pero su `scope.md` se usa para R4 y para el orden de R6.
- **E5** — En una feature Small, las tareas y el `Status` se leen del `## Tasks` del `spec.md`, igual que en `sdd-task-delegation` E7.
- **E6** — Cuando `state.json` falta o está corrupto, el estado se calcula igual sin la información de delegaciones vivas, con la nota "delegation state unavailable", y `orphan_claim` no se evalúa.
- **E7** — Una delegación registrada con un `taskId` que ya no existe en `tasks.md` se ignora para la etapa y no genera aviso.
- **E8** — Sin sección `## Verification reports` o sin reportes, el subestado de `Verificación` es `sin reporte`.
- **E9** — Con hasta 50 features, el resumen sin `slug` responde en menos de 1 s, y la card no lee artefactos en cada render.
- **E10** — Solo las anclas de la plantilla se leen en inglés (`> Status:`, `## T#`, `**Owner**`, `Converged:`); el resto del texto puede estar en cualquier idioma y se copia tal cual.
- **E11** — El estado y la card no incluyen contenido de archivos de código, prompts ni diffs: solo identificadores, Status, conteos y los textos de las anclas.
- **E12** — Cuando `rateLimits` está vacío (todavía no hubo respuesta de la API, o el host no informa límites) o `$.session.usage()` falla, la cabecera muestra `usage —` y el resto de la card no cambia.
- **E13** — Una ventana sin `resetsAt` se muestra sin tiempo de reinicio. Un `percentUsed` mayor que 100 (gasto excedido) se muestra tal cual, con la barra llena.
- **E14** — En la banda de abajo (`/conductor abajo`), angosta, las ventanas van en una línea propia debajo de la cabecera en lugar de compartir la de modelo y ctx.

## Decisions

- 2026-10-18 El usuario decidió fusionar el pipeline de etapas con `sdd-traceability` en lugar de abrir un slug nuevo — porque las dos features compartían superficie (card, `state.json`, audit).
- 2026-10-18 El usuario pidió incluir aquí el usage de Claude Code en la card (R9), aunque no es SDD — porque en modo lado la card tapa la status line y comparten la misma cabecera de sesión.
- 2026-10-18 Q1: el pipeline solo informa; las acciones sugeridas no se ejecutan (R3, R8) — propuesta por defecto aceptada por el usuario.
- 2026-10-18 Q2: la card refresca la etapa desde `specs/` cada 15 s con la misma lógica que el servidor, y toma de `state.json` solo las delegaciones vivas — propuesta por defecto aceptada por el usuario.
- 2026-10-18 Q3: una delegación es "reciente" para `orphan_claim` mientras está entre las últimas `MAX_RECENT` (8) de `state.json` — propuesta por defecto aceptada por el usuario.
- 2026-10-18 Spec aprobado por el usuario.
- 2026-10-18 Plan aprobado por el usuario; Q2 se realiza con la card llamando a `sdd_feature_status` vía `$.mcp.call` (una sola implementación), porque el sandbox de mods no puede importar código del servidor.
- 2026-10-18 Tasks aprobadas por el usuario.
- 2026-10-18 R9: el ejemplo pasa de `▮▮▮▮▯▯` a `▮▮▮▯▯▯` para el 42 % — el original estaba mal calculado; la barra es el `bar()` de la card (6 × 0,42 = 2,5 → 3).

## Open questions

- Ninguna.

## Success criteria

- **SC1** — En este repo, `sdd_feature_status` sin `slug` reporta `sdd-guardrails` como `Cerrada` y `sdd-task-delegation` como `Verificación · pass 1 no convergido`, con un siguiente paso que nombra la decisión pendiente sobre R10/SC1 · **Signal**: la respuesta de la herramienta · **Read at**: una sesión de Claude Code en este repo · **Emitted by**: R6.
- **SC2** — Cada entrada del log de auditoría producida por `sdd_task_delegate` lleva `sdd.slug` y `sdd.taskId` · **Signal**: `~/.claude/multi-provider/logs/*.jsonl` · **Read at**: la máquina del usuario · **Emitted by**: R5.
- **SC3** — Con `/conductor lado` activo, después del primer turno de una sesión con plan de suscripción, la card muestra `5h` y `7d` con los mismos porcentajes que `/usage` · **Signal**: la card y `/usage` · **Read at**: la máquina del usuario · **Emitted by**: R9.
