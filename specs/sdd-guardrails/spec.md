<!-- Status enum: draft | in-review | approved | implemented | superseded | abandoned -->

# Spec: Guardrails de delegación

> Status: approved
> Owner: Lucas Gonzalez Espinosa (@Lucke514)
> Sign-off: — the session's user holds all of these
> Tracking: — this project tracks work in the repo only
> Last updated: 2026-10-18

## Objective

Que un worker (Codex, Antigravity) no pueda sacar trabajo del worktree por su cuenta, y que lo que devuelve se ajuste a lo aprobado:
- no hace push, no abre PRs y no usa tus credenciales de git ni de GitHub;
- no edita `specs/`;
- no toca archivos fuera de los `Files` de su tarea sin que se marque;
- la delegación automática no salta el flujo SDD en un repo que lo usa.

Hoy el bloqueo de commits y pushes depende de hooks que un worker puede saltarse (`--no-verify`). Un commit se detecta y se deshace después, pero un push o un PR ya enviados no.

## Users & scenarios

- **Worker que intenta publicar**: como dueño del repo, cuando delego una tarea, quiero que el worker no pueda hacer `git push` ni `gh pr create` aunque se salte los hooks, y que me entere si algo llegó al remoto.
- **Worker que edita el spec**: como desarrollador SDD, quiero que los cambios del worker en `specs/` no lleguen al diff, para que el spec solo cambie por decisión mía.
- **Diff fuera de la tarea**: como revisor, quiero ver marcado como spec drift todo archivo que el worker cambió fuera de los `Files` de la tarea.
- **Delegación automática en un repo SDD**: como desarrollador, con `/mp-auto on` en un repo con `specs/`, quiero que el trabajo de implementación pase por `/sdd-delegate` y no por un `delegate` suelto.
- **Surfaces**: API o contrato (respuesta de `delegate` y `sdd_task_delegate`: `violations`, `sdd.drift`) · hooks (`UserPromptSubmit`, `PreToolUse` de `delegate`) · entorno del proceso worker. Sin UI nueva.
- **Operational criteria** — una `R#`/`E#`/`SC#` o `non-goal` por ítem:
  - Load & volume: non-goal (una comprobación por delegación) · Text & locale: non-goal (sin texto de usuario nuevo) · Operational signal: SC1 · Degradation: E6 · Partial failure: E6, E7
  - Accessibility: non-goal (sin superficie de UI)
- **Sensitive ground**: la feature trata credenciales (tokens de GitHub, helpers de credenciales de git, agente SSH) y el acceso del worker al remoto.
  - Access control: R4, R5 · Traceability: R6, R7 · Data handling: E9 · Data lifecycle: non-goal (no se guarda ninguna credencial; solo se quita del entorno) · Repeat-request correctness: non-goal

## Requirements

- **R1** — En un repo que usa SDD (existe al menos un `specs/<slug>/spec.md`), la delegación automática indica a Claude que el trabajo de implementación se delega con `sdd_task_claim`/`sdd_task_delegate` sobre una tarea aprobada, y nunca con `delegate` en modo write. En un repo sin `specs/`, el comportamiento actual no cambia.
  - Given un repo con `specs/demo/spec.md` y `/mp-auto on`, when llega un prompt, then el contexto inyectado nombra `/sdd-delegate` y prohíbe `delegate` en write para implementar.
- **R2** — Un `delegate` en modo write dentro de un repo SDD pide confirmación con un aviso explícito de que se salta el flujo SDD y de que `/sdd-delegate` es el camino para tareas de `tasks.md`.
  - Given un repo con `specs/demo/spec.md`, when se llama a `delegate` con `mode: "write"`, then el hook pide confirmación y el motivo menciona `/sdd-delegate`.
- **R3** — Los cambios del worker bajo `specs/` nunca llegan al diff, ni con `delegate` ni con `sdd_task_delegate`: se revierten en el worktree antes de calcular el diff y se registran como violación `specs_modified` con la lista de archivos.
  - Given un worker que edita `specs/demo/tasks.md` y `src/a.ts`, when termina, then el diff contiene solo `src/a.ts` y `violations` incluye `specs_modified` con `specs/demo/tasks.md`.
- **R4** — El proceso del worker se lanza sin credenciales de git ni de GitHub:
  - se quitan del entorno `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GIT_ASKPASS`, `SSH_ASKPASS` y `SSH_AUTH_SOCK`;
  - se fija `GIT_TERMINAL_PROMPT=0`;
  - `GH_CONFIG_DIR` apunta a un directorio vacío, para que `gh` no lea la sesión guardada;
  - vía `GIT_CONFIG_*`, `credential.helper` queda vacío y git solo puede usar transporte local (`GIT_ALLOW_PROTOCOL=file`).

  Las credenciales del propio CLI del worker (`~/.codex`, la auth de Antigravity, `OPENAI_API_KEY`…) no se tocan.
  - Given un worker que ejecuta `git push origin HEAD` con un remoto https o ssh, when corre, then git falla sin contactar al remoto.
- **R5** — El `PATH` del worker empieza por un directorio del plugin con un `gh` (y `gh.cmd` en Windows) que siempre sale con error y un mensaje que explica que los PRs están reservados a Claude Code.
  - Given un worker que ejecuta `gh pr create`, when corre, then sale con código ≠ 0 y el mensaje del plugin, sin llamar al `gh` real.
