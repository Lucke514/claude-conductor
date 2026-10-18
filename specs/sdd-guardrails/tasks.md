<!-- Status enum: draft | in-review | approved | abandoned -->

# Tasks: Guardrails de delegación

> Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md)
> Status: approved
> Last updated: 2026-10-18

Una tarea = una sesión. Hecha significa:
- su **Verify** pasa;
- los gates del plan pasan sin fallos nuevos contra su baseline;
- `server/dist` está reconstruido y committeado si la tarea toca `server/src`;
- el diff está limpio.

Los commits llevan el prefijo `sdd-guardrails: `, los hace solo Claude y van sin trailers de atribución. Las tareas comparten `server/tests/guardrails.spec.ts` y `server/src/delegate.ts`, así que van en secuencia (sin `[P]`).

## T1 — Entorno sellado del worker

- [x] Done
- **Owner**: —
- **Component**: C1 · **Implements**: R4, R5, E5, E8, E9
- **Files**: `server/src/worker-env.ts`, `server/src/worktree.ts`, `server/src/delegate.ts`, `server/tests/fixtures/fake-codex.mjs`, `server/tests/guardrails.spec.ts`
- **Do**:
  - Implementar `workerEnv(meta?)` y `ensureShims()` según C1.
  - Generalizar `workerGitEnv` para varias entradas `GIT_CONFIG_*`.
  - Usar `workerEnv` en `execute`, también sin worktree.
  - Añadir al CLI falso los modos `env` (vuelca su entorno a `FAKE_ENV_FILE`), `gh` (ejecuta `gh pr create`) y `push` (intenta `git push --no-verify` al remoto `origin`).
- **Acceptance**:
  - El entorno volcado no tiene `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GIT_ASKPASS`, `SSH_ASKPASS` ni `SSH_AUTH_SOCK`.
  - El entorno volcado tiene `GIT_TERMINAL_PROMPT=0`, `GIT_ALLOW_PROTOCOL=file`, `GH_CONFIG_DIR` vacío y `credential.helper` vacío.
  - `gh pr create` sale con 1 y el mensaje del plugin.
  - Un push a un remoto `https://` falla sin contactarlo.
  - Con `GIT_CONFIG_COUNT=1` previo, las entradas empiezan en el índice 1.
  - `gh.cmd` existe y la clave de PATH se detecta sin distinguir mayúsculas.
  - El valor de `GH_TOKEN` no aparece en la respuesta.
- **Verify**: `npm --prefix server test -- guardrails delegate`
- **Notes**: `server/src/worker-env.ts` (`workerEnv`, `ensureShims`, `pathKey`, `CREDENTIAL_ENV`), `gitConfigEnv` en `server/src/worktree.ts`, `workerEnv` en `delegate.ts` también sin worktree, `env` admite `undefined` en `providers/types.ts`, modo `probe` en el CLI falso y `server/tests/guardrails.spec.ts` (4 casos); commit `sdd-guardrails: T1 sealed worker environment`. Gates: typecheck 0 errores, 185 passed. Clean-code: none · close calls: el mensaje del `gh` falso va en ASCII (sin raya larga) para que `cmd.exe` lo muestre igual en Windows

## T2 — `specs/` intocable

- [x] Done
- **Owner**: —
- **Component**: C2 · **Implements**: R3, E2
- **Files**: `server/src/worktree.ts`, `server/tests/guardrails.spec.ts`
- **Do**: en `collectChanges`, restaurar `specs/` (`git checkout <base> -- specs`, `git clean -fdq -- specs`) antes del `git add -A` y registrar `specs_modified` con los archivos; ampliar el tipo `Violation`.
- **Acceptance**:
  - Si el worker edita `specs/demo/tasks.md` e `index.ts`, el diff contiene solo `index.ts` y aparece `specs_modified` con `specs/demo/tasks.md`.
  - Un archivo nuevo bajo `specs/` también se quita.
  - `delegation_apply` deja `specs/` como estaba.
  - En modo read se registran `specs_modified` y `write_in_read_mode`.
- **Verify**: `npm --prefix server test -- guardrails`
- **Notes**: `restoreSpecs` en `collectChanges` (`server/src/worktree.ts`): reset del índice, checkout y clean de `specs/` contra la base, violación `specs_modified` con los archivos; `Violation` pasa a unión; 2 casos en `server/tests/guardrails.spec.ts` (write + `delegation_apply`, y read); commit `sdd-guardrails: T2 keep workers out of specs/`. Gates: typecheck 0 errores, 187 passed. Clean-code: none · close calls: el `checkout` solo corre si la base tiene archivos en `specs/` — se queda, sin ellos git falla con "pathspec did not match"

## T3 — Comprobación de push al remoto

