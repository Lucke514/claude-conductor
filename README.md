# claude-conductor · plugin `multi-provider`

Plugin para **Claude Code** que permite delegar tareas a otros proveedores de IA usando **solo sus CLI instalados localmente**. El plugin no usa API keys propias.

| Proveedor | CLI | Invocación |
|---|---|---|
| OpenAI Codex | `codex` | `codex exec --json -C <worktree> --sandbox <read-only\|workspace-write> -` (prompt por stdin) |
| Google Antigravity | `agy` | `agy [--model m] -p "<prompt>"` (bajo pseudo-TTY con `node-pty`) |

Claude Code es siempre el **orquestador y supervisor**: decide cuándo delegar, verifica lo que devuelve cada worker contra el código real y decide si lo integra. Los workers nunca hacen commit, push ni merge.

Este repositorio es a la vez un **marketplace** (`.claude-plugin/marketplace.json`) y el **plugin** (`source: "./"`).

---

## Requisitos

- **Node.js ≥ 20** y **git ≥ 2.31** (se usa `GIT_CONFIG_COUNT` para forzar hooks en los worktrees).
- Al menos uno de estos CLIs, **instalado y con sesión iniciada**:
  - **Codex**: `npm i -g @openai/codex` (o el instalador oficial) y luego `codex login`. Compruébalo con `codex login status`, que debe salir con código 0.
  - **Antigravity**: `curl -fsSL https://antigravity.google/cli/install.sh | bash` y luego ejecutar `agy` una vez en modo interactivo para hacer el login OAuth de Google. Se recomienda la versión **≥ 1.2.9**.
- `node-pty` es una dependencia **opcional**: se compila al instalar. Si falla, el adapter de agy usa `spawn` normal (ver troubleshooting).

## Instalación (marketplace)

Dentro de Claude Code:

```text
/plugin marketplace add Lucke514/claude-conductor
/plugin install multi-provider@claude-conductor
```

O desde la terminal: `claude plugin marketplace add Lucke514/claude-conductor && claude plugin install multi-provider@claude-conductor`.

`server/dist/` va **versionado**. En la primera ejecución, `server/bootstrap.mjs` instala las dependencias de producción (`npm install --omit=dev`, con lock) dentro de la copia del plugin. No hace falta compilar nada.

Después ejecuta **`/mp-setup`** (ver más abajo): desactiva la atribución, instala la status line y el hook `commit-msg`.

### Desarrollo local

```bash
git clone https://github.com/Lucke514/claude-conductor && cd claude-conductor
npm install && npm run build      # instala server/ y compila con tsc
npm test                          # vitest (server/tests/*.spec.ts)
claude plugin test .              # tests del conductor header (tests/*.test.tsx)
claude --plugin-dir .             # probar el plugin sin instalarlo
```

Usa siempre `--plugin-dir .` para probar la copia de trabajo. El `.mcp.json` de la raíz es el del plugin y usa `${CLAUDE_PLUGIN_ROOT}` **exacto**: Claude Code solo sustituye esa forma literal al cargar plugins, así que variantes como `${CLAUDE_PLUGIN_ROOT:-.}` caen al valor por defecto y buscan `server/bootstrap.mjs` en el proyecto del usuario (el servidor MCP no arranca). Si abres el repo como proyecto, rechaza (o deshabilita con `disabledMcpjsonServers`) el servidor `multi-provider` del `.mcp.json`; `/mp-doctor` lo comprueba en la línea `mcp server config`.

## Configuración

Orden del merge (las claves posteriores ganan; los objetos se combinan y los arrays se reemplazan):

1. valores por defecto
2. `<proyecto>/.claude/multiprovider.json`
3. `~/.claude/multiprovider.json` (**override de usuario**)

Cada archivo se valida con **zod** por separado (los errores indican archivo y ruta) y luego se valida el resultado combinado. Para ver la configuración efectiva: `/providers-config`.

Ejemplo completo: [`config/multiprovider.example.json`](config/multiprovider.example.json).

