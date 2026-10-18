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

- [x] Done
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
- **Notes**: `DelegateParams.scopeFiles`, `outsideScope` y la violación `outside_task_files` en `server/src/delegate.ts`; `sdd.drift`, `verified: false` y el paso "SPEC DRIFT" en `server/src/sdd/task-delegation.ts`; 1 caso en `sdd-task-delegation.spec.ts` y 2 en `guardrails.spec.ts`; commit `sdd-guardrails: T4 report drift outside task Files`. Gates: typecheck 0 errores, 193 passed. Clean-code: none · close calls: none

## T5 — Delegación automática y confirmación en repos SDD

- [x] Done
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
- **Notes**: `isSddRepo`, `SDD_AUTO_CONTEXT` y `SDD_DELEGATE_WARNING` en `server/src/hooks.ts`; `userPromptSubmit` añade el bloque SDD y `preDelegate` el aviso para `delegate` en write; 3 casos en `server/tests/hooks-setup.spec.ts`; commit `sdd-guardrails: T5 point auto-delegation at /sdd-delegate`. Gates: typecheck 0 errores, 196 passed. Clean-code: none · close calls: none

## T6 — Auditoría de las violaciones nuevas

- [x] Done
- **Owner**: —
- **Component**: C6 · **Implements**: R8, E9
- **Files**: `server/tests/guardrails.spec.ts`
- **Do**: test que lee el JSONL de auditoría tras delegaciones que producen `specs_modified`, `worker_push` y `outside_task_files`.
- **Acceptance**:
  - Las tres violaciones aparecen con `type` y `detail`.
  - Ningún valor de las variables quitadas aparece en el log.
- **Verify**: `npm --prefix server test -- guardrails`
- **Notes**: Caso "audit log (R8, E9)" en `server/tests/guardrails.spec.ts`: una delegación con las tres violaciones nuevas y `GH_TOKEN` puesto; el JSONL las registra con `type`/`detail` y no contiene el valor; sin cambios en `audit.ts` (ya escribía `violations`); commit `sdd-guardrails: T6 audit the new violations`. Gates: 197 passed. Clean-code: none · close calls: none

## T7 — Document the feature

- [x] Done
- **Owner**: —
- **Component**: — · **Implements**: all (documentation)
- **Files**: `docs/sdd-guardrails.md`, `README.md`, `skills/multi-provider/SKILL.md`
- **Do**:
  - Escribir `docs/sdd-guardrails.md` con qué se bloquea, qué se detecta, las violaciones nuevas, `guardrails.checkRemotePush` y los límites (ruta absoluta fuera del worktree, sandbox del CLI).
  - Actualizar en el README "Modelo de supervisión", la tabla de config y las violaciones.
  - Actualizar en la skill las "Hard rules".
- **Acceptance**: la documentación describe el comportamiento real y cada nombre de variable, violación y opción coincide con el código.
- **Verify**: cotejar cada nombre con `server/src/worker-env.ts`, `server/src/worktree.ts`, `server/src/remote-check.ts` y `server/src/config.ts`; ejecutar SC2 en la máquina del usuario con `codex`
- **Notes**: `docs/sdd-guardrails.md` (entorno del worker, violaciones nuevas, `sdd.drift`, hooks, límites, Operating); README (bloques "Sin push ni PRs del worker" y "`specs/` es tuyo" en Modelo de supervisión, fila `guardrails.checkRemotePush`, estructura) y "Hard rules" de `skills/multi-provider/SKILL.md`; cada nombre cotejado con `worker-env.ts`, `worktree.ts`, `remote-check.ts`, `delegate.ts`, `hooks.ts` y `config.ts`; commit `sdd-guardrails: T7 document the feature`. SC2 pendiente: necesita `codex` en la máquina del usuario. Clean-code: none · close calls: none

---

## Gaps found in verification

---

## Verification reports

### Verification report — sdd-guardrails — 2026-10-18 — pass 1

Change set: `2c0ddcc` (`main@30f6cb7...HEAD`; later commits touch only this file)
Converged: no — pipeline gates pending (step 4)

