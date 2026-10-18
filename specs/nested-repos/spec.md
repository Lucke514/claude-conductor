<!-- Status enum: draft | in-review | approved | implemented | superseded | abandoned -->

# Spec: Delegación sobre repos anidados (workspace multi-repo)

> Status: implemented
> Owner: Lucas Gonzalez Espinosa (@Lucke514)
> Sign-off: — the session's user holds all of these
> Tracking: — this project tracks work in the repo only
> Last updated: 2026-10-18

## Objective

Que `delegate` (read y write) y `sdd_task_*` trabajen sobre el repo de código correcto en un workspace cuya raíz es un repo de configuración con los repos de código anidados e ignorados. El trabajo corre siempre en un worktree `mp/*` creado desde ese repo, así que el worker ve el código versionado y nunca los archivos ignorados (`.env*`).

Origen: [brief.md](./brief.md) (workspace Organizer, 2026-10-18). Problema verificado contra 0.3.0:
- `delegate` hace `repoRootOf(ctx.projectDir)` y crea el worktree desde el repo de la raíz (`server/src/delegate.ts:137`, `createWorktree({ cwd: repoRoot })`).
- Una delegación real a Codex desde Organizer recibió un cwd con solo `.claude AGENTS.md CLAUDE.md docs specs`: `backend-monolith/package.json` no existía.
- `isolation.readMode: "cwd"` no es una salida segura: sin worktree no hay `collectChanges` ni hooks, y `codex --sandbox read-only` impide escribir pero no leer `backend-monolith/.env`.

```
workspace/                      ← repo git (config + specs), CLAUDE_PROJECT_DIR
  specs/<slug>/{spec,plan,tasks}.md
  backend-monolith/             ← repo git propio, ignorado por la raíz
  web-app/                      ← repo git propio, ignorado por la raíz
  .claude/worktrees/<slug>/
    backend-monolith/           ← git worktree, rama <tipo>/<slug>
    web-app/                    ← git worktree, rama <tipo>/<slug>
```

## Users & scenarios

- **Lectura sobre un repo anidado**: como desarrollador en un workspace multi-repo, quiero pedir a Codex una revisión de `backend-monolith` y que vea su código, no la raíz de configuración.
- **Tarea SDD en un repo anidado**: como desarrollador, quiero que una tarea con `**Repo**: backend-monolith` se implemente sobre el worktree de la spec (`.claude/worktrees/<slug>/backend-monolith`). Su `Verify` y los gates tienen que correr allí, y `delegation_apply` tiene que dejar el diff en ese mismo worktree.
- **Secretos**: como desarrollador, quiero que el worker no tenga a su alcance `backend-monolith/.env` (credenciales de producción), ni por `files` ni abriéndolo por su cuenta.
- **Cadena de lectura**: como desarrollador, quiero limitar la lectura a Codex sin cambiar la cadena de escritura.
- **Informes honestos**: como desarrollador, quiero saber qué proveedor respondió cuando la cadena cayó a otro.
- **Surfaces**: herramientas MCP (`delegate`, `sdd_task_claim`, `sdd_task_delegate`, `delegation_apply`, `delegation_discard`, `delegation_cleanup`, `sdd_feature_status`) · configuración (`isolation`, `chainByMode`, `providers.antigravity.readModeArgs`) · hook `SessionStart` · `/mp-doctor`.
- **Operational criteria** — una `R#`/`E#`/`SC#` o `non-goal` por ítem:
  - Load & volume: R6 (escaneo de `.env*` acotado) · Text & locale: non-goal · Operational signal: SC9 · Degradation: E1, E5 · Partial failure: E3
  - Accessibility: non-goal (sin UI nueva)
- **Sensitive ground**: el worker trabaja junto a repos con credenciales de producción.
  - Access control: R1, R3, R6 · Data handling: R3 (ningún archivo ignorado llega al worker), E4 · Traceability: R8 (`repo` y `requestedProvider` en la respuesta y el audit) · Data lifecycle: non-goal (no se copian ni guardan secretos) · Repeat-request correctness: non-goal (sin cambios en reintentos)

## Requirements

