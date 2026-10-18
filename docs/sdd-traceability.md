<!-- Status enum: active | deprecated -->

# Pipeline y trazabilidad SDD

> Spec history: [../specs/sdd-traceability/](../specs/sdd-traceability/)
> Status: active
> Last updated: 2026-10-18

## What it does

Muestra en qué etapa está cada feature escrita con [spec-driven](https://github.com/Lucke514/spec-driven), sin abrir sus artefactos: Spec → Plan → Tasks → Implementación → Verificación → Cerrada. La etapa se deduce de `spec.md`, `plan.md`, `tasks.md` y del último reporte de verificación, sin LLM. Cada feature trae un siguiente paso sugerido y avisos cuando sus artefactos se contradicen.

Además, cada delegación de `sdd_task_delegate` queda asociada a su feature y tarea en el log de auditoría y en `state.json`. La conductor card muestra el avance y el usage de Claude Code.

## Usage

```text
/sdd-status
/sdd-status sdd-traceability
```

Sin argumento, una línea por feature:

```text
sdd-task-delegation  ✓ Spec ✓ Plan ✓ Tasks ✓ Implementación ▸ Verificación · Cerrada   8/8
                     → Resolver lo que falta para converger (awaiting the user's decision on R10/SC1 …)
sdd-guardrails       ✓ … ▸ Cerrada   7/7
sdd-traceability     ✓ Spec ✓ Plan ✓ Tasks ▸ Implementación · Verificación · Cerrada   6/7 · T7 claude
```

Con slug, el estado completo: Status de cada artefacto, tareas abiertas con su owner, último reporte, avisos y siguiente paso. La herramienta por debajo:

```text
sdd_feature_status {}                              → { features: [...], notes: [...] }
sdd_feature_status { "slug": "sdd-traceability" }  → el estado completo de esa feature
```

## Interface

### `/sdd-status [slug]`

- **Input**: opcional, una carpeta de `specs/`.
- **Returns**: el pipeline dibujado con `✓` (etapa pasada), `▸` (actual) y `·` (pendiente), el progreso, los avisos explicados y el siguiente paso.
- **Errors**: un slug inexistente se muestra con la lista de features disponibles.
- Nunca ejecuta el siguiente paso, marca casillas, edita artefactos ni cambia un Status.

### `sdd_feature_status({ slug? })`

Solo lectura y sin confirmación.

- **Sin `slug`**: `{ features: FeatureSummary[], notes: string[] }`. Las features van ordenadas por el `Rank` de un `scope.md` de `specs/` y luego por nombre.
  - `FeatureSummary` es `{ slug, stage, substage?, closed, total, current?: { id, owner }, warnings, nextStep }`.
  - `closed` cuenta `[x]`, `[~]` y `[>]`.
  - `current` es la tarea abierta reclamada o, si no hay, la primera libre.
  - Sin `specs/`, `features` viene vacío y `notes` dice `["no SDD features"]`.
- **Con `slug`**: `{ slug, depth, statuses: { spec, plan?, tasks? }, stage, substage?, tasks: { open, done, waived, deferred, blocked, total, openList: [{ id, owner }] }, verification?: { pass, converged, verdicts, pending? }, nextStep, warnings: [{ code, detail, taskId? }], notes }`.
- **Errors** (`code`): `FEATURE_NOT_FOUND` (lista los slugs disponibles) e `INVALID_SLUG`.

**Etapas**: aplica la primera de esta lista que se cumple.

| Etapa | Cuándo |
|---|---|
| `Cerrada` / `Descartada` | spec `implemented` / `superseded` o `abandoned` |
| `Spec` | spec no `approved` |
| `Plan` | feature Standard con `plan.md` ausente o no `approved` |
| `Tasks` | feature Standard con `tasks.md` ausente o no `approved` |
| `Implementación` | queda alguna tarea abierta o bloqueada |
| `Verificación` | todo cerrado y spec sin `implemented`; `substage`: `sin reporte`, `pass N no convergido` o `convergido` |
| `Desconocida` | algún artefacto sin `> Status:` legible (aviso `malformed`) |

Una feature Small (tareas en el `## Tasks` del `spec.md`) no pasa por `Plan` ni `Tasks`. Con `Converged: no — <motivo>`, el motivo aparece en `verification.pending` y en el siguiente paso.

**Avisos**:

| `code` | Cuándo |
|---|---|
| `ready_to_close` | verificación convergida y spec sin `implemented` |
| `orphan_claim` | tarea abierta reclamada por un proveedor, sin worktree `mp/*` vivo para ella ni delegación entre las últimas 8 de `state.json` |
| `closed_with_open_tasks` | spec `implemented` con tareas abiertas o bloqueadas |
| `scope_mismatch` | la fila del `scope.md` no corresponde a la etapa (`pending` ↔ Spec, `in-progress` ↔ Plan…Verificación, `done` ↔ Cerrada) |
| `violations` | una delegación de la tarea tuvo violaciones de guardrails (`specs_modified`, `worker_push`, `outside_task_files`…); solo se expone el tipo |
| `malformed` | un artefacto sin `> Status:` legible; las demás features se siguen calculando |

### Campo `sdd` en audit y state

Cada delegación de `sdd_task_delegate` lleva `sdd: { slug, taskId }`:
- en su línea de `~/.claude/multi-provider/logs/YYYY-MM-DD.jsonl`;
- en `recent[]` de `~/.claude/multi-provider/state.json`, que guarda también sus `violations`;
- en el `WorktreeMeta` de su worktree.

Un `delegate` normal no lo lleva. Solo se guardan esos dos identificadores.

### Conductor card

- **Línea SDD**: hasta 3 features en Implementación o Verificación, con el formato `sdd-traceability ▸ Impl 5/7 · codex T6 ⏳ · ⚠ 1`. La tarea en curso aparece mientras corre su `sdd_task_delegate`, con el proveedor que nombra su Owner. Si la línea no cabe, se acorta el slug y nunca la etapa, la tarea ni los avisos.
  - La card llama a `sdd_feature_status` cada 15 s por `$.mcp.call`, con la misma lógica que `/sdd-status`.
  - Si el servidor no responde, vuelve a la tarjeta anterior leída de `tasks.md`.
- **Usage**: junto a modelo, ctx y costo, cada ventana de rate limit de Claude Code: `5h ▮▮▮▯▯▯ 42% · 2h10m`, `7d …` y `gasto` si aplica.
  - Tono `warn` desde 80 % y `error` desde 95 %; sin lectura, `usage —`.
  - En la card angosta, como el panel lateral, van en una línea propia.
  - Se actualiza con `session.measure`, sin consultar la API.

## Behavior notes

- **Solo lectura.** Nada de esto escribe en `specs/`: el siguiente paso es una sugerencia, y cerrar una feature o liberar un claim sigue siendo tuyo (`sdd_task_release`, editar el Status).
- **Directorios sin `spec.md`** (como `specs/sdd-integration/`, que solo tiene `scope.md`) no son features. Su `scope.md` se usa para ordenar y para `scope_mismatch`.
- **Sin `state.json`** o con uno corrupto, el estado se calcula igual, con la nota `delegation state unavailable`, y `orphan_claim` no se evalúa.
- **Idioma.** Solo las anclas de la plantilla se leen en inglés (`> Status:`, `## T#`, `**Owner**`, `### Verification report — … — pass N`, `Converged:`); el resto se copia tal cual.
- **Rendimiento.** El resumen de 50 features responde en menos de 1 s.

## Operating

- **Signal**: `/sdd-status` en el repo y el campo `sdd` de las líneas del log de auditoría (`grep '"sdd"' ~/.claude/multi-provider/logs/*.jsonl`).