- [x] Done
- **Owner**: —
- **Component**: C3 · **Implements**: R6, E6, E7
- **Files**: `server/src/remote-check.ts`, `server/src/delegate.ts`, `server/src/config.ts`, `config/multiprovider.example.json`, `server/tests/guardrails.spec.ts`
- **Do**: implementar `checkRemotePush` con `runProcess`, timeout de 10 s y `GIT_TERMINAL_PROMPT=0`; llamarlo en `execute` tras `collectChanges`; añadir `guardrails.checkRemotePush` (por defecto `true`) a la config y al ejemplo; añadir el paso con `git push <remote> --delete <branch>` cuando haya `worker_push`.
- **Acceptance**:
  - Si el CLI falso hace push saltándose el hook a un remoto bare local, aparecen `worker_push` y el paso de borrado.
  - Con `checkRemotePush: false` no se comprueba nada.
  - Un remoto inalcanzable produce la nota "push check skipped" sin violación.
  - Un repo sin remotos no produce ni violación ni nota.
- **Verify**: `npm --prefix server test -- guardrails config`
- **Notes**: `server/src/remote-check.ts` (`checkRemotePush` con `runProcess`, 10 s, `GIT_TERMINAL_PROMPT=0`), llamada en `execute` tras `collectChanges`, paso `git push <remote> --delete <branch>` en `nextSteps`, `guardrails.checkRemotePush` en `config.ts` y en `config/multiprovider.example.json`; 3 casos en `guardrails.spec.ts` y 1 aserción en `config.spec.ts`; commit `sdd-guardrails: T3 remote push check`. Gates: typecheck 0 errores, 190 passed. Clean-code: none · close calls: la comprobación corre también en modo read — se queda, un worker en read puede hacer push igual

## T4 — Drift fuera de los `Files` de la tarea

- [ ] Done
- **Owner**: —
- **Component**: C4 · **Implements**: R7, E3, E4
- **Files**: `server/src/delegate.ts`, `server/src/sdd/task-delegation.ts`, `server/tests/sdd-task-delegation.spec.ts`, `server/tests/guardrails.spec.ts`
- **Do**: añadir `DelegateParams.scopeFiles` y la violación `outside_task_files`; `sddTaskDelegate` pasa `task.files`, expone `sdd.drift` y fuerza `verified: false`.
- **Acceptance**:
  - Si la tarea tiene `Files: index.ts` y el worker cambia `index.ts` y `otro.ts`, entonces `sdd.drift` es `["otro.ts"]` y `verified` es `false`.
  - Un archivo listado que el worker crea no es drift.
  - `src/` cubre `src/x/y.ts`.
  - `delegate` sin `scopeFiles` no cambia.
- **Verify**: `npm --prefix server test -- sdd-task-delegation guardrails`
- **Notes**: —

## T5 — Delegación automática y confirmación en repos SDD

- [ ] Done
- **Owner**: —
- **Component**: C5 · **Implements**: R1, R2, E1
- **Files**: `server/src/hooks.ts`, `server/tests/hooks-setup.spec.ts`
- **Do**: añadir `isSddRepo`, el bloque SDD de `userPromptSubmit` y el aviso de `preDelegate` para `delegate` en write.
- **Acceptance**:
  - Con `specs/demo/spec.md`, el contexto nombra `/sdd-delegate` y prohíbe `delegate` en write para implementar.
  - El motivo de confirmación menciona `/sdd-delegate`.
  - Sin `specs/`, los textos son los de hoy.
  - `sdd_task_delegate` no recibe el aviso.
- **Verify**: `npm --prefix server test -- hooks-setup`
- **Notes**: —

## T6 — Auditoría de las violaciones nuevas

- [ ] Done
- **Owner**: —
- **Component**: C6 · **Implements**: R8, E9
- **Files**: `server/tests/guardrails.spec.ts`
- **Do**: test que lee el JSONL de auditoría tras delegaciones que producen `specs_modified`, `worker_push` y `outside_task_files`.
- **Acceptance**:
  - Las tres violaciones aparecen con `type` y `detail`.
  - Ningún valor de las variables quitadas aparece en el log.
- **Verify**: `npm --prefix server test -- guardrails`
- **Notes**: —

## T7 — Document the feature

- [ ] Done
- **Owner**: —
- **Component**: — · **Implements**: all (documentation)
- **Files**: `docs/sdd-guardrails.md`, `README.md`, `skills/multi-provider/SKILL.md`
- **Do**:
  - Escribir `docs/sdd-guardrails.md` con qué se bloquea, qué se detecta, las violaciones nuevas, `guardrails.checkRemotePush` y los límites (ruta absoluta fuera del worktree, sandbox del CLI).
  - Actualizar en el README "Modelo de supervisión", la tabla de config y las violaciones.
  - Actualizar en la skill las "Hard rules".
- **Acceptance**: la documentación describe el comportamiento real y cada nombre de variable, violación y opción coincide con el código.
- **Verify**: cotejar cada nombre con `server/src/worker-env.ts`, `server/src/worktree.ts`, `server/src/remote-check.ts` y `server/src/config.ts`; ejecutar SC2 en la máquina del usuario con `codex`
- **Notes**: —

---

## Gaps found in verification

---

## Verification reports
