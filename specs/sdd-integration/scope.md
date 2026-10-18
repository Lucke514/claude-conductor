<!-- Row Status enum: pending | in-progress | done | deferred | abandoned -->

# Scope: Integración de spec-driven (SDD) en multi-provider

> Last updated: 2026-10-18

Integrar el flujo de [spec-driven](https://github.com/Lucke514/spec-driven) en el plugin `multi-provider`, para que las delegaciones a Codex y Antigravity operen sobre los artefactos SDD (spec, plan, tasks) en lugar de prompts sueltos. El usuario aprobó la división y el orden el 2026-10-18.

| Slug | Responsibility | Depends-on | Rank | Status |
|---|---|---|---|---|
| sdd-task-delegation | Delegar una tarea `T#`/`G#` de `tasks.md` con un brief construido desde spec, plan y tasks, verificarla con su `Verify` y los gates del plan, y registrar el claim del `Owner` | — | 1 | in-progress |
| sdd-guardrails | Impedir que la auto-delegación (`/mp-auto`) delegue trabajo no trivial sin spec y tasks aprobados, impedir que los workers toquen `specs/`, marcar como spec drift los diffs que salen de los `Files` de la tarea, y quitar al worker las credenciales de git y GitHub para que no pueda hacer push ni abrir PRs | sdd-task-delegation | 2 | done |
| sdd-cross-review | Pedir una segunda opinión en modo read a otro proveedor: red team del spec (fases 1–2) y Audit mode independiente en la fase 7, que Claude reconcilia | — | 3 | pending |
| sdd-parallel-dispatch | Repartir los grupos `[P]` de `tasks.md` entre proveedores a la vez, cada uno en su worktree | sdd-task-delegation | 4 | pending |
| sdd-traceability | Pipeline de etapas por feature (Spec → Plan → Tasks → Implementación → Verificación → Cerrada) deducido de los artefactos, con avisos de incoherencia y siguiente paso (`sdd_feature_status`, `/sdd-status`); registrar `slug` y `taskId` en el log de auditoría y en `state.json`, y mostrar el avance en la conductor card | sdd-task-delegation | 5 | done |
| sdd-packaging | Publicar spec-driven como plugin en este marketplace y declararlo dependencia de `multi-provider` | — (requiere acceso de escritura a `Lucke514/spec-driven`) | 6 | pending |