- **R1** — `delegate` acepta `repo` (opcional): una ruta relativa a `projectDir`, como `backend-monolith` o `.claude/worktrees/<slug>/backend-monolith`. Antes de crear un worktree o lanzar un worker se valida que:
  - no sea absoluta ni contenga segmentos `..`;
  - su `realpath` quede dentro del `realpath` de `projectDir` (un symlink que escapa se rechaza);
  - `git rev-parse --show-toplevel` en esa ruta sea esa misma ruta (comparadas con `realpath`).

  Si falla, el error es `REPO_INVALID` o `REPO_NOT_GIT` y dice qué regla no se cumplió. Sin `repo`, el comportamiento es el actual.
- **R2** — Con `repo`, todo ocurre sobre ese repo:
  - el worktree `mp/*` se crea desde él, y `includeUncommitted` (`git stash create`) toma sus cambios;
  - los `files` se resuelven contra él (también se acepta el prefijo `<repo>/`);
  - `scopeFiles` y la deriva se comparan con rutas relativas a él;
  - `isolation.symlink` se resuelve contra él;
  - `meta.repoRoot` es ese repo, así que `delegation_apply` y `delegation_discard` operan allí.

  La respuesta incluye `repo` (la ruta relativa a `projectDir`).
- **R3** — Ningún archivo ignorado del repo de código llega al worker:
  - el worktree solo contiene archivos versionados (más los cambios versionados de `includeUncommitted`);
  - una entrada de `symlink` o `symlinkByRepo` que coincide con los patrones sensibles de `prompt-builder` (`.env*`, claves, `secrets.*`) se omite y se anota en `notes`;
  - `files` sigue rechazando rutas sensibles;
  - el prompt y el entorno del worker no contienen la ruta absoluta de `projectDir` ni del repo de origen.

  Alcance de "nunca" (Q1, opción a): la garantía es a nivel del cwd del worker. Una lectura por ruta absoluta fuera del worktree solo la limita el sandbox del CLI del proveedor, y ese riesgo residual se documenta y lo avisa `/mp-doctor` (R12).
- **R4** — `sdd_task_claim` y `sdd_task_delegate` leen el campo `**Repo**: <nombre>` de la tarea y resuelven el repo en este orden:
  1. `.claude/worktrees/<slug>/<Repo>`, si existe y es un repo git (el worktree de la spec);
  2. `<Repo>` en la raíz;
  3. si ninguno existe, error `REPO_NOT_FOUND` con las rutas probadas, sin escribir el Owner ni lanzar un worker.

  El repo resuelto se valida como en R1 y se pasa a `delegate` como `repo`. Los artefactos (`specs/<slug>/…`) se siguen leyendo de `projectDir`. `CLAIM_NOT_COMMITTED` sigue mirando el `HEAD` del repo de la raíz, donde vive `tasks.md`. Una tarea sin `**Repo**` se comporta como hoy. `sdd_task_claim` devuelve el repo resuelto.
- **R5** — Con un repo de tarea, `Verify` y los gates corren con `cwd` = el worktree `mp/*` de ese repo. `isolation.symlinkByRepo: { "<Repo>": ["node_modules", …] }` enlaza esas rutas desde el repo de origen. Sin una entrada para ese repo se usa `isolation.symlink`, resuelto contra el repo (R2). Un gate cuya columna `Where` nombra otro repo del workspace queda `manual`, con ese motivo.
- **R6** — Si `isolation.readMode === "cwd"` y bajo el directorio de trabajo efectivo (`projectDir`, o el repo de R1/R4) hay archivos `.env*`, `delegate` rechaza la llamada con `UNSAFE_READ_MODE` y nombra hasta 5 rutas relativas encontradas. La búsqueda entra en los repos anidados, salta `node_modules` y `.git`, y tiene un límite de profundidad y de entradas: si llega al límite, la llamada también se rechaza. Con `isolation.allowCwdWithSecrets: true` corre igual y lo anota en `notes`.
- **R7** — Por defecto, `providers.antigravity.readModeArgs` es `["--mode", "plan"]`. Un `readModeArgs` explícito en la config lo reemplaza.
- **R8** — `chainByMode: { read?: [...], write?: [...] }` reemplaza a `chain` en el modo dado. Las reglas son las de `chain`: sin `"claude"` al final, la cadena agotada termina en `failed`. Un `provider` pedido explícitamente se intenta primero aunque no esté en esa cadena, pero el fallback solo recorre la cadena del modo. En `provider: "auto"`, una ruta que apunta a un proveedor fuera de la cadena del modo se ignora y se anota en `notes`.
- **R9** — La respuesta de `delegate` y la de `sdd_task_delegate` incluyen `requestedProvider` (el pedido: `auto`, el proveedor explícito o el del Owner). Cuando el que respondió es otro, también incluyen una `note` explícita, del tipo `requested codex, answered by antigravity (fallback after codex: AUTH)`. El audit y `recent` en `state.json` guardan los dos.
- **R10** — Un `**Verify**` con varios comandos, cada uno entre sus propios backticks, ejecuta cada comando por separado y sin shell, con un ítem por comando en `sdd.verification`. Esto ya funciona hoy (`backticked()` en `sdd/artifacts.ts`) y queda fijado por test y documentado. Un único backtick con `&&`, `;` o `|` sigue siendo `manual`, porque nunca se ejecuta a través de un shell.
- **R11** — Los worktrees `mp/*` de repos anidados se pueden encontrar:
  - cada `delegate` con `repo` registra ese `repoRoot` en `state.json` (`repos`, sin duplicados);
  - `listWorktrees`, `cleanupWorktrees` (`delegation_cleanup`, `SessionStart`) y `sdd_feature_status` recorren el repo de la raíz y los registrados que todavía existen bajo `projectDir`.
