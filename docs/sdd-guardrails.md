<!-- Status enum: active | deprecated -->

# Guardrails de delegación

> Spec history: [../specs/sdd-guardrails/](../specs/sdd-guardrails/)
> Status: active
> Last updated: 2026-10-18

## What it does

Impide que un worker delegado (Codex, Antigravity) saque trabajo del worktree por su cuenta: corre sin credenciales de git ni de GitHub, así que no puede hacer push ni abrir PRs aunque se salte los hooks; y si una rama `mp/*` llega igualmente a un remoto, se detecta. Además protege los artefactos SDD: lo que el worker cambie en `specs/` nunca llega a tu rama, y con `/sdd-delegate` los cambios fuera de los `Files` de la tarea se marcan como spec drift. Todo se aplica a cualquier delegación (`/delegate`, `/sdd-delegate`, subagentes, delegación automática) sin configurar nada.

## Usage

No hay comando nuevo: los controles van dentro de cada delegación. Lo que ves es la respuesta:

```json
{
  "status": "success",
  "violations": [
    { "type": "specs_modified", "detail": "worker changed 1 file(s) under specs/; they were restored and left out of the diff: specs/demo/tasks.md", "files": ["specs/demo/tasks.md"] },
    { "type": "worker_push", "detail": "worker pushed mp/codex/20261018-… to remote 'origin'", "remote": "origin", "branch": "mp/codex/20261018-…" }
  ],
  "notes": ["push check skipped: backup: no answer in 10s"],
  "nextSteps": ["A worker pushed mp/codex/20261018-… to 'origin'. Tell the user and, with their OK, delete it: `git push origin --delete mp/codex/20261018-…`.", "…"]
}
```

Para desactivar solo la comprobación del remoto, en `~/.claude/multiprovider.json` o `.claude/multiprovider.json`:

```json
{ "guardrails": { "checkRemotePush": false } }
```

## Interface

### Entorno del worker

- **Se quitan**: `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GIT_ASKPASS`, `SSH_ASKPASS`, `SSH_AUTH_SOCK` (y, como antes, `MP_CLAUDE_COMMIT`).
- **Se fijan**:
  - `GIT_TERMINAL_PROMPT=0`;
  - `GIT_ALLOW_PROTOCOL=file`: git solo usa transporte local, así que `git push`/`fetch` por https o ssh fallan con `transport '…' not allowed`;
  - `GH_CONFIG_DIR=~/.claude/multi-provider/empty-gh`: `gh` no ve tu sesión guardada;
  - vía `GIT_CONFIG_*`, añadidos a los que ya tengas: `credential.helper` vacío y, con worktree, `core.hooksPath` con los hooks de bloqueo.
- **`PATH`**: empieza por `~/.claude/multi-provider/bin`, con un `gh` (y `gh.cmd` en Windows) que siempre sale con 1 y el mensaje `multi-provider: gh is disabled for delegated workers - …`.
- **No se tocan**: las credenciales del CLI del propio worker (`~/.codex`, la auth de Antigravity, `OPENAI_API_KEY`…).

### Violaciones nuevas en `violations` (y en el log de auditoría)

| `type` | Cuándo | Campos extra |
|---|---|---|
| `specs_modified` | El worker creó, cambió o borró algo bajo `specs/`. Se restaura a la base antes del diff y `delegation_apply` no lo aplica. También en modo read | `files` |
| `worker_push` | La rama `mp/*` de la delegación existe en un remoto tras el trabajo | `remote`, `branch` |
| `outside_task_files` | Solo con `scopeFiles` (lo pasa `sdd_task_delegate`): archivos cambiados fuera de los `Files` de la tarea | `files` |

### `sdd_task_delegate`

- `sdd.drift`: los archivos de `outside_task_files`. Si no está vacío, `sdd.verified` es `false` y el primer paso empieza por `SPEC DRIFT`.
- Una entrada de `Files` que termina en `/` cubre todo su directorio. Un archivo listado que el worker crea no es drift.

### Hooks

- **Delegación automática** (`/mp-auto on`): en un repo con algún `specs/<slug>/spec.md`, el contexto añade que la implementación se delega con `/sdd-delegate` y nunca con `delegate` en modo write. El trabajo sin spec aprobado no se auto-delega, y los `delegate` en modo read (revisiones, análisis) siguen permitidos.
- **Confirmación de `delegate` en write**: en un repo SDD, el motivo añade `This repo uses spec-driven development: this write delegation bypasses it — …`. No se rechaza.

## Behavior notes

- **Remoto inalcanzable**: si `git ls-remote` falla o tarda más de 10 s, queda una nota `push check skipped: <remoto>: <motivo>`, nunca una violación. Sin remotos no se comprueba nada. La comprobación corre con tu entorno, no con el del worker, y también en modo read.
- **Remotos locales**: un remoto que es una ruta del disco usa el transporte `file`, que sigue permitido. Un worker que se salte el hook `pre-push` podría escribir ahí; `worker_push` lo detecta.
- **Lo que el worker ya no puede hacer**: `git fetch`, `git submodule update` remoto o instalar dependencias desde git. El worktree ya trae lo necesario y, si hace falta, `isolation.symlink` enlaza `node_modules`.
- **Lo que no cubre**:
  - un worker que escriba con una ruta absoluta en tu checkout real, fuera del worktree;
  - el acceso del worker a la red en general.

  Ambos dependen del sandbox de cada CLI. Codex en write corre con su sandbox de workspace.
- **Ningún valor de credencial** aparece en la respuesta, las notas o el log de auditoría: solo nombres de variables, archivos, remotos y ramas.

## Operating

- **Switch**: `guardrails.checkRemotePush` (por defecto `true`) apaga solo la comprobación del remoto; el resto de controles no tiene interruptor.
- **Signal**: violaciones `worker_push` en `~/.claude/multi-provider/logs/YYYY-MM-DD.jsonl` y `git ls-remote origin 'refs/heads/mp/*'` vacío.
- **When it fires**:
  1. Si aparece un `worker_push`, borra la rama con el comando de `nextSteps`.
  2. Revisa el log del día para ver qué delegación fue.
  3. Desconfía de ese resultado: es la señal de que el CLI del worker intentó publicar.
