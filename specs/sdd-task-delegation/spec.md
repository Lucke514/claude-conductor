<!-- Status enum: draft | in-review | approved | implemented | superseded | abandoned -->

# Spec: Delegación de tareas SDD

> Status: in-review
> Owner: Lucas Gonzalez Espinosa (@Lucke514)
> Sign-off: — the session's user holds all of these
> Tracking: — this project tracks work in the repo only
> Last updated: 2026-10-18

## Objective

Permitir que Claude delegue a Codex o Antigravity **una tarea concreta** (`T#` o `G#`) del `tasks.md` de una feature SDD. El brief del worker se construye a partir de los artefactos aprobados y no de la conversación, y el resultado se verifica con la misma puerta que exige spec-driven. Hoy los workers no comparten el contexto de Claude: cada `/delegate` depende de que Claude reescriba a mano requisitos y criterios, y la verificación es genérica (`verify.commands`), no la de la tarea.

## Users & scenarios

- **Delegar la siguiente tarea**: como desarrollador con una feature en fase 5 (Implement) y su `tasks.md` aprobado, quiero pedir "delega la siguiente tarea a codex" para que un worker la implemente con los requisitos exactos y yo solo revise el diff verificado.
- **Delegar una tarea concreta**: como desarrollador, quiero delegar `T4` a Antigravity en modo read (por ejemplo, para investigar antes de implementar) y recibir su informe contra los criterios de aceptación de la tarea.
- **Reintentar una tarea devuelta**: como desarrollador, cuando descarto el diff de un worker, quiero que la tarea vuelva a quedar libre (`Owner: —`) para delegarla de nuevo o hacerla con Claude.
- **Surfaces**: API o contrato (nueva herramienta MCP y la respuesta de `delegate`) · CLI (slash command `/sdd-delegate`). No hay UI nueva: la card se trata en `sdd-traceability`.
- **Operational criteria** — una `R#`/`E#`/`SC#` o `non-goal` por ítem:
  - Load & volume: non-goal (una tarea por llamada; el paralelismo es `sdd-parallel-dispatch`) · Text & locale: E8 · Operational signal: SC1 · Degradation: E3, E7 · Partial failure: E9, E10
  - Accessibility: non-goal (sin superficie de UI)
- **Sensitive ground**: la feature incrusta en el prompt el contenido de los archivos de la tarea, que pueden incluir secretos.
  - Access control: non-goal (se ejecuta con los permisos del usuario local) · Traceability: R9 · Data handling: E5 · Data lifecycle: non-goal (el brief no se persiste fuera del log de auditoría que ya existe) · Repeat-request correctness: E6

## Requirements

- **R1** — La herramienta de delegación de tareas acepta un `slug` de feature y una referencia de tarea (`T#`, `G#` o `next`) y resuelve la tarea desde `specs/<slug>/tasks.md`.
  - Given `specs/demo/tasks.md` con `## T3 — X`, when se delega `demo` + `T3`, then la delegación usa el bloque de `T3` (Files, Do, Acceptance, Verify, Implements).
- **R2** — `next` resuelve la primera tarea, en orden de documento, cuya casilla está abierta (`- [ ] Done`) y cuyo `**Owner**` es `—`.
  - Given T1 `[x]`, T2 `[!]` bloqueada, T3 abierta y sin owner, when se pide `next`, then se delega T3.
- **R3** — El brief del worker contiene, de forma literal: el `Do`, el `Acceptance`, el `Verify` y los `Files` de la tarea; el texto completo de cada `R#`/`E#` que la tarea cita en `Implements`, tomado de `spec.md`; la sección del componente `C#` que la tarea cita, tomada de `plan.md`; y los comandos de los quality gates del plan.
  - Given T3 con `Implements: R1, E2` y `Component: C2`, when se construye el brief, then incluye los textos de R1, E2 y C2 tal como aparecen en los artefactos.
- **R4** — El brief incrusta el contenido actual de cada archivo existente listado en `Files`, con los mismos límites de tamaño y exclusiones que `delegate`; un archivo listado que aún no existe aparece como "a crear".
- **R5** — La delegación se rechaza, sin lanzar ningún worker, cuando `spec.md`, `tasks.md` o —si existe— `plan.md` no tienen `Status: approved`, o cuando la tarea está cerrada (`[x]`, `[~]`, `[>]`), bloqueada (`[!]`) o reclamada por otro owner.
  - Given `tasks.md` en `Status: in-review`, when se delega cualquier tarea, then la respuesta es un error que nombra el artefacto y su Status, y no se crea worktree.
- **R6** — Antes de que el worker arranque, la herramienta escribe en `tasks.md` del árbol de trabajo del usuario el `**Owner**` de la tarea con el proveedor y la fecha, y Claude committea ese cambio con `git commit` normal, sin `Co-Authored-By` ni ningún otro trailer de atribución (Claude es el único que hace commits: ni la herramienta ni el worker), cumpliendo la regla de claim de spec-driven.
  - Given T3 sin owner, when se delega a codex, then `tasks.md` muestra `**Owner**: codex (multi-provider) since 2026-10-18` en un commit anterior al inicio del worker.