| Campo | Por defecto | Descripción |
|---|---|---|
| `chain` | `["codex","antigravity","claude"]` | Cadena de fallback. `claude` = devolver `fallback_to_claude` para que Claude haga la tarea. |
| `routing` | `{}` | Para `provider:"auto"`. `{"review":"codex"}` o `{"refactor":{"provider":"antigravity","keywords":["refactor","refactoriza"]}}`. Coincide por inicio de palabra; si nada coincide, se usa el primero disponible de la cadena. |
| `defaults.mode` | `"read"` | `read` o `write` |
| `defaults.timeoutMs` | `600000` | Timeout duro por intento |
| `defaults.maxFileBytes` / `maxTotalBytes` | `65536` / `524288` | Límite de contenido de archivos en el prompt |
| `defaults.maxDiffBytes` | `204800` | El diff devuelto se trunca; el patch completo queda en `~/.claude/multi-provider/patches/` |
| `circuitBreaker.threshold` / `cooldownMs` | `3` / `300000` | Fallos consecutivos para abrir el circuito / duración del cooldown |
| `retry` | `maxRetries 2, baseDelayMs 2000, factor 2, maxDelayMs 30000, retryOn [RATE_LIMIT, TIMEOUT]` | Backoff exponencial, solo para esos tipos de error |
| `isolation.readMode` | `"worktree"` | En modo read también se usa un worktree desechable. `"cwd"` ejecuta directamente en el proyecto. |
| `isolation.includeUncommitted` | `true` | La base del worktree incluye los cambios *tracked* sin commitear (`git stash create`) |
| `isolation.symlink` | `[]` | Directorios enlazados en el worktree (ej. `node_modules`, para poder correr lint/tests) |
| `verify.commands` | `[]` | Ej. `["npm run lint","npm test"]`. Se ejecutan sin shell dentro del worktree (hook PostToolUse) |
| `autoDelegate.enabled` | `true` | Delegación automática en cada mensaje (`/mp-auto on\|off`) |
| `statusline.mode` | `"compact"` | `full` / `compact` / `off` |
| `guardrails.checkRemotePush` | `true` | Tras cada delegación, busca la rama `mp/*` en los remotos (`git ls-remote`, 10 s) y la marca como `worker_push` si un worker la publicó |
| `card.enabled` / `card.placement` | `true` / `"side"` | Conductor header; `side` = panel al lado de la conversación, `below` = banda sobre el prompt (`/conductor lado\|abajo`) |
| `providers.<codex\|antigravity>` | | `enabled`, `binaryPath`, `model`, `extraArgs`, `usePty`, `errorPatterns`, `timeoutMs`, `modelFlag`, `readModeArgs`, `writeModeArgs`, `versionArgs`, `authCheckArgs`, `skipGitRepoCheck` (codex), `outputFormat` (agy: `text`/`json`) |

`errorPatterns` acepta expresiones regulares (sin distinguir mayúsculas) por tipo de error: `AUTH`, `QUOTA`, `RATE_LIMIT`. Si defines un tipo, tus patrones **reemplazan** a los incluidos para ese tipo.

### Flags verificados y qué quedó configurable

Verificados en la documentación y el código fuente oficiales (octubre de 2026):

- **codex exec**: `-` (prompt por stdin), `--json` (eventos `thread.started`, `turn.started|completed|failed`, `item.*` con `agent_message`, `error`; el uso de tokens viene en `turn.completed.usage`), `-C/--cd`, `--sandbox read-only|workspace-write`, `-m`, `--skip-git-repo-check`, `--color never`, `--ephemeral`.
  - `codex exec` siempre corre con la política de aprobación `never`, así que no se pasa ningún flag de aprobación.
  - `--full-auto` **fue eliminado** y no se usa.
  - `codex login status` sale con 0 si hay sesión y con 1 si no.
- **agy**: `-p/--print/--prompt`, `--output-format text|json|stream-json`, `--model`, `--dangerously-skip-permissions`, `--sandbox`, `--mode`.
  - El cuelgue de `agy -p` sin TTY se corrigió en la versión 1.1.1.

Configurable por incertidumbre:

| Opción | Motivo |
|---|---|
| `versionArgs` de agy (por defecto `--version`) | Solo está documentado por terceros |
| `authCheckArgs` de agy (vacío por defecto → auth `unknown`) | agy no tiene un comando documentado de estado de auth |
| `modelFlag` | El flag del modelo puede cambiar entre versiones |
| `writeModeArgs` de agy (vacío por defecto) | Sin `--dangerously-skip-permissions`, el modo headless puede denegar ediciones en silencio. El ejemplo lo incluye porque corre aislado en un worktree, pero es **decisión tuya** activarlo. |
| `outputFormat` de agy | `text` por defecto, como pide la especificación |
| `errorPatterns` | Los mensajes de error de ambos CLIs no son un contrato estable |

