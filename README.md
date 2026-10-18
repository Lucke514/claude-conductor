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
claude plugin test .              # tests de la conductor card (tests/*.test.tsx)
claude --plugin-dir .             # probar el plugin sin instalarlo
```

Al abrir el repo como **proyecto**, Claude Code también lee el `.mcp.json` de la raíz y te pide aprobar el servidor `multi-provider`. Al aprobarlo, se ejecuta la copia de trabajo (`${CLAUDE_PLUGIN_ROOT:-.}` usa `.` cuando no corre como plugin), lo que sirve para probarlo mientras lo desarrollas. Los hooks, comandos y agentes **solo** se cargan cuando se instala como plugin o con `--plugin-dir .`.

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
/providers-status
/providers-config
/mp-setup [user|project]
/mp-statusline full|compact|off
/mp-auto on|off|status
/mp-doctor [--no-live]
```

### Diagnóstico (`/mp-doctor`)

`/mp-doctor` hace una comprobación end-to-end en tu máquina: versión de Node y de git, validez de la config, si `node-pty` carga, binario, versión y auth de cada CLI y, por último, una **ejecución real** de una línea ("reply OK") en modo read con el mismo adapter que usa `delegate`. Esa ejecución corre en un repo git temporal, nunca en tu proyecto, y gasta unos pocos tokens por proveedor; `--no-live` la omite. Cada fallo trae su `fix:` concreto. Es la forma rápida de detectar que una versión nueva de `codex` o `agy` cambió sus flags (lo verás como `PARSE_ERROR` o `NON_ZERO_EXIT` en la ejecución real aunque `/providers-status` salga bien).

Desde la terminal: `node server/bootstrap.mjs cli doctor [--no-live] [--json]` (código de salida 0 si todo pasa y 3 si algo falla).

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

## Conductor card (banda encima del prompt)

Además de la status line, el plugin dibuja una **card propia encima del prompt**: la orquesta de proveedores de un vistazo. Usa los módulos de UI para plugins de Claude Code (API en *early access*; probado con **v2.1.302**). En versiones que no los soportan, la card simplemente no aparece y el resto del plugin funciona igual.

```text
╭────────────────────────────────────────────────────────────────────────────────────╮
│ ◆ conductor  ·  sesión 4 delegaciones · 13.5k tok   partitura codex → agy → claude │
│ codex  ● afinado        3 llamadas · 12k tok · 1m42s                     ▁▂▅▃▇     │
│ agy    ◐ silencio 2m    circuito abierto · RATE_LIMIT ×3                 ▃▁▁▁▁     │
│ última  codex · review src/auth · ✓ ACCEPT · hace 4m              e: expandir      │
╰────────────────────────────────────────────────────────────────────────────────────╯
```

- **Compacta** (por defecto): estado de cada proveedor, uso del día, mini-gráfica de las últimas llamadas y la última delegación con el veredicto del worker.
- **Expandida** (`e`, con la banda enfocada mediante `ctrl+x tab` o un clic): una tarjeta por proveedor con barras de llamadas, tokens y tiempo, versión, auth y circuito con cuenta atrás; las últimas delegaciones; y los atajos `1` `/providers-status`, `2` `/providers-config` y `3` limpiar worktrees.
- **Estados**:
  - *en curso*: borde latón, spinner, modo y reloj de la delegación activa;
  - *primer uso*: te sugiere el primer `/delegate` y `/mp-setup`;
  - *degradado*: el rojo solo aparece en lo que bloquea, siempre con su arreglo (`codex login`…);
  - *solo Claude*: proveedores tachados en la partitura.
- Plegarla: el `[-]` que dibuja Claude Code (o `ctrl+x ctrl+a`). Desactivarla del todo: `"card": { "enabled": false }` en `multiprovider.json`.
- **Datos**: igual que la status line, solo lee `~/.claude/multi-provider/state.json` (refresco cada 10 s y al terminar cada delegación) y nunca invoca los CLIs.
  - Para alimentarla, el servidor guarda ahí las últimas 8 delegaciones (con los primeros 60 caracteres de la tarea, solo en local; el log de auditoría sigue sin contenido) y el historial de las últimas 10 llamadas por proveedor.
  - El veredicto `ACCEPT / REQUEST_CHANGES / DISCARD` sale del informe de `codex-worker` / `agy-worker` y se guarda en el almacenamiento del plugin.
- Diseño: [artefacto "Conductor terminal card"](https://claude.ai/artifact/55uqG9zjRWAzcB4ckzXMJx) (privado; compártelo desde su menú Share si quieres que otros lo vean).

Código: `hooks/conductor/card.tsx` (render y eventos), `hooks/conductor/model.ts` (vista pura, testeada con Vitest), `types/index.d.ts` (contrato de su estado) y `tests/conductor-card.test.tsx` (`claude plugin test .`).

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
- `claude plugin validate .` y `claude plugin test .` (los tests de la conductor card).

## Estructura

```text
.claude-plugin/{plugin.json,marketplace.json}   .mcp.json   hooks/hooks.json
agents/{codex-worker,agy-worker}.md   commands/*.md   skills/multi-provider/SKILL.md
hooks/conductor/{card.tsx,model.ts}   types/index.d.ts   tests/conductor-card.test.tsx
config/multiprovider.example.json     statusline/index.js   .github/workflows/ci.yml
server/  bootstrap.mjs · src/{index,cli,config,delegate,fallback,circuit-breaker,health,worktree,
         prompt-builder,process,state,audit,hooks,setup,sanitize,gh-scrub,doctor}.ts · providers/{types,codex,antigravity}.ts
         tests/ (vitest *.spec.ts + binarios fake) · dist/ (compilado, versionado)
```

## Licencia

MIT
