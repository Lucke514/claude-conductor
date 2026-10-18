# Brief: multi-provider — delegación sobre repos anidados (workspace multi-repo)

Repo destino: `claude-conductor` (plugin `multi-provider`, versión actual 0.2.0).
Origen: workspace Organizer, 2026-10-18. Revisado por Fable (diseño) y verificado contra `server/src` y `server/dist` de 0.2.0.

## Problema (verificado)

Hay workspaces cuya raíz es un repo git de configuración (`CLAUDE.md`, `.claude/`, `specs/`, `docs/`) y que contienen los repos de código **anidados e ignorados** por el `.gitignore` de la raíz. Ejemplo real:

```
workspace/                      ← repo git (config + specs), CLAUDE_PROJECT_DIR
  specs/<slug>/{spec,plan,tasks}.md
  backend-monolith/             ← repo git propio, ignorado por la raíz
  web-app/                      ← repo git propio, ignorado por la raíz
  .claude/worktrees/<slug>/
    backend-monolith/           ← git worktree, rama <tipo>/<slug>
    web-app/                    ← git worktree, rama <tipo>/<slug>
    specs -> ../../../specs     (symlink)
```

- `projectDir()` (`server/src/index.ts:18-22` en 0.3.0) = `MP_PROJECT_DIR ?? CLAUDE_PROJECT_DIR`, fijo por proceso.
- `delegate` (`server/src/delegate.ts:137-169` en 0.3.0) hace `repoRootOf(ctx.projectDir)` y `createWorktree({ cwd: repoRoot })` → el worktree `mp/*` es del **repo de la raíz**, que no contiene el código.
- Prueba real, repetida con 0.2.0 y con **0.3.0** (2026-10-18): `delegate` read a Codex reportó cwd `~/.claude/multi-provider/worktrees/workspace-…/codex-…` con solo `.claude AGENTS.md CLAUDE.md docs specs workspace.*`; `web-app/package.json` y `backend-monolith/package.json` **no existen**. `/mp-doctor` pasa entero porque prueba en un repo temporal: no detecta este caso (ver A9).
- 0.3.0 (spec `provider-reliability`) no incluye ninguno de los cambios de este brief salvo `requestedProvider` (parcial, punto 7).
- Consecuencia: `delegate` write y `sdd_task_delegate` no pueden implementar nada en esos repos; `delegate` read solo ve lo incrustado en `files`.

## Por qué NO vale `isolation.readMode: "cwd"` como salida

- En `cwd` no se crea worktree (`meta` undefined en `dist/delegate.js:62-82`): no hay `collectChanges`, ni detección de `write_in_read_mode`, ni hooks `mp-hooks`/`core.hooksPath`. Toda la protección queda en el sandbox del CLI.
- `codex --sandbox read-only` impide escribir pero **no leer**: el worker podría leer `backend-monolith/.env` (contiene credenciales de producción) y mandarlo al proveedor. El bloqueo de `.env*` del prompt builder solo cubre `files`, no lo que el worker abre por su cuenta.
- `providers.antigravity.readModeArgs` viene vacío: agy en read no corre en `--mode plan`.
- `isolation.readMode` es global, no por proveedor: si el breaker de Codex abre, la cadena cae en agy sobre el árbol real.

## Objetivo

Que `delegate` (read y write) y `sdd_task_*` trabajen sobre **el repo de código correcto**, siempre en un worktree `mp/*` creado con `git worktree add` desde ese repo, de modo que el worker vea el código versionado y **nunca** archivos ignorados (`.env*`).

## Cambios pedidos

1. **Repo destino en `delegate`.** Nuevo parámetro opcional `repo` (ruta relativa a `projectDir`, p. ej. `backend-monolith` o `.claude/worktrees/<slug>/backend-monolith`). Debe resolver dentro de `projectDir` (rechazar `..`, rutas absolutas fuera, symlinks que escapen) y ser un repo git (`rev-parse --show-toplevel` igual a la ruta). El worktree `mp/*` se crea desde ese repo; `includeUncommitted` (`git stash create`) se aplica sobre ese repo. Sin `repo`, comportamiento actual.
2. **Repo destino en `sdd_task_claim` / `sdd_task_delegate`.** Leer el campo `**Repo**: <nombre>` de la tarea (ya existe en el `tasks.md` de spec-driven de este workspace). Resolución, en orden:
   a. `.claude/worktrees/<slug>/<Repo>` si existe y es repo git (worktree de la spec, rama `<tipo>/<slug>`);
   b. `<Repo>` en la raíz;
   c. error `REPO_NOT_FOUND` con las rutas probadas.
   Los artefactos (`specs/<slug>/…`) se siguen leyendo de `projectDir`. Tarea sin `**Repo**` → comportamiento actual.
   El chequeo `CLAIM_NOT_COMMITTED` sigue mirando el `HEAD` del repo de la raíz (donde vive `tasks.md`), no el del repo de código.