## Uso

Comandos del plugin (también accesibles como `/multi-provider:<comando>`):

```text
/delegate codex Revisa src/auth/*.ts buscando condiciones de carrera
/delegate agy --write Extrae la validación de users.service.ts a un helper con tests
/delegate auto refactoriza el módulo de pagos para inyectar el cliente HTTP
/sdd-delegate sdd-guardrails next codex
/sdd-delegate sdd-guardrails T2 --read
/providers-status
/providers-config
/mp-setup [user|project]
/mp-statusline full|compact|off
/mp-auto on|off|status
/mp-doctor [--no-live]
/conductor lado|abajo
/clean-terminal
```

### Diagnóstico (`/mp-doctor`)

`/mp-doctor` hace una comprobación end-to-end en tu máquina: versión de Node y de git, validez de la config, si `node-pty` carga, binario, versión y auth de cada CLI y, por último, una **ejecución real** de una línea ("reply OK") en modo read con el mismo adapter que usa `delegate`. Esa ejecución corre en un repo git temporal, nunca en tu proyecto, y gasta unos pocos tokens por proveedor; `--no-live` la omite. Cada fallo trae su `fix:` concreto. Es la forma rápida de detectar que una versión nueva de `codex` o `agy` cambió sus flags (lo verás como `PARSE_ERROR` o `NON_ZERO_EXIT` en la ejecución real aunque `/providers-status` salga bien).

Desde la terminal: `node server/bootstrap.mjs cli doctor [--no-live] [--json]` (código de salida 0 si todo pasa y 3 si algo falla).

### Tareas spec-driven (`/sdd-delegate`)