- **R6** — Al terminar cada delegación, si el repo tiene remotos, se comprueba con `git ls-remote` desde el entorno de Claude (no del worker) si la rama `mp/*` de esa delegación existe en algún remoto; `guardrails.checkRemotePush: false` en la config la desactiva (por defecto activada). Si existe, se registra la violación `worker_push` con el remoto y la rama, y los siguientes pasos piden al usuario borrarla.
- **R7** — En `sdd_task_delegate`, cada archivo cambiado que no está en los `Files` de la tarea —ni dentro de un directorio listado ahí— se informa en `sdd.drift`, y la respuesta queda con `verified: false`.
  - Given T3 con `Files: src/a.ts` y un diff que toca `src/a.ts` y `src/b.ts`, when vuelve el resultado, then `sdd.drift` es `["src/b.ts"]` y `sdd.verified` es `false`.
- **R8** — Las violaciones nuevas (`specs_modified`, `worker_push`) y el drift se registran en el log de auditoría con el mismo formato que las existentes.

**Minimum shippable**: R3, R4, R5, R6, R7, E1, E5, E6.

## Non-goals

- Bloquear el acceso del worker a la red en general (solo se corta el transporte de git y las credenciales de GitHub); el sandbox de red es del CLI de cada proveedor.
- Impedir que el worker lea archivos fuera del worktree (lo cubre la exclusión de secretos del brief y el sandbox del CLI).
- Cerrar o borrar en el remoto una rama o un PR que un worker hubiera creado: se detecta y se informa, el borrado lo decide el usuario.
- Detectar PRs abiertos por el worker por otras vías (API web, otro CLI): con R4 y R5 no tiene credenciales para hacerlo.
- Mostrar las violaciones en la conductor card (`sdd-traceability`).

## Edge cases & error behavior

- **E1** — Cuando el repo no tiene `specs/`, R1 y R2 no aplican y `/mp-auto` se comporta como hoy.
- **E2** — Cuando el worker en modo read edita `specs/`, el cambio se descarta como cualquier escritura en read y además se registra `specs_modified`.
- **E3** — Cuando `Files` lista un archivo que aún no existe y el worker lo crea, no es drift.
- **E4** — Cuando `Files` lista un directorio (termina en `/`), cualquier archivo dentro cuenta como incluido.
- **E5** — Cuando el usuario ya tiene `GIT_CONFIG_COUNT` u otras entradas `GIT_CONFIG_*`, las de R4 se añaden sin pisarlas (como hoy `core.hooksPath`).
- **E6** — Cuando `git ls-remote` falla o tarda más de 10 s (sin red, sin credenciales), no se registra violación: la respuesta incluye la nota "push check skipped: <motivo>".
- **E7** — Cuando el repo no tiene remotos, la comprobación de R6 no se ejecuta y no aparece nota.
- **E8** — En Windows, el `gh` falso del PATH gana al real tanto si el worker invoca `gh` como `gh.exe`/`gh.cmd` por PATHEXT.
- **E9** — Ningún valor de las variables quitadas (R4) aparece en la respuesta, en `notes` ni en el log de auditoría; solo sus nombres.

## Decisions

- 2026-10-18 La división de la integración SDD y su orden fueron aprobados por el usuario — ver `specs/sdd-integration/scope.md`.
- 2026-10-18 El usuario pidió añadir a esta feature el cierre de los huecos de push y PR (R4, R5 y R6), tras confirmar que hoy un worker que se salta los hooks podría publicar con las credenciales del usuario.
- 2026-10-18 R2: `delegate` en write en un repo SDD pide confirmación con aviso, no se rechaza — porque rechazarlo bloquearía cambios pequeños legítimos fuera de cualquier tarea.
- 2026-10-18 R7: el drift deja la delegación con `verified: false` — porque spec-driven trata un cambio fuera de la tarea como spec drift, que decide el usuario.
- 2026-10-18 R6: la comprobación del remoto está activada por defecto, con `guardrails.checkRemotePush: false` para apagarla — el coste (≤ 10 s por delegación) compensa no enterarse de un push.
- 2026-10-18 R4: se acepta `GIT_ALLOW_PROTOCOL=file` aunque impida al worker `git fetch` o dependencias desde git — porque el worktree ya tiene lo necesario y es lo único que corta también el push por ssh con claves sin agente.
- 2026-10-18 Spec aprobado por el usuario con las opciones por defecto de las cuatro preguntas abiertas.

## Open questions

- Ninguna.

## Success criteria

- **SC1** — Ningún worker publica nada en el remoto · **Signal**: `git ls-remote origin 'refs/heads/mp/*'` vacío y 0 violaciones `worker_push` en `~/.claude/multi-provider/logs/` · **Read at**: el remoto del repo y el log de auditoría local · **Emitted by**: la comprobación de R6 (se define en el plan).
- **SC2** — En una sesión real, una delegación a `codex` con una tarea que pide hacer push y abrir un PR termina sin rama ni PR en el remoto · **Signal**: la respuesta de `delegate` (violaciones y salida del worker) y el remoto · **Read at**: la máquina del usuario con `codex` instalado · **Emitted by**: ya existe (`delegate`) más R4–R6.