3. **`Verify` y gates en el repo correcto.** `sdd/verify.ts` corre con `cwd` = worktree `mp/*` del repo de código. `isolation.symlink` se resuelve relativo a ese repo (para enlazar su `node_modules`). Permitir `symlink` por repo, p. ej. `isolation.symlinkByRepo: { "backend-monolith": ["node_modules"], "web-app": ["node_modules"] }`, o aplicar `symlink` relativo al repo destino.
4. **`delegation_apply` / `delegation_discard`** operan sobre el repo de origen guardado en `meta` (no sobre `projectDir`). `listWorktrees`/`cleanupWorktrees`/`SessionStart` deben encontrar los worktrees `mp/*` de los repos anidados (registrar `repoRoot` en `meta`/`state.json`).
5. **Guardia de `cwd`.** Si `isolation.readMode === "cwd"` y bajo `projectDir` hay archivos `.env*` alcanzables (incluidos repos anidados), rechazar con `UNSAFE_READ_MODE` salvo `isolation.allowCwdWithSecrets: true` explícito. Y `readModeArgs` por defecto de agy = `["--mode","plan"]`.
6. **Cadena por modo.** Permitir `chainByMode: { read: [...], write: [...] }` (o `chain` por modo) para poder limitar la lectura a Codex sin tocar la escritura.
7. **Proveedor real visible.** En la respuesta de `delegate`/`sdd_task_delegate`, `provider` ya es el que respondió; añadir `requestedProvider` y una `note` explícita cuando difieran (fallback), para que los informes no atribuyan a Codex lo que respondió otro.
8. **Verify con varios comandos.** Hoy un `Verify` con `y`, `&&` o `;` queda `manual`. Aceptar una lista: si el campo `**Verify**` trae varios comandos entre backticks, ejecutar cada uno como comando simple (sin shell) y reportarlos por separado.

## Criterios de aceptación

- A1: con `repo: "backend-monolith"` en un workspace como el de arriba, el worker de `delegate` read ve `backend-monolith/package.json` y **no** ve `backend-monolith/.env` (test con fixture: repo raíz + repo anidado ignorado con `.env` no versionado; el worker fake intenta leer `.env` y falla).
- A2: `sdd_task_delegate` sobre una tarea con `**Repo**: backend-monolith` y `.claude/worktrees/<slug>/backend-monolith` existente crea `mp/*` desde ese worktree (rama base = `<tipo>/<slug>`), corre `Verify` allí y `delegation_apply` deja el diff en ese worktree, no en la raíz.
- A3: `repo` que escapa de `projectDir` o no es repo git → error, sin worker lanzado.
- A4: `readMode: "cwd"` con `.env` alcanzable → `UNSAFE_READ_MODE`; con `allowCwdWithSecrets: true` → corre y lo anota en `notes`.
- A5: `chainByMode.read: ["codex"]` con Codex caído → `fallback_to_claude`, nunca agy.
- A6: fallback de proveedor → `requestedProvider` ≠ `provider` y `note` presente.
- A7: `Verify` con dos comandos entre backticks → dos ítems en `sdd.verification`.
- A8: sin `repo` ni `**Repo**`, todos los tests actuales siguen verdes (retrocompatible).
- A9: `/mp-doctor` informa los repos anidados detectados y si `readMode` es seguro.

## Fuera de alcance

- Copiar `.env` al worktree `mp/*`. Si un gate necesita variables, que se pasen explícitas (p. ej. `verify.env` con nombres permitidos, valores tomados del entorno del servidor), nunca leyendo `.env`.
- Commits, push o merge por el plugin: siguen siendo solo de Claude.

## Después (en el workspace Organizer, no en el plugin)

Con la nueva versión publicada: `.claude/multiprovider.json` del proyecto con `readMode: "worktree"`, `chainByMode.read: ["codex"]`, `symlinkByRepo` con `node_modules`; retirar `codex.sh`/relay y `coder`/`tester` como directores de Codex; `Verify` de `tasks.md` como comandos simples entre backticks.
