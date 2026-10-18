<!-- Status enum: active | deprecated -->

# Delegación sobre repos anidados (workspace multi-repo)

> Spec history: [../specs/nested-repos/](../specs/nested-repos/)
> Status: active
> Last updated: 2026-10-18

## What it does

Hay workspaces cuya raíz es un repo de configuración (`CLAUDE.md`, `.claude/`, `specs/`) y cuyos repos de código viven dentro, **anidados e ignorados** por la raíz:

```
workspace/                      ← repo git (config + specs), CLAUDE_PROJECT_DIR
  specs/<slug>/{spec,plan,tasks}.md
  backend-monolith/             ← repo git propio, ignorado por la raíz
  web-app/                      ← repo git propio, ignorado por la raíz
  .claude/worktrees/<slug>/
    backend-monolith/           ← git worktree de la spec, rama <tipo>/<slug>
```

Hasta 0.3.0, el worktree `mp/*` se creaba siempre desde la raíz, así que el worker no veía el código. Desde 0.4.0:

- `delegate` acepta **`repo`** y el worktree `mp/*` se crea desde ese repo.
- Las tareas spec-driven con **`**Repo**`** se implementan sobre ese repo (o sobre el worktree de su spec), y su `Verify` y los gates corren allí.
- `delegation_apply` / `delegation_discard` operan sobre el repo de origen.
- `delegation_cleanup`, `SessionStart` y `sdd_feature_status` encuentran los worktrees de los repos anidados.
- El worker nunca tiene a su alcance los archivos ignorados (`.env*`) del repo: no están en su worktree.
- `readMode: "cwd"` se niega a correr si hay `.env*` alcanzables.
- `chainByMode` permite, por ejemplo, limitar la lectura a Codex.
- La respuesta dice qué proveedor se pidió (`requestedProvider`) y, si respondió otro, lo anota en `notes`.

## Usage

```text
delegate { "provider": "codex", "mode": "read", "repo": "backend-monolith",
           "task": "Revisa el módulo de pagos…", "files": ["src/payments/service.ts"] }
```

`files` se resuelven contra el repo; también se acepta el prefijo (`backend-monolith/src/payments/service.ts`).

En `tasks.md`, una tarea indica su repo con un campo más:

```markdown
## T3 — Validar el importe

- [ ] Open
- **Owner**: —
- **Repo**: backend-monolith
- **Files**: `src/payments/service.ts`, `src/payments/service.spec.ts`
- **Verify**: `npm test -- payments` y `npm run lint`
```

`/sdd-delegate <slug> T3` no necesita nada más: `sdd_task_claim` resuelve el repo y lo devuelve en `repo`.

Configuración típica del workspace (`.claude/multiprovider.json`):

```json
{
  "chainByMode": { "read": ["codex", "claude"] },
  "isolation": {
    "readMode": "worktree",
    "symlinkByRepo": { "backend-monolith": ["node_modules"], "web-app": ["node_modules"] }
  }
}
```

## Interface

### `repo` (en `delegate`)

Ruta relativa al proyecto. Se valida antes de crear un worktree o lanzar un worker:

| Regla | Error |
|---|---|
| Relativa y sin `..` | `REPO_INVALID` |
| Existe | `REPO_NOT_FOUND` |
| Su ruta real (con symlinks resueltos) queda dentro del proyecto | `REPO_INVALID` |
| Es la raíz de un repo git (`rev-parse --show-toplevel`) | `REPO_NOT_GIT`; si es un subdirectorio, el mensaje nombra la raíz real |

El error llega con `code` en el resultado de la herramienta. La respuesta de `delegate` trae `repo` cuando se usó.

### `**Repo**` (en `sdd_task_claim` / `sdd_task_delegate`)

Se resuelve en este orden:
1. `.claude/worktrees/<slug>/<Repo>`, si es un repo git (el worktree de la spec: el `mp/*` sale de su rama `<tipo>/<slug>`). Si existe pero no es un repo, se descarta con una nota.
2. `<Repo>` en la raíz.
3. Si no hay ninguno, `REPO_NOT_FOUND` con las rutas probadas, antes de escribir el Owner.

Con `**Repo**`:
- `Files` y la deriva (`outside_task_files`) se comparan con rutas relativas al repo;
- los artefactos se siguen leyendo de la raíz;
- el claim se sigue comprobando en el `HEAD` de la raíz, donde vive `tasks.md`.

