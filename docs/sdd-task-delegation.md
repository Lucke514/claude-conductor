<!-- Status enum: active | deprecated -->

# Delegación de tareas SDD

> Spec history: [../specs/sdd-task-delegation/](../specs/sdd-task-delegation/)
> Status: active
> Last updated: 2026-10-18

## What it does

Delega a Codex o Antigravity **una tarea concreta** (`T#` o `G#`) del `tasks.md` de una feature escrita con [spec-driven](https://github.com/Lucke514/spec-driven). El brief del worker sale de los artefactos aprobados (la tarea, sus `R#`/`E#` y su componente `C#`), no de la conversación. El resultado vuelve verificado con el `Verify` de la propia tarea y los quality gates del plan. Sirve cuando una feature está en la fase de implementación y quieres que un worker haga una tarea mientras tú revisas el diff.

## Usage

```text
/sdd-delegate sdd-guardrails next codex
```

Reclama la primera tarea abierta y sin owner, la delega a Codex en modo write y te presenta el diff, la verificación y los veredictos por criterio. Para investigar sin tocar archivos:

```text
/sdd-delegate sdd-guardrails T2 agy --read
```

Las herramientas MCP por debajo, en el orden en que el comando las usa:

```text
sdd_task_claim    { "slug": "sdd-guardrails", "task": "next", "provider": "codex" }
git commit -m "sdd-guardrails: claim T1" -- specs/sdd-guardrails/tasks.md      ← lo ejecuta Claude
sdd_task_delegate { "slug": "sdd-guardrails", "task": "T1" }
delegation_apply  { "worktreePath": "…" }     o   delegation_discard + sdd_task_release
```

## Interface

### `/sdd-delegate <slug> <T#|G#|next> [codex|antigravity|agy|auto] [--read]`

- **Input**: el slug es una carpeta de `specs/`; la tarea es un id o `next`; proveedor por defecto `auto`; modo por defecto write, `--read` para modo read.
- **Returns**: el resumen del worker, los archivos cambiados, la verificación y los veredictos, con los siguientes pasos (aplicar o descartar).
- **Errors**: los de las herramientas, mostrados tal cual; el comando nunca edita los artefactos para esquivarlos.

### `sdd_task_claim({ slug, task, provider? })`

- **Input**: `task` = `T#`, `G#` o `next` (primera tarea `- [ ] Done` con `**Owner**: —`, en orden de documento). `provider` = `codex`, `antigravity` o `auto` (por defecto): el routing por palabras clave sobre el título y el `Do`, y si no hay regla, el primer proveedor de la cadena.
- **Returns**: `{ slug, taskId, title, provider, owner, tasksFile, commit, nextSteps }`. `owner` es `<proveedor> (multi-provider) since YYYY-MM-DD`, ya escrito en tu árbol. `commit` es el comando exacto del claim; con pathspec, incluye solo el archivo de tareas aunque tengas otros cambios.
- **Errors** (`code` en la respuesta de error): `FEATURE_NOT_FOUND` (lista los slugs disponibles), `TASK_NOT_FOUND` / `NO_OPEN_TASK` (listan las tareas abiertas y su owner), `UNKNOWN_REFERENCE` (la tarea cita un `R#`/`E#`/`C#` que no existe), `NOT_APPROVED` (nombra el artefacto y su Status), `TASK_CLOSED` (`[x]`, `[~]`, `[>]`, `[!]`), `TASK_CLAIMED`.

### `sdd_task_delegate({ slug, task, mode?, timeoutMs? })`

- **Input**: el id que devolvió el claim (`next` no se acepta); `mode` write por defecto, que pide confirmación como `delegate`.
- **Returns**: la respuesta de `delegate` (`status`, `diff`, `worktreePath`, `attempts`…) más `sdd`:
  - `verification`: por comando, `{ kind: "verify"|"gate", gate?, command, result: "pass"|"fail"|"manual", reason?, exitCode?, newFailure?, baseline?, outputTail? }`.
  - `verified`: `true` solo si el Verify y todos los gates ejecutables pasaron (los `pipeline-only` se leen después en CI).
  - `acceptance`: `[{ id, item, verdict: "met"|"not met"|"unverifiable", evidence }]`, uno por cláusula de `Acceptance` (`A1`, `A2`… partidas por `; `) y por cada `R#`/`E#` de la tarea, según la sección `## Acceptance` del worker.
  - `notesDraft`: borrador de la línea `**Notes**` con el id de la delegación y marcadores para el commit y tu revisión clean-code.
  - `handback`: presente cuando ningún proveedor completó la tarea; el Owner ya volvió a `—` y trae el `commit` del handback.
- **Errors**: `CLAIM_NOT_COMMITTED` (el claim no está en `HEAD`; no se lanzó ningún worker), además de los del claim.

### `sdd_task_release({ slug, task })`

- **Returns**: `{ released: true, previousOwner, commit }`, o `{ released: false, reason }` si ya estaba libre.

## Behavior notes

- **Nunca hay shell.** Un `Verify` o un gate con `|`, `&&`, `;`, redirecciones, `$`, comodines o backticks no se ejecuta: aparece como `manual` con el comando literal, para que lo ejecutes tú tras revisarlo. Escribe los `Verify` como un comando simple (`npm --prefix server test -- foo`).
- **Comparación con la baseline.** La celda Baseline del plan es una lectura humana. Un gate que falla se marca `newFailure: true` solo si su baseline registra cero fallos (`0 failed`, `154 passed (154)`, `exit 0`…). Si la baseline registra fallos preexistentes, flakies o `not measured`, queda `"compare"` con la celda citada: la herramienta nunca afirma "sin fallos nuevos" sin certeza.
- **Owner con fallback.** El Owner nombra al proveedor reclamado. Si el fallback cae en otro, `notes` lo avisa; corrige el Owner en el commit que aplica el trabajo.
- **Verify fallido.** El diff se queda en el worktree y la tarea sigue reclamada hasta que apliques o descartes.
- **Archivos.** Los de `Files` se incrustan con los límites de `delegate`. Uno que no existe aparece como "does not exist yet — to be created". Los secretos (`.env`, claves, credenciales) nunca entran: aparecen como excluidos.
- **Features Small.** Sin `plan.md` ni `tasks.md`, las tareas, los gates y el Status se leen del `## Tasks` del `spec.md`.
- **Idioma.** Solo las anclas de la plantilla deben estar en inglés (`## T1`, `**Owner**`, `> Status:`); el resto se copia tal cual.
- **Lo que no hace.** No marca casillas, no escribe `Notes`, no cambia ningún Status, no hace commits y no impide que el worker toque `specs/` (eso es `sdd-guardrails`).

## Operating

- **Signal**: la sección `sdd.verification` de cada respuesta y la línea `**Notes**` de la tarea delegada; en el historial, `git log -- specs/<slug>/tasks.md` muestra el commit `<slug>: claim T#` antes del commit que aplica el trabajo.