- **R12** — `/mp-doctor` informa:
  - los repos git anidados que detecta bajo `projectDir` (los mismos límites que R6) y si alguno tiene `.env*`;
  - si `readMode` es seguro: `cwd` con `.env*` alcanzable es `warn`, con su `fix`;
  - el riesgo residual de Q1: el worker no tiene los `.env*` en su cwd, pero el sandbox del CLI no impide leer rutas absolutas.

**Minimum shippable** (prioridad 1 del usuario): R1, R2, R3, R4, R5, R11, con SC1, SC2, SC3 y SC8. La versión 0.4.0 se publica cuando pasan SC1–SC8.

## Non-goals

- Copiar `.env` al worktree `mp/*`. Si un gate necesita variables, se pasan explícitas en una feature futura (p. ej. `verify.env` con nombres permitidos y valores del entorno del servidor), nunca leyendo `.env`.
- Commits, push o merge por el plugin: siguen siendo solo de Claude.
- Crear `.claude/worktrees/<slug>/<Repo>` o sus ramas `<tipo>/<slug>`: es trabajo del flujo spec-driven del workspace.
- Partir `a && b` en varios comandos: el `Verify` se escribe con un backtick por comando (R10).
- Cambiar la configuración del workspace Organizer (sección "Después" del brief).

## Edge cases & error behavior

- **E1** — Si `repo` apunta a un repo sin commits, el error es el de hoy ("make an initial commit before delegating") y nombra el repo.
- **E2** — Si `repo` apunta a un subdirectorio de un repo y no a su raíz (`show-toplevel` distinto), el error es `REPO_NOT_GIT` con la raíz real como sugerencia.
- **E3** — Si el worktree de la spec (`.claude/worktrees/<slug>/<Repo>`) existe pero no es repo git (p. ej. un directorio vacío), se prueba `<Repo>` en la raíz y se anota en `notes` que el worktree de la spec se descartó.
- **E4** — Si `files` de una tarea con `**Repo**` nombra un `.env*`, se omite con el motivo de siempre ("sensitive file"), aunque esté versionado.
- **E5** — Si un repo registrado en `state.json` ya no existe, `listWorktrees` y `cleanupWorktrees` lo saltan sin fallar, y `SessionStart` lo quita del registro.
- **E6** — Dos tareas de la misma spec en repos distintos pueden delegarse a la vez: cada worktree `mp/*` vive bajo `worktrees/<basename>-<hash del repoRoot>/`, como hoy.

## Decisions