Un gate cuya columna `Where` nombra otro repo del workspace (p. ej. `web-app`) queda `manual` con `runs in web-app`.

### `Verify` con varios comandos

Cada comando entre sus propios backticks se ejecuta por separado, sin shell, con un ítem por comando en `sdd.verification`. Un único backtick con `&&`, `;` o `|` queda `manual`.

### Respuesta

| Campo | Contenido |
|---|---|
| `repo` | El repo usado, relativo al proyecto |
| `requestedProvider` | `auto`, el proveedor explícito o (en `sdd_task_delegate`) el del Owner |
| `notes` | `requested codex, answered by antigravity (fallback after codex: AUTH)` cuando respondió otro |

### Config nueva

| Campo | Por defecto | Qué hace |
|---|---|---|
| `chainByMode.read` / `chainByMode.write` | — (se usa `chain`) | Cadena de ese modo, con las mismas reglas que `chain`: sin `"claude"` al final, una cadena agotada termina en `failed`. Un proveedor explícito se intenta primero aunque no esté; una ruta de `auto` fuera de la cadena se ignora con una nota |
| `isolation.symlinkByRepo` | `{}` | `symlink` por repo (clave: la ruta de `repo`). Sin entrada, se usa `isolation.symlink`, resuelto contra el repo |
| `isolation.allowCwdWithSecrets` | `false` | Deja correr `readMode: "cwd"` aunque haya `.env*` alcanzables (queda en `notes`) |
| `providers.antigravity.readModeArgs` | `["--mode", "plan"]` | agy en lectura solo planifica. `[]` vuelve a lo anterior |

### Errores nuevos

| `code` | Cuándo |
|---|---|
| `REPO_INVALID`, `REPO_NOT_GIT`, `REPO_NOT_FOUND` | `repo` o `**Repo**` no válidos (ver arriba) |
| `UNSAFE_READ_MODE` | `readMode: "cwd"` con `.env*` bajo el directorio de trabajo (o una búsqueda que llegó a su límite). Nombra hasta 5 rutas |

### `/mp-doctor`

- **`workspace repos`:** los repos anidados y los de `.claude/worktrees/<slug>/`, marcando `(.env)` los que tienen.
- **`read isolation`:** `cwd` con `.env*` alcanzable es `warn` con el fix `readMode: "worktree"`; `worktree` es `ok` y recuerda el riesgo residual.
- **`antigravity: flags`:** además, si agy acepta `--mode plan`.

## Behavior notes

- **Qué ve el worker.** Su worktree solo tiene archivos versionados, más los cambios versionados sin commitear (`includeUncommitted`). Nunca entran archivos ignorados como `.env`. Además:
  - una entrada de `symlink`/`symlinkByRepo` con nombre de secreto (`.env*`, claves, `secrets.*`) se omite y se anota;
  - el entorno del worker no lleva `CLAUDE_PROJECT_DIR`, `MP_PROJECT_DIR`, `PWD`, `OLDPWD` ni `INIT_CWD`;
  - los hooks que bloquean commits viven bajo `~/.claude/multi-provider/worktrees/`, no dentro del `.git` del repo de origen.
- **Riesgo residual.** El archivo `.git` del worktree apunta al repo de origen (`gitdir: …/backend-monolith/.git/worktrees/…`), porque git lo necesita. Ni `codex --sandbox read-only` ni agy impiden leer una ruta absoluta fuera del worktree. La garantía es que el `.env` no está en el directorio del worker, más la instrucción del prompt de no salir de él. Bloquear esas lecturas a nivel de sistema operativo queda fuera de esta versión (decisión Q1 de la spec).
- **Búsqueda de `.env*`.** Es en anchura, sin seguir symlinks, salta `node_modules` y `.git`, y tiene límites de 6 niveles y 20 000 entradas. Si llega a un límite, `readMode: "cwd"` se rechaza igual.
- **Registro de repos.** Cada `delegate` con `repo` guarda la raíz del repo en `state.json → repos`. `SessionStart` quita los que ya no existen, y los que quedan fuera del proyecto actual se ignoran.

## Operating

- **Signal**: `repo` y `requestedProvider` en la respuesta, `state.json → repos`, y los checks `workspace repos` / `read isolation` de `/mp-doctor`.
- **Volver a lo anterior**: sin `repo` ni `**Repo**`, todo funciona como en 0.3.0. `providers.antigravity.readModeArgs: []` e `isolation.allowCwdWithSecrets: true` deshacen los dos cambios de comportamiento por defecto.