| Req | Verdict | Evidence (case · assertion · clause) |
|---|---|---|
| R1 | met | `hooks-setup.spec.ts::"auto-delegation points implementation work at /sdd-delegate"` — asserts the context is `AUTO_DELEGATE_CONTEXT` + `SDD_AUTO_CONTEXT`, naming `/sdd-delegate` and forbidding write `delegate`; runner: `1 passed`. Code `server/src/hooks.ts` (`userPromptSubmit`, `isSddRepo`) |
| R2 | met | `hooks-setup.spec.ts::"a write delegate in an SDD repo asks with the warning…"` — asserts `ask` + `SDD_DELEGATE_WARNING` (mentions `/sdd-delegate`), not for `sdd_task_delegate` nor read; runner: `1 passed` |
| R3 | met | `guardrails.spec.ts::"restores the worker's specs/ edits, keeps them out of the diff and of delegation_apply"` — asserts diff only `index.ts`, `specs_modified` with both files, `specs/` intact after `applyWorktree`; runner: `1 passed`; negative control: `restoreSpecs` skipped → `1 failed`. Code `server/src/worktree.ts` |
| R4 | met | `guardrails.spec.ts::"strips git/GitHub credentials, limits git to local transports and refuses pushes over https"` — asserts every credential var absent, `GIT_TERMINAL_PROMPT=0`, `GIT_ALLOW_PROTOCOL=file`, `GH_CONFIG_DIR` exists, empty `credential.helper`, push → `transport 'https' not allowed`; runner: `1 passed`; negative controls: credential removal off → `1 failed`; `GIT_ALLOW_PROTOCOL` off → `1 failed`. Code `server/src/worker-env.ts` |
| R5 | met | `guardrails.spec.ts::"puts a gh that always refuses first on PATH, in read mode without a worktree too"` — asserts `gh pr create` exit 1 + `GH_SHIM_MESSAGE`, shim dir first on PATH; runner: `1 passed`; negative control: PATH untouched → `1 failed` |
| R6 | met | `guardrails.spec.ts::"flags a branch the worker pushed past the hooks and says how to delete it"` — asserts `worker_push` with remote/branch, branch present in the bare remote, `git push origin --delete <branch>` in `nextSteps`; `"guardrails.checkRemotePush=false skips the check"`; runner: `1 passed` each; negative control: detection off → `1 failed`. Code `server/src/remote-check.ts` |
| R7 | met | `sdd-task-delegation.spec.ts::"sdd-guardrails R7/E3: files outside the task's Files are drift and leave it unverified"` — asserts `sdd.drift` `["otro.ts"]`, `verified: false`, `outside_task_files`, `SPEC DRIFT` step; runner: `1 passed`; negative control: `scopeFiles` not passed → `1 failed` |
| R8 | met | `guardrails.spec.ts::"records specs_modified, worker_push and outside_task_files without any credential value"` — asserts the JSONL entry's three violation types with string `detail`; runner: `1 passed` |
| E1 | met | `hooks-setup.spec.ts::"without specs/ nothing changes"` — no warning and the current context with an empty `specs/<slug>/`; runner: `1 passed`; negative control: any `specs/` dir counts → `1 failed` |
| E2 | met | `guardrails.spec.ts::"read mode reports specs_modified next to write_in_read_mode"`; runner: `1 passed` |
| E3 | met | `sdd-task-delegation.spec.ts::"sdd-guardrails R7/E3…"` — created `src/nuevo.ts` (listed) is not drift; runner: `1 passed` |
| E4 | met | `guardrails.spec.ts::"a directory entry covers its subtree; paths are normalized"`; runner: `1 passed` |
| E5 | met | `guardrails.spec.ts::"E5/E8: appends GIT_CONFIG_* entries and reuses the PATH key's own case"` — entries start at index 1, index 0 untouched; runner: `1 passed`; negative control: start forced to 0 → `1 failed` |
| E6 | met | `guardrails.spec.ts::"an unreachable remote is a note, not a violation; no remotes means no note"` — `http://127.0.0.1:9/x.git` → note `push check skipped: origin:`, no violation; runner: `1 passed`; negative control: failure as violation → `1 failed` |
| E7 | met | same case, second clause — repo without remotes has no `push check` note; runner: `1 passed` |
| E8 | partially met | `guardrails.spec.ts::"E5/E8…"` asserts `Path` key reuse and `gh.cmd` exists; PATHEXT resolution on Windows is evidenced only by the CI job `test (windows-latest, …)` running the R5 case — pending (Pipeline below) |
| E9 | met | `guardrails.spec.ts::"strips git…"` (response) and `"records specs_modified…"` (response + JSONL) — `secret-value-do-not-leak` absent; runner: `1 passed` each |

Coverage: surfaces API ✅ (R3, R6, R7, R8) · hooks ✅ (R1, R2) · worker environment ✅ (R4, R5) · sensitive ground: access control R4, R5 · traceability R6, R8 · data handling E9 · data lifecycle non-goal · repeat-request correctness non-goal · accessibility non-goal
Gates: typecheck ✅ exit 0 · tests ✅ `Test Files 17 passed (17) · Tests 197 passed (197)` (baseline 181 passed (181); +16 new, 0 skipped) · `claude plugin validate .` ✅ `√ Validation passed` · `claude plugin test .` ✅ `7 pass, 0 fail` · Pipeline: `dist` ⏳ pending (local build leaves `server/dist` with no diff) · matrix ubuntu/macos/windows × Node 20/22 ⏳ pending
Attribution: none — no failure required attribution
Tests removed: none
Clean-code sweep: 1 hit — `workerGitEnv` left unreached by T1 (only its test called it); removed, its test moved to `gitConfigEnv` · close calls: none
Shortcuts declared: none
Dead-code sweep: 1 hit, fixed — `workerGitEnv` (`server/src/worktree.ts`) had no production caller after T1 and was deleted; `tsc --noUnusedLocals --noUnusedParameters` reports nothing else in the change set (scope: this tree)
Excluded from inventory: none
Documentation: `docs/sdd-guardrails.md` (with Operating), README and skill match the names in the code (checked by grep against `server/src`)
Success criteria: SC1 met on emission — `worker_push` is emitted and audited (`guardrails.spec.ts` R6 and R8 cases); its value is read on the user's remote · SC2 pending — needs a real `codex` run asking it to push and open a PR, on the user's machine
Integration: pending review (PR to main)