- 2026-10-18 El usuario pidió convertir el brief `plugin-fase-b.md` en esta spec, con el slug `nested-repos`, antes de escribir código.
- 2026-10-18 Prioridad del usuario si hay que partir el trabajo: (1) R1–R5 y R11 con SC1, SC2, SC3 y SC8; (2) R6–R8; (3) R9, R10 y R12.
- 2026-10-18 Requisito no negociable del usuario: el worker nunca lee archivos ignorados (`.env*`) del repo anidado, y el test de SC1 lo demuestra con un fixture.
- 2026-10-18 Propuesta: `chainByMode` sigue las reglas de `chain` (sin `claude` implícito). Por eso SC5 configura `["codex", "claude"]`.
- 2026-10-18 Propuesta: el punto 8 del brief ya se cumple con un backtick por comando. R10 lo fija por test en vez de añadir un parser nuevo.
- 2026-10-18 Propuesta: los gates corren en el repo de la tarea. Un gate cuyo `Where` nombra otro repo queda `manual` (R5).
- 2026-10-18 Q1: opción (a). La garantía de R3 es a nivel de cwd, con la instrucción en el prompt y el aviso del riesgo residual en `/mp-doctor` y en la documentación. Una denegación de lectura a nivel de sistema operativo queda para otra spec. Elegida por el usuario.
- 2026-10-18 Spec aprobada por el usuario, con las propuestas de arriba.
- 2026-10-18 Plan aprobado por el usuario; integración por merge local a `main` sin PR, como 0.2.0 y 0.3.0.
- 2026-10-18 Tasks aprobadas por el usuario; pidió ir rápido sin perder calidad.
- 2026-10-18 Verificación convergida (pass 1, cross-review de codex: G1–G5 y G8 resueltos, G6 diferido, G7 descartado); fusionado en `main` sin PR y publicado como 0.4.0, con CI verde en la matriz (run 39106485044).

## Open questions

- Ninguna.

## Success criteria

Cada SC corresponde al criterio A# del brief.

- **SC1** (A1) — Fixture: un repo raíz y un `backend-monolith/` anidado e ignorado, con `package.json` versionado y un `.env` sin versionar. `delegate` read con `repo: "backend-monolith"` y un worker falso que lista su cwd y lee `package.json` y `.env`. El worker ve `package.json`, la lectura de `.env` falla con `ENOENT`, y el prompt no contiene la ruta absoluta del workspace · **Signal**: test en `server/tests` · **Read at**: CI · **Emitted by**: R1, R2, R3.
- **SC2** (A2) — Tarea con `**Repo**: backend-monolith`, con `.claude/worktrees/<slug>/backend-monolith` en la rama `feat/<slug>`. `sdd_task_delegate` crea `mp/*` con base en el `HEAD` de esa rama y corre `Verify` allí. Después, `delegation_apply` deja el diff en ese worktree, y el `git status` de la raíz y del `backend-monolith` raíz no cambia · **Signal**: test · **Read at**: CI · **Emitted by**: R2, R4, R5.
- **SC3** (A3) — `repo` con `..`, absoluto, con un symlink que sale de `projectDir`, o que no es repo git → error (`REPO_INVALID` / `REPO_NOT_GIT`). No se crea worktree ni se lanza un worker (el adapter falso no registra ninguna llamada) · **Signal**: test · **Read at**: CI · **Emitted by**: R1.
- **SC4** (A4) — `readMode: "cwd"` con un `.env` alcanzable → `UNSAFE_READ_MODE`. Con `allowCwdWithSecrets: true`, la delegación corre y `notes` lo dice · **Signal**: test · **Read at**: CI · **Emitted by**: R6.
- **SC5** (A5) — `chainByMode.read: ["codex", "claude"]` con Codex fallando en `AUTH` → `fallback_to_claude`, y agy nunca recibe una llamada. La cadena de escritura no cambia · **Signal**: test · **Read at**: CI · **Emitted by**: R8.
- **SC6** (A6) — Un fallback de proveedor deja `requestedProvider` ≠ `provider` y una `note` presente, en `delegate` y en `sdd_task_delegate` · **Signal**: test · **Read at**: CI · **Emitted by**: R9.
- **SC7** (A7) — Un `Verify` con dos comandos entre backticks da dos ítems `kind: "verify"` en `sdd.verification` · **Signal**: test · **Read at**: CI · **Emitted by**: R10.
- **SC8** (A8) — Sin `repo` ni `**Repo**`, los tests actuales siguen verdes sin cambiarlos (baseline del plan) · **Signal**: `npm --prefix server test` · **Read at**: CI · **Emitted by**: R1, R4.
- **SC9** (A9) — `/mp-doctor` en el fixture de SC1 lista `backend-monolith` como repo anidado con `.env`, y marca `readMode: "cwd"` como `warn` · **Signal**: test de `doctor` · **Read at**: CI · **Emitted by**: R12.