Para features escritas con [spec-driven](https://github.com/Lucke514/spec-driven) (`specs/<slug>/{spec,plan,tasks}.md` aprobados), `/sdd-delegate <slug> <T#|G#|next> [codex|antigravity|auto] [--read]` delega **una tarea** de `tasks.md` con un brief construido desde los artefactos, no desde la conversación. Por defecto usa `auto` y modo write. El flujo:

1. `sdd_task_claim` comprueba que spec, tasks y plan (si existe) están `approved` y que la tarea está abierta y sin owner, y escribe su `**Owner**`.
2. Claude committea ese claim con el comando que devuelve la herramienta (solo `tasks.md`, sin trailers de atribución). Ninguna herramienta hace commits.
3. `sdd_task_delegate` se niega a arrancar un worker si el claim no está en `HEAD`. Si lo está, delega con el texto literal de la tarea, sus `R#`/`E#` y su componente `C#`, y en write ejecuta en el worktree el `Verify` de la tarea y los gates del plan, sin shell.
4. Aplicas (`delegation_apply`) o descartas (`delegation_discard` + `sdd_task_release`). Marcar la casilla y escribir `Notes` lo hace Claude tras su revisión.

Detalle, formato de la respuesta y límites en [`docs/sdd-task-delegation.md`](docs/sdd-task-delegation.md).

### Delegación automática

Con la delegación automática activada (**por defecto**), no hace falta usar `/delegate`. En cada mensaje, un hook `UserPromptSubmit` le indica a Claude que decida por su cuenta si el pedido conviene delegarlo (revisión, refactor, feature, tests, análisis). Si conviene, Claude arma el brief, llama a `delegate` con `provider: "auto"` y verifica el resultado igual que con `/delegate`. Las conversaciones, las preguntas rápidas, los cambios mínimos y los comandos `/…` no se delegan. El modo `write` sigue pidiendo confirmación, y el diff solo se aplica con tu OK.

`/mp-auto off` la desactiva y `/mp-auto on` la vuelve a activar. El valor se guarda como `autoDelegate.enabled` en `~/.claude/multiprovider.json`.

Subagentes: `codex-worker` y `agy-worker` delegan, verifican y devuelven `VERDICT: ACCEPT | REQUEST_CHANGES | DISCARD`.

Herramientas MCP (servidor `multi-provider`):

| Herramienta | Qué hace |
|---|---|
| `delegate` | `{ provider: "codex"\|"antigravity"\|"auto", task, files?, mode?, timeoutMs?, model?, taskType?, fallback? }` → `{ provider, model, status, output, diff?, worktreePath?, durationMs, attempts: [{provider, error?, errorType?, skipped?, retry?}], violations?, nextSteps, … }` |
| `providers_status` | Binario en PATH, `--version`, auth y estado del circuit breaker |
| `providers_config` | Configuración efectiva y archivos cargados |
| `delegation_apply` | `git apply --3way` del worktree sobre tu rama (sin commit) y limpieza |
| `delegation_discard` | Borra el worktree y la rama `mp/*` |
| `delegation_cleanup` | Limpia worktrees `mp/*` huérfanos |
| `sdd_task_claim` | `{ slug, task: "T#"\|"G#"\|"next", provider? }` → escribe el `**Owner**` y devuelve el comando `commit` del claim |
| `sdd_task_delegate` | `{ slug, task, mode?: "write"\|"read", timeoutMs? }` → la respuesta de `delegate` más `sdd: { acceptance, verification, verified, notesDraft, handback? }` |
| `sdd_task_release` | `{ slug, task }` → `**Owner**` a `—` y el comando `commit` del handback |

Los valores de `status` son `success`, `fallback_to_claude` y `failed` (este último solo si la cadena no termina en `claude`).

## Modelo de supervisión

```text
Claude ──delegate──▶ MCP server ──▶ prompt autocontenido (objetivo, restricciones, archivos, formato)
                         │
                         ├─ worktree aislado  mp/<provider>/<timestamp>   (read y write)
                         ├─ codex exec / agy -p   (spawn sin shell, timeout duro, kill del árbol)
                         ├─ HEAD antes/después → si el worker hizo commit: reset --soft + violación
                         ├─ git add -A && git diff --binary <base>
                         └─ circuit breaker + métricas → state.json · auditoría → logs/*.jsonl
Claude ◀── resultado JSON ──┘
   │  PostToolUse: verify.commands dentro del worktree (lint/tests)
   ▼
Claude verifica → ACCEPT: delegation_apply (git apply --3way) + commit propio · REQUEST_CHANGES · DISCARD
```

- **Modo read**: el worker solo analiza y propone. Codex corre con `--sandbox read-only`. Ambos corren además en un worktree desechable: cualquier archivo modificado se descarta y se registra como `write_in_read_mode`.
- **Modo write**: el hook `PreToolUse` pide confirmación. El worker edita solo dentro del worktree. Al terminar se devuelven el diff y `worktreePath`. **Nunca hay merge automático.**
- **Commits solo de Claude**:
  - Cada worktree recibe hooks `pre-commit`, `pre-push`, `pre-merge-commit` y `pre-rebase`, que rechazan la operación si no existe `MP_CLAUDE_COMMIT=1`. Esa variable se elimina del entorno de los workers.
  - Si aun así hay un commit (por ejemplo con `--no-verify`), se hace `git reset --soft` al HEAD original y se registra como violación.
  - Claude aplica el diff con `git apply --3way`. Si tienes cambios locales sin stagear en esos archivos, se reintenta sin `--3way`.
  - Claude hace el commit con **tu identidad git**: el plugin nunca toca `user.name` ni `user.email`.
  - Las ramas `mp/*` se borran al aplicar o descartar, y los worktrees de más de 24 h se limpian en `SessionStart`.
- **Sin push ni PRs del worker** (aunque se salte los hooks):
  - el worker corre sin `GH_TOKEN`, `GITHUB_TOKEN`, sus variantes Enterprise, `GIT_ASKPASS`, `SSH_ASKPASS` ni `SSH_AUTH_SOCK`;
  - además lleva `GIT_TERMINAL_PROMPT=0`, `credential.helper` vacío y `GIT_ALLOW_PROTOCOL=file`, así que git no puede hablar con ningún remoto;
  - `GH_CONFIG_DIR` apunta a un directorio vacío y un `gh` del plugin va primero en el `PATH` y siempre falla;
  - las credenciales del propio CLI (`~/.codex`, API keys) no se tocan;
  - tras cada delegación se comprueba con `git ls-remote` si su rama `mp/*` apareció en algún remoto (`worker_push`, con el comando para borrarla).
- **`specs/` es tuyo**: lo que el worker cambie bajo `specs/` se restaura antes del diff (`specs_modified`) y nunca se aplica. Con `/sdd-delegate`, los archivos cambiados fuera de los `Files` de la tarea se marcan como drift (`outside_task_files`) y dejan la tarea sin verificar. En un repo con `specs/`, la delegación automática usa `/sdd-delegate` para implementar, y un `delegate` en modo write avisa de que se salta el flujo SDD. Detalle en [`docs/sdd-guardrails.md`](docs/sdd-guardrails.md).
- **Credenciales**: el plugin nunca lee ni registra `~/.codex/auth.json`, tokens OAuth ni `.env`. El prompt builder bloquea `.env*`, `auth.json`, claves, `.npmrc`, `.netrc`, `~/.aws`, gcloud y otros, y también cualquier ruta fuera del proyecto. Para auth solo se mira el **exit code** de `codex login status`.
- **Auditoría**: `~/.claude/multi-provider/logs/YYYY-MM-DD.jsonl` guarda proveedor, modo, estado, duración, intentos y tipos de error, el **hash SHA-256 del prompt** y las violaciones. No guarda contenido.

## Sin atribución ni coautoría

`/mp-setup` hace lo siguiente:

1. Escribe `"attribution": { "commit": "", "pr": "", "sessionUrl": false }` en `~/.claude/settings.json` o en `.claude/settings.json` del proyecto, según elijas. Antes guarda un **backup** (`settings.json.bak-<fecha>`) y conserva todas las claves existentes. Las claves están verificadas en la referencia de settings: `commit` y `pr` son strings, `sessionUrl` es booleano.
2. Instala un hook git **`commit-msg`** en el repo mediante `core.hooksPath`:
   - **Encadena** los hooks que ya existían (`.git/hooks`, husky…). Hay wrappers para todos los hooks estándar, y `git-hooks uninstall` restaura el valor anterior.
   - Elimina las líneas `Co-authored-by:` (sin distinguir mayúsculas, de cualquier autor: Claude, Codex, agy…), `Generated with [Claude Code]…`, `🤖 Generated…`, `Claude-Session:` y las URLs de sesión de claude.ai.
3. Activa un hook de Claude Code **`PreToolUse` sobre Bash**. Si el comando es `gh pr create`/`gh pr edit` (o `git commit`):
   - limpia el `--body` (heredoc o `\n` literales);
   - en el caso de `--body-file`/`-F`, escribe una copia limpia en un archivo temporal y reescribe el comando sin tocar tu archivo original.

Todo esto es un respaldo frente a bugs conocidos en los que el setting no se respeta.

## Conductor header (al lado o debajo)

Además de la status line, el plugin dibuja un **header propio**, siempre expandido: la sesión, la orquesta de proveedores y el spec SDD activo de un vistazo. Usa los mods de Claude Code (probado con **v2.1.302**). En versiones que no los soportan, el header simplemente no aparece y el resto del plugin funciona igual.

**Dónde se dibuja** (`/conductor lado|abajo`, o `card.placement` en `multiprovider.json`):

- **`lado`** (por defecto): un panel **a la derecha de la conversación**, fijo mientras la conversación hace scroll. Requiere el renderizado a pantalla completa (`/tui fullscreen`) y una terminal ancha: un panel que abre el plugin solo aparece desde 144 columnas (110 si ya lo abriste tú alguna vez). Ejecutar `/conductor` lo abre a cualquier ancho. Si la terminal es angosta o cierras el panel (`Esc`), el header vuelve a la banda sobre el prompt.
- **`abajo`**: la banda justo encima del prompt, a todo el ancho.

Claude Code no permite que un plugin dibuje en la parte superior de la pantalla, así que esas son las dos posiciones posibles. La elección de `/conductor` se recuerda entre sesiones y tiene prioridad sobre `card.placement`.

```text
┌ conversación (hace scroll) ──────────────────┐┌ ◆ conductor  claude-conductor · main ┐
│ ● Avance de sii-paso-produccion: 11/22…      ││ sesión 4 delegaciones · 13.5k tok    │
│ …                                            ││ Opus 5.5 ctx ━━────────── 19% $1.20  │
│                                              ││ ╭ codex ───────────── ● afinado ╮    │
│                                              ││ ╭ agy ─────────── ◐ silencio 2m ╮    │
│                                              ││ ╭ sii-paso-produccion  T12 en curso ╮│
├──────────────────────────────────────────────┤│ 1 /providers-status  …               │
│ > _                                          ││ codex → agy → claude                 │
└──────────────────────────────────────────────┘└──────────────────────────────────────┘
```

En la banda (`abajo`) el header ocupa todo el ancho:

```text
╭──────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ ◆ conductor  claude-conductor · feature/sdd-guardrails  ·  sesión 4 delegaciones · 13.5k tok         │
│                                                         Opus 5.5  ctx ━━━━────── 42%  $0.50           │
│ ╭ codex ────────── ● afinado ╮  ╭ agy ─────── ◐ silencio 2m ╮  ╭ sdd-guardrails ──── T2 en curso ╮    │
│ │ codex-cli 0.48 · auth ok   │  │ auth desconocida          │  │ spec-driven · tasks approved   │    │
│ │ hoy     ▮▮▮▯▯▯▯▯▯▯ 3       │  │ hoy     ▮▯▯▯▯▯▯▯▯▯ 1      │  │ tasks   ▮▮▮▯▯▯▯▯▯▯ 1/3         │    │
│ │ tokens  ▮▮▮▮▮▮▮▮▮▮ 12k     │  │ tokens  ▯▯▯▯▯▯▯▯▯▯ —      │  │ Gate auto-delegation           │    │
│ │ circuito cerrado · 0 fallos│  │ RATE_LIMIT ×3 · reintenta │  │ owner codex (multi-provider)   │    │
│ ╰────────────────────────────╯  ╰───────────────────────────╯  ╰────────────────────────────────╯    │
│ últimas delegaciones                                                                                 │
│ 11:56  codex       read   review src/auth                                ✓ ACCEPT                    │
│ 1 /providers-status  2 /providers-config  3 limpiar worktrees  4 /mp-doctor  5 clean-terminal         │
│                                                                          codex → agy → claude        │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

- **Siempre expandido**: no hay versión compacta. En el panel lateral, las tarjetas se apilan en columna.
- **Sesión**: repo y rama, delegaciones y tokens de la sesión, modelo (`Sonnet 5.5`, no el id), uso de contexto (`ctx`) y costo, leídos de `$.session` cada 5 s.
- **Proveedores**: una tarjeta por proveedor con estado, versión, auth, barras de llamadas, tokens y tiempo del día, y circuito con cuenta atrás. Durante una delegación, la tarjeta del proveedor muestra `⠹ tocando · write · 00:42` con borde latón y la tarea debajo.
- **Spec activo** (si el proyecto usa [spec-driven](https://github.com/Lucke514/spec-driven)): lee `specs/*/tasks.md` (o el `## Tasks` de un `spec.md` Small) y muestra la feature con una tarea reclamada o, si no hay, la primera `approved` con tareas abiertas: tarea en curso o siguiente, avance `hechas/total` y owner.
- **Atajos**: `1` `/providers-status`, `2` `/providers-config`, `3` limpiar worktrees, `4` `/mp-doctor`, `5` clean-terminal (los dígitos funcionan escribiéndolos solos en el prompt vacío).
- **Estados**: *en curso* (borde latón), *primer uso* (sugiere `/delegate auto` y `/mp-doctor`), *degradado* (rojo solo en lo que bloquea, con su arreglo) y *solo Claude* (proveedores tachados en la cadena).
- Desactivarlo: `"card": { "enabled": false }` en `multiprovider.json`. Posición por defecto: `"card": { "placement": "side" | "below" }`.

### `/clean-terminal`: limpiar la pantalla sin perder el contexto

`/clean-terminal` (o el atajo `5`) oculta todas las filas del transcript dibujadas hasta ese momento: mensajes, llamadas a herramientas y resultados. **La conversación no se toca**: Claude conserva todo el contexto y sigue donde estaba; solo cambia lo que se dibuja. Lo nuevo que llegue después se ve con normalidad.

- El header muestra `─ terminal limpia · contexto intacto (ctx 42%) · N filas ocultas` con el botón **ver historial** (`h`), que vuelve a mostrar todo.
- No es `/clear`: `/clear` sí borra el contexto. El plugin nunca lo invoca.
- En el renderizado a pantalla completa el cambio es inmediato. En el renderizado clásico, las filas que ya se imprimieron en el scrollback de la terminal desaparecen al redibujar (`ctrl+l`).

**Datos**: igual que la status line, lee `~/.claude/multi-provider/state.json` (cada 5 s y al terminar cada delegación) y nunca invoca los CLIs. El servidor guarda ahí las últimas 8 delegaciones (con los primeros 60 caracteres de la tarea, solo en local) y las últimas 10 llamadas por proveedor. El veredicto `ACCEPT / REQUEST_CHANGES / DISCARD` sale del informe de `codex-worker` / `agy-worker`.

Diseño: [artefacto "Conductor terminal card"](https://claude.ai/artifact/55uqG9zjRWAzcB4ckzXMJx) (privado; compártelo desde su menú Share si quieres que otros lo vean).

Código: `hooks/conductor/card.tsx` (render, eventos y `/clean-terminal`), `hooks/conductor/model.ts` (vista pura, testeada con Vitest), `types/index.d.ts` (contrato de su estado) y `tests/conductor-card.test.tsx` (`claude plugin test .`).

## Status line

`statusline/index.js` es Node puro, sin dependencias y en CommonJS:

- Lee el JSON que Claude Code entrega por stdin: `model.display_name`, `context_window.used_percentage`, `cost.total_cost_usd`, `rate_limits.five_hour` y `session_id`.
- Lee `~/.claude/multi-provider/state.json`. Ese archivo lo escribe el servidor MCP de forma atómica (temporal + rename, con lock) después de cada delegación y cada health check.
- **Nunca** invoca los CLIs. Renderiza en unos 30–60 ms (un test exige menos de 100 ms).

```text
compact:  Opus · ctx 42% │ codex ✓ 3 · 12k │ agy ⏸ 2m │ codex→agy→claude
full:     Opus · ctx 42% · $0.50 · 5h 24%
          codex  ✓ ok · sesión 3 · hoy 5 · 12k tok · 2m
          agy    ⏸ 2m circuito abierto, 2m de cooldown · sesión 0 · hoy 0
          cadena codex→agy→claude
off:      Opus · ctx 42% · $0.50 · 5h 24%
```

Colores: verde = ok; amarillo = cooldown, half-open o un error reciente; rojo = sin auth (`🔒`) o no instalado (`✗`).

Las métricas de "sesión" se asocian a tu sesión real de Claude Code: el hook PreToolUse inyecta el `session_id` en cada llamada a `delegate`. Los tokens se muestran cuando el CLI los reporta (codex `--json`, o agy con `outputFormat: "json"`).

Instalación: el formato actual de plugins **no** permite declarar `statusLine` en el `settings.json` de un plugin (solo `agent` y `subagentStatusLine`). Por eso lo agrega `/mp-setup`:

- Apunta a una copia estable en `~/.claude/multi-provider/statusline.js`, que se re-sincroniza en cada `SessionStart` y así sobrevive a las actualizaciones del plugin.
- Si ya tienes una status line, `--statusline-compose` la ejecuta con el mismo stdin y concatena su salida (o puedes elegir `--statusline-replace`).
- El modo se cambia con `/mp-statusline full|compact|off`, que se guarda en `~/.claude/multiprovider.json`.

## Troubleshooting

| Síntoma | Causa / solución |
|---|---|
| **agy se queda colgado** | En versiones anteriores a 1.1.1, `agy -p` se cuelga sin TTY. Con `usePty: true` (por defecto) se lanza bajo un pseudo-TTY. Si `node-pty` no compiló, verás la nota `node-pty unavailable; fell back to plain spawn`: reinstala con toolchain nativo (Xcode CLT / build-essential / VS Build Tools) o actualiza agy a la 1.2.9 o superior y usa `usePty: false`. En todos los casos el timeout duro mata el árbol de procesos y devuelve `TIMEOUT`. |
| **Auth expirada** | `errorType: "AUTH"` y el proveedor se salta sin reintentos. En Codex: `codex login`. En agy: ejecuta `agy` en modo interactivo y vuelve a iniciar sesión. En Linux sin keyring, `failed to retrieve token: secret keyring is locked` exige desbloquear el keyring o usar `AGY_ADC_AUTH=true`. Revisa con `/providers-status`. |
| **Binario no encontrado** | `NOT_INSTALLED`. Configura `providers.<p>.binaryPath` con la ruta absoluta. En Windows se resuelven los shims `.cmd` de npm ejecutando su JS con `node`, sin shell. |
| **Circuito abierto** | Se abrió tras N fallos seguidos. Espera el cooldown (visible en la status line y en `/providers-status`) o borra la entrada `breaker` del proveedor en `state.json`. |
| **Algo falla y no sabes qué** | Ejecuta `/mp-doctor`: recorre entorno, config, auth y una llamada real a cada CLI, y propone el arreglo de cada fallo. |
| **El MCP no arranca tras instalar** | La primera ejecución instala dependencias; mira el stderr del servidor en `/mcp`. Manualmente: `cd <ruta del plugin>/server && npm install --omit=dev`. |
| **agy en write mode no cambia nada** | El modo headless deniega herramientas que requieren aprobación. Valora `writeModeArgs: ["--dangerously-skip-permissions"]`: corre aislado en un worktree. |
| **Lint/tests fallan en el worktree por falta de dependencias** | Añade `isolation.symlink: ["node_modules"]` o un comando de instalación en `verify.commands`. |

## Limitaciones conocidas

- Solo hay dos proveedores (`codex` y `antigravity`). Añadir uno nuevo implica implementar `ProviderAdapter` (`server/src/providers/types.ts`).
- El modo write requiere un repositorio git con al menos un commit. Los archivos **untracked** del usuario no se copian al worktree.
- La auth de agy queda como `unknown` salvo que configures `authCheckArgs` (por ejemplo `["-p","Reply OK"]`, que consume una petición).
- El contador de "sesión" de la status line depende del hook PreToolUse. Si `updatedInput` no se aplica en tu versión de Claude Code, verás los contadores del día.
- En Windows:
  - `agy` puede recibir prompts muy largos por un archivo temporal dentro del worktree (que se borra al terminar), por el límite de unos 32 KB de la línea de comandos;
  - los hooks git usan el `sh` de Git for Windows;
  - el kill del árbol usa `taskkill /T /F`;
  - un `binaryPath` que apunta a un `.js`/`.mjs` se ejecuta con `node` (Windows no respeta el shebang); los binarios fake de los tests funcionan así en las tres plataformas.
- El hook Bash limpia patrones conocidos en el texto del comando. Construcciones de shell exóticas (cuerpos generados por variables) pueden escaparse, y por eso existe además el hook `commit-msg` y el setting `attribution`.
- Las verificaciones automáticas (`verify.commands`) corren sin shell: no admiten pipes ni `&&`. Usa un script de npm.

## CI

`.github/workflows/ci.yml` corre en cada push a `main` y en cada PR:

- typecheck y Vitest en Linux, macOS y Windows, con Node 20 y 22;
- comprobación de que `server/dist` está al día con `src` (se versiona porque el plugin se instala sin build);
- `claude plugin validate .` y `claude plugin test .` (los tests del conductor header).

## Estructura

```text
.claude-plugin/{plugin.json,marketplace.json}   .mcp.json   hooks/hooks.json
agents/{codex-worker,agy-worker}.md   commands/*.md   skills/multi-provider/SKILL.md
hooks/conductor/{card.tsx,model.ts}   types/index.d.ts   tests/conductor-card.test.tsx
config/multiprovider.example.json     statusline/index.js   .github/workflows/ci.yml
specs/<slug>/{spec,plan,tasks}.md     docs/*.md
server/  bootstrap.mjs · src/{index,cli,config,delegate,fallback,circuit-breaker,health,worktree,
         prompt-builder,process,state,audit,hooks,setup,sanitize,gh-scrub,doctor,worker-env,remote-check}.ts · providers/{types,codex,antigravity}.ts
         sdd/{artifacts,brief,claim,verify,task-delegation}.ts
         tests/ (vitest *.spec.ts + binarios fake) · dist/ (compilado, versionado)
```

## Licencia

MIT