- **R7** — En modo write, al terminar el worker se ejecuta dentro del worktree el comando `Verify` de la tarea y luego los gates del plan; la respuesta informa de cada comando (pasa o falla, con extracto de salida) y, en los gates, si la falla es nueva respecto al baseline registrado en el plan.
- **R8** — La respuesta incluye, por cada criterio del `Acceptance` y cada `R#`/`E#` de la tarea, el veredicto del worker (cumple / no cumple / no verificable) y un borrador de la línea `**Notes**` que cita el id de la delegación; la herramienta nunca marca la casilla `[x]` ni escribe `Notes` por sí misma.
- **R9** — Cuando la delegación se descarta, o cuando todos los proveedores fallan, el `**Owner**` de la tarea vuelve a `—` (handback), y la respuesta lo indica.
- **R10** — El slash command `/sdd-delegate <slug> <T#|G#|next> [codex|antigravity|auto] [--read]` usa `auto` como proveedor y modo write cuando no se indican, y ejecuta el flujo completo: comprobación, claim con commit, delegación y presentación del resultado con los siguientes pasos (aplicar, descartar).

**Minimum shippable**: R1, R3, R4, R5, R6, R7, R8, R9, E1, E2, E3, E5.

## Non-goals

- Repartir tareas `[P]` en paralelo (`sdd-parallel-dispatch`).
- Bloquear la auto-delegación sin spec, detectar spec drift o impedir que el worker edite `specs/` (`sdd-guardrails`).
- Mostrar la tarea en la conductor card o añadir `slug`/`taskId` al log de auditoría (`sdd-traceability`).
- Marcar tareas como hechas, escribir `Notes` o cambiar cualquier `Status`: eso sigue siendo decisión de Claude y del usuario tras la revisión.
- Crear o editar `spec.md`, `plan.md` o `tasks.md` más allá de la línea `**Owner**`.
- Anclas localizadas: se leen los encabezados y campos en inglés que define la plantilla de spec-driven (`## T1`, `**Owner**`, `**Implements**`...).

## Edge cases & error behavior

- **E1** — Cuando el `slug` no existe o no tiene `tasks.md`, la respuesta es un error que lista los slugs disponibles en `specs/`.
- **E2** — Cuando la referencia de tarea no existe, o `next` no encuentra ninguna tarea abierta sin owner, la respuesta es un error que lista las tareas abiertas y su owner.
- **E3** — Cuando el `Verify` de la tarea o un gate usa sintaxis de shell (pipes, `&&`, `;`, redirecciones, variables), no se ejecuta: la respuesta lo marca como "verificación manual pendiente" con el comando literal. Nunca se ejecuta a través de una shell.
- **E4** — Cuando la tarea cita un `R#`/`E#` que no está en `spec.md`, o un `C#` que no está en `plan.md`, la delegación se rechaza con un error que nombra el id inexistente (los artefactos están inconsistentes).
- **E5** — Cuando `Files` lista un archivo sensible (`.env`, credenciales, claves), su contenido no entra en el brief; el brief lo nombra como excluido.
- **E6** — Cuando se delega dos veces la misma tarea, la segunda llamada se rechaza porque la tarea ya tiene owner (R5), y no se crean dos worktrees.
- **E7** — Cuando la feature es Small (un único `spec.md` con `## Tasks` y sin `plan.md` ni `tasks.md`), las tareas, gates y Status se leen de ese `spec.md`.
- **E8** — Cuando los artefactos están escritos en otro idioma (por ejemplo, español), los textos se copian tal cual; solo las anclas de la plantilla deben estar en inglés.
- **E9** — Cuando el `Verify` falla, el diff se conserva en el worktree y la respuesta lo marca como no verificado; la tarea sigue reclamada hasta que se aplique o se descarte.
- **E10** — Cuando el árbol de trabajo tiene cambios sin commitear en `tasks.md` u otros archivos ajenos al claim, el commit de claim incluye solo `tasks.md`.

## Decisions

- 2026-10-18 La división de la integración SDD en seis capacidades y su orden fueron aprobados por el usuario — ver `specs/sdd-integration/scope.md`.
- 2026-10-18 La herramienta nunca marca `[x]` ni escribe `Notes`: devuelve un borrador — porque spec-driven exige la autorrevisión de clean-code antes de cerrar una tarea, y esa revisión la hace Claude, no el worker.
- 2026-10-18 Los comandos `Verify` y los gates se ejecutan sin shell (E3) — porque es una regla del plugin desde su origen (spawn sin shell, nunca `exec` con string interpolado).
- 2026-10-18 Solo Claude hace commits, siempre sin `Co-Authored-By` ni trailers de atribución; el commit de claim (R6) también, con `git commit` normal, y la herramienta solo escribe la línea `**Owner**` — para que el commit pase por los hooks del usuario y no exista un segundo camino que haga commits.
- 2026-10-18 R5 exige también `plan.md` en `Status: approved` cuando existe (features Standard) — porque las tareas se derivan del plan aprobado.
- 2026-10-18 `/sdd-delegate` usa `auto` como proveedor por defecto (R10) — reutiliza el routing y la cadena de fallback actuales.
- 2026-10-18 El modo por defecto es write (R10); `--read` queda para investigación — porque una tarea de `tasks.md` es trabajo de implementación.

## Open questions

- Ninguna.

## Success criteria

- **SC1** — Al menos una tarea real de una feature de este repo (por ejemplo, de `sdd-guardrails`) se delega con `/sdd-delegate` y su diff pasa su `Verify` sin que Claude tenga que reescribir requisitos en el prompt · **Signal**: la sección de verificación de la respuesta de la herramienta y la línea `Notes` de esa tarea · **Read at**: `specs/<slug>/tasks.md` en este repo · **Emitted by**: el componente de verificación de esta feature (se define en el plan).
- **SC2** — Ninguna delegación de tarea arranca un worker sin un claim committeado · **Signal**: `git log -- specs/<slug>/tasks.md` muestra el commit de claim antes del commit que aplica el trabajo · **Read at**: historial git de este repo · **Emitted by**: el flujo de `/sdd-delegate` (se define en el plan).
