// Conductor header, always expanded: a pane beside the conversation (wide
// fullscreen terminal) or the band above the prompt (/conductor lado|abajo), showing the
// session (model, context, cost), the multi-provider orchestra (provider health,
// circuit breakers, recent delegations, live progress) and the active SDD spec.
// Reads ~/.claude/multi-provider/state.json and specs/*/tasks.md; never runs the CLIs.
//
// /clean-terminal hides the transcript rows drawn so far without touching the
// conversation: Claude keeps the whole context, only the drawing is emptied.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, RenderElement, RenderInput, ToolCallResult } from 'claude-code'

import type { Cleaned, PipelineFeature, Placement, Running, SessionMeta, SessionTally, SpecProgress, SpecView, StateFile } from '../../types'
import {
  bar,
  buildCard,
  ctxBar,
  fmtCost,
  fmtDuration,
  fmtTokens,
  ownerProvider,
  pad,
  PALETTE,
  parseVerdict,
  pickActiveSpec,
  pipelineView,
  runningFromJobs,
  prettyModel,
  rateLimitText,
  rateLimitView,
  specProgress,
  type CardView,
  type ProviderView,
  type Tone,
} from './model'

const snap = atom({ plugin: 'multi-provider', key: 'snap' } as const, null)
const enabled = atom({ plugin: 'multi-provider', key: 'enabled' } as const, true)
const running = atom({ plugin: 'multi-provider', key: 'running' } as const, null)
const tick = atom({ plugin: 'multi-provider', key: 'tick' } as const, 0)
const verdicts = atom({ plugin: 'multi-provider', key: 'verdicts' } as const, {})
const session = atom({ plugin: 'multi-provider', key: 'session' } as const, { calls: 0, tokens: 0 })
const meta = atom({ plugin: 'multi-provider', key: 'meta' } as const, {})
const spec = atom({ plugin: 'multi-provider', key: 'spec' } as const, null)
const cleaned = atom({ plugin: 'multi-provider', key: 'cleaned' } as const, null)
const placement = atom({ plugin: 'multi-provider', key: 'placement' } as const, 'side')
const paneShown = atom({ plugin: 'multi-provider', key: 'paneShown' } as const, false)

/** The side pane's id: what $.ui.open names and its ui.render requestId. */
const PANE = 'conductor'
/** Columns the side pane asks for beside the transcript. */
const PANE_COLUMNS = 48

const CHAIN_COLOR = '#6CC6D8'
const MUTED = '#AAB1BC'
const STRONG = '#F2F4F7'
const MAX_VERDICTS = 30

/** Transcript rows /clean-terminal can hide. The band, the prompt and the spinner stay. */
const TRANSCRIPT_SITES = ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'CommandOutput', 'TurnDuration', 'InfoNotice'] as const

const color = (t: Tone) => PALETTE[t]

async function homeDir($: EngineInterface): Promise<string | undefined> {
  return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return undefined
  }
}

async function loadState($: EngineInterface): Promise<void> {
  const home = await homeDir($)
  const mpHome = (await $.env.get('MP_HOME')) ?? (home ? `${home}/.claude/multi-provider` : undefined)
  if (!mpHome) return
  const next = (await readJson($, `${mpHome}/state.json`)) as StateFile | undefined
  const prev = await read($, snap)
  if (JSON.stringify(prev) !== JSON.stringify(next ?? null)) await update($, snap, () => next ?? null)
}

/**
 * card.enabled and card.placement from ~/.claude/multiprovider.json (wins) or the
 * project's .claude/multiprovider.json. A placement chosen with /conductor wins over both.
 */
async function loadCardConfig($: EngineInterface): Promise<void> {
  const home = await homeDir($)
  const userPath = (await $.env.get('MP_USER_CONFIG')) ?? (home ? `${home}/.claude/multiprovider.json` : undefined)
  const card = (c: unknown) => (c as { card?: { enabled?: unknown; placement?: unknown } } | undefined)?.card
  const user = userPath ? card(await readJson($, userPath)) : undefined
  const project = card(await readJson($, '.claude/multiprovider.json'))
  const on = typeof user?.enabled === 'boolean' ? user.enabled : typeof project?.enabled === 'boolean' ? project.enabled : true
  if ((await read($, enabled)) !== on) await update($, enabled, () => on)
  const isPlacement = (v: unknown): v is Placement => v === 'side' || v === 'below'
  const chosen = await $.store.get('placement')
  const where: Placement = isPlacement(chosen) ? chosen : isPlacement(user?.placement) ? user.placement : isPlacement(project?.placement) ? project.placement : 'side'
  if ((await read($, placement)) !== where) await update($, placement, () => where)
}

/** Model, context use, cost and rate-limit windows as the status line has them; repo and branch from the working copy. */
async function loadMeta($: EngineInterface): Promise<void> {
  const next: SessionMeta = {}
  try {
    next.model = prettyModel(await $.session.model())
  } catch {
    /* not reported on this surface */
  }
  try {
    const usage = await $.session.usage()
    if (usage.context.percent !== undefined) next.ctxPercent = Math.round(usage.context.percent)
    if (usage.cost) next.costUsd = usage.cost.usd
    next.rateLimits = usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
  } catch {
    /* not reported on this surface */
  }
  try {
    const repo = await $.session.repo()
    if (repo) {
      next.repo = repo.name ?? repo.root.split(/[\\/]/).pop() ?? undefined
      const head = (await $.fs.read(`${repo.root}/.git/HEAD`)).trim()
      if (head.startsWith('ref: refs/heads/')) next.branch = head.slice('ref: refs/heads/'.length)
    }
  } catch {
    /* outside a repo, or .git is a worktree file: no branch */
  }
  if (JSON.stringify(await read($, meta)) !== JSON.stringify(next)) await update($, meta, () => next)
}

// The plugin's own MCP server, as `$.mcp.call` names it, once connected.
let mcpServer: string | undefined
let pipelineInFlight = false

/** Every feature's stage from the server's sdd_feature_status: the same logic as /sdd-status. */
async function loadPipeline($: EngineInterface): Promise<PipelineFeature[] | undefined> {
  if (!mcpServer) {
    const c = await $.mcp.connect('multi-provider')
    if (!c.isConnected) return undefined
    mcpServer = c.server
  }
  const res = await $.mcp.call(mcpServer, 'sdd_feature_status', {})
  if (res.isError) return undefined
  const block = res.content.find(b => b.type === 'text') as { text?: string } | undefined
  const body = JSON.parse(block?.text ?? '') as { features?: PipelineFeature[] }
  return Array.isArray(body.features) ? body.features : undefined
}

/** The SDD line: the server's pipeline, else the active feature from specs/<slug>/tasks.md. */
async function loadSpec($: EngineInterface): Promise<void> {
  // A call still waiting keeps the line as it is; the next 15-second tick tries again.
  if (pipelineInFlight) return
  pipelineInFlight = true
  let value: SpecView | null
  try {
    const features = await loadPipeline($).catch(() => undefined)
    if (features) value = { features }
    else {
      const progress = await loadProgress($)
      value = progress ? { progress } : null
    }
  } finally {
    pipelineInFlight = false
  }
  if (JSON.stringify(await read($, spec)) !== JSON.stringify(value)) await update($, spec, () => value)
}

/** The active spec-driven feature, from specs/<slug>/tasks.md (or a Small spec.md). */
async function loadProgress($: EngineInterface): Promise<SpecProgress | undefined> {
  let found: SpecProgress | undefined
  try {
    const dirs = (await $.fs.list('specs')).filter(d => d.kind === 'dir')
    const all: SpecProgress[] = []
    for (const d of dirs) {
      let md: string | undefined
      try {
        md = await $.fs.read(`specs/${d.name}/tasks.md`)
      } catch {
        try {
          const small = await $.fs.read(`specs/${d.name}/spec.md`)
          if (/^## Tasks/m.test(small)) md = small
        } catch {
          /* not a feature directory */
        }
      }
      if (md) all.push(specProgress(d.name, md))
    }
    found = pickActiveSpec(all)
  } catch {
    /* no specs/ in this project */
  }
  return found
}

function resultText(res: ToolCallResult): string {
  return 'text' in res && typeof res.text === 'string' ? res.text : ''
}

async function markStart($: EngineInterface, e: unknown): Promise<void> {
  const args = e as { provider?: string; mode?: string; task?: string }
  const r: Running = {
    provider: args.provider ?? 'auto',
    mode: args.mode ?? 'read',
    task: (args.task ?? '').replace(/\s+/g, ' ').slice(0, 70),
    startedAt: await $.clock.now(),
  }
  await update($, running, () => r)
}

/** sdd_task_delegate: the worker is the one its claim named in the task's Owner. */
async function markSddStart($: EngineInterface, e: unknown): Promise<void> {
  const args = e as { slug?: string; task?: string; mode?: string }
  const view: SpecView | null = await read($, spec)
  const feature = view && 'features' in view ? view.features.find(f => f.slug === args.slug) : undefined
  const owner = feature?.current?.id === args.task ? feature.current.owner : undefined
  const r: Running = {
    provider: ownerProvider(owner) ?? 'auto',
    mode: args.mode ?? 'write',
    task: `${args.slug ?? ''} ${args.task ?? ''}`.trim(),
    startedAt: await $.clock.now(),
    ...(args.slug ? { slug: args.slug } : {}),
    ...(args.task ? { taskId: args.task } : {}),
  }
  await update($, running, () => r)
}

async function markDone($: EngineInterface, res: ToolCallResult): Promise<void> {
  let tokens = 0
  try {
    const body = JSON.parse(resultText(res)) as { usage?: { inputTokens?: number; outputTokens?: number } }
    tokens = (body.usage?.inputTokens ?? 0) + (body.usage?.outputTokens ?? 0)
  } catch {
    /* not JSON (an error result): count the call only */
  }
  await update($, session, (s: SessionTally) => ({ calls: s.calls + 1, tokens: s.tokens + tokens }))
}

async function markIdle($: EngineInterface): Promise<void> {
  await update($, running, () => null)
  await loadState($)
}

/** Worker agents end their report with "VERDICT: …" (and "delegation: <id>"). */
async function recordVerdict($: EngineInterface, e: unknown, res: ToolCallResult): Promise<void> {
  const type = (e as { subagent_type?: string }).subagent_type ?? ''
  if (!/(codex|agy)-worker/.test(type)) return
  const v = parseVerdict(resultText(res))
  if (!v) return
  const s = await read($, snap)
  const workerProvider = type.includes('codex') ? 'codex' : 'antigravity'
  const target = v.id ?? s?.recent?.find(r => r.provider === workerProvider)?.id
  if (!target) return
  const next = await update($, verdicts, (m: Record<string, string>) =>
    Object.fromEntries(Object.entries({ ...m, [target]: v.verdict }).slice(-MAX_VERDICTS)),
  )
  await $.store.set('verdicts', next)
}

// Transcript rows drawn so far, and the ones /clean-terminal hid. Ids only:
// the conversation itself is never touched.
const seen = new Set<string>()
let hidden = new Set<string>()

async function cleanTerminal($: EngineInterface): Promise<void> {
  hidden = new Set(seen)
  const at = await $.clock.now()
  await update($, cleaned, () => ({ at, rows: hidden.size }))
  $.ui.invalidate('ui.render')
}

async function restoreTerminal($: EngineInterface): Promise<void> {
  hidden = new Set()
  await update($, cleaned, () => null)
  $.ui.invalidate('ui.render')
}

/** Whether the side pane is on screen now (placed, and the pane shown among its tabs). */
async function syncPane($: EngineInterface): Promise<void> {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  const shown = !!pane && pane.isPlaced && pane.isShown
  if ((await read($, paneShown)) !== shown) await update($, paneShown, () => shown)
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'conductor', columns: PANE_COLUMNS })
  await syncPane($)
}

/** Everything the header reads, then the side pane when that is the placement. */
async function loadAll($: EngineInterface): Promise<void> {
  await loadCardConfig($)
  await loadState($)
  await loadMeta($)
  await loadSpec($)
  // Opened by the plugin itself, the pane shows only on a wide terminal; until
  // then (or when the person closes it) the band above the prompt draws instead.
  if ((await read($, enabled)) && (await read($, placement)) === 'side') await openPane($).catch(() => undefined)
}

async function setPlacement($: EngineInterface, where: Placement): Promise<void> {
  await $.store.set('placement', where)
  await update($, placement, () => where)
  if (where === 'side') await openPane($)
  else {
    await $.ui.close({ id: PANE })
    await syncPane($)
  }
}

/**
 * The header's tree for the band or the side pane; `undefined` before state.json
 * exists. Narrow sites (the pane, a slim band) stack what a wide band lays in rows.
 */
async function drawHeader($: EngineInterface, e: RenderInput<'AbovePrompt' | 'Pane'>): Promise<RenderElement | undefined> {
  const state = await read($, snap)
  if (!state) return undefined
  // The server's job registry knows the real worker and its progress; the tool.call hook is the fallback.
  const live = runningFromJobs(state) ?? (await read($, running))
  const view = buildCard({
    state,
    now: await $.clock.now(),
    running: live,
    verdicts: await read($, verdicts),
    session: await read($, session),
    tick: await read($, tick),
  })
  const m: SessionMeta = await read($, meta)
  const specView: SpecView | null = await read($, spec)
  const active = specView && 'progress' in specView ? specView.progress : null
  const pipeline = specView && 'features' in specView ? pipelineView(specView.features, live) : []
  const wasCleaned: Cleaned | null = await read($, cleaned)
  const { Box, Text, Button } = $.ui.resolve(e)
  const wide = e.props.bodyColumns >= 100
  const inPane = e.component === 'Pane'
  // Rows: header 1 + cards 7 + recent 4 + notice 1 + footer 1, border 2. A pane scrolls.
  const roomy = inPane || e.props.maxRows === undefined || e.props.maxRows >= 18
  const run = (command: string) => () => void $.command.run({ command })

  const where = [m.repo, m.branch].filter(Boolean).join(' · ')
  // Claude Code's own plan windows: in the side pane the status line is out of sight.
  const limits = rateLimitView(m.rateLimits, await $.clock.now())
  const usageLine = (
    <Text key="usage">
      {limits.length === 0 ? <Text color={PALETTE.dim}>usage —</Text> : ''}
      {limits.map((l, i) => (
        <Text key={`l${i}`} color={l.tone === 'text' ? MUTED : color(l.tone)}>{`${i > 0 ? '  ' : ''}${rateLimitText(l)}`}</Text>
      ))}
    </Text>
  )
  const header = (
    <Box key="header" flexDirection={wide ? 'row' : 'column'} justifyContent="space-between">
      <Text>
        <Text color={PALETTE.brass} bold>◆ conductor</Text>
        <Text color={PALETTE.dim}>{wide ? `  ${where ? `${where}  ·  ` : ''}${view.summary}` : `  ${where}`}</Text>
      </Text>
      {wide ? '' : <Text color={PALETTE.dim}>{view.summary}</Text>}
      <Text>
        {m.model ? <Text color={MUTED}>{`${m.model}  `}</Text> : ''}
        {m.ctxPercent !== undefined ? (
          <Text>
            <Text color={PALETTE.dim}>{'ctx '}</Text>
            <Text color={CHAIN_COLOR}>{ctxBar(m.ctxPercent)}</Text>
            <Text color={MUTED}>{` ${m.ctxPercent}%  `}</Text>
          </Text>
        ) : ''}
        <Text color={PALETTE.dim}>{fmtCost(m.costUsd)}</Text>
        {wide ? <Text>{'  '}{usageLine}</Text> : ''}
      </Text>
      {wide ? '' : usageLine}
    </Box>
  )

  const runningOn = view.running?.provider
  const providerCard = (p: ProviderView) => {
    const isRunning = runningOn === p.short && view.running
    return (
      <Box
        key={`card-${p.name}`}
        flexDirection="column"
        borderStyle="round"
        borderColor={isRunning ? PALETTE.brass : p.tone === 'ok' ? '#1F4A33' : p.tone === 'error' ? '#6A2E2E' : p.tone === 'dim' ? '#262C35' : '#5A4A1F'}
        paddingX={1}
        flexGrow={1}
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={STRONG} bold>{p.short}</Text>
          {isRunning && view.running ? (
            <Text color={PALETTE.brass}>{`${view.running.spinner} ${view.running.phase === 'verifying' ? `verificando · ${view.running.detail ?? '…'}` : `tocando · ${view.running.mode}`} · ${view.running.elapsed}`}</Text>
          ) : (
            <Text color={color(p.tone)}>{p.badge}</Text>
          )}
        </Box>
        <Text color={PALETTE.dim}>{[p.version, p.auth ? `auth ${p.auth === 'ok' ? 'ok' : p.auth === 'missing' ? 'ausente' : 'desconocida'}` : ''].filter(Boolean).join(' · ') || ' '}</Text>
        <Text>{'hoy     '}<Text color={color(p.tone)}>{bar(p.callsToday, view.maxCalls)}</Text><Text color={MUTED}>{` ${p.callsToday} llamadas`}</Text></Text>
        <Text>{'tokens  '}<Text color={p.tokensToday ? color(p.tone) : '#3A414C'}>{bar(p.tokensToday, view.maxTokens)}</Text><Text color={MUTED}>{p.tokensToday ? ` ${fmtTokens(p.tokensToday)}` : ' no reportados'}</Text></Text>
        <Text>{'tiempo  '}<Text color={color(p.tone)}>{bar(p.durationMsToday, view.maxDuration)}</Text><Text color={MUTED}>{` ${fmtDuration(p.durationMsToday)}`}</Text></Text>
        <Text color={p.tone === 'error' ? PALETTE.error : p.kind === 'cooldown' || p.kind === 'half_open' ? PALETTE.warn : PALETTE.dim}>{p.fix ?? p.breakerLine}</Text>
      </Box>
    )
  }

  const specCard = active ? (
    <Box key="card-spec" flexDirection="column" borderStyle="round" borderColor="#262C35" paddingX={1} flexGrow={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={STRONG} bold>{active.slug}</Text>
        <Text color={active.current?.state === 'en curso' ? PALETTE.brass : MUTED}>{active.current ? `${active.current.id} ${active.current.state}` : 'sin tareas abiertas'}</Text>
      </Box>
      <Text color={PALETTE.dim}>{`spec-driven · tasks ${active.status}`}</Text>
      <Text>{'tasks   '}<Text color={PALETTE.ok}>{bar(active.done, Math.max(1, active.total))}</Text><Text color={MUTED}>{` ${active.done}/${active.total}`}</Text></Text>
      <Text color={MUTED}>{active.current ? active.current.title.slice(0, 34) : ' '}</Text>
      <Text color={PALETTE.dim}>{active.current && active.current.owner !== '—' ? `owner ${active.current.owner}`.slice(0, 34) : 'sin owner'}</Text>
      <Text color={PALETTE.dim}>{active.current ? `/sdd-delegate ${active.slug} next` : ' '}</Text>
    </Box>
  ) : pipeline.length > 0 ? (
    <Box key="card-spec" flexDirection="column" borderStyle="round" borderColor="#262C35" paddingX={1} flexGrow={1}>
      <Text color={STRONG} bold>spec-driven</Text>
      {pipeline.map(l => (
        <Text key={`p-${l.slug}`} color={l.running ? PALETTE.brass : l.warn ? PALETTE.warn : MUTED}>{l.text}</Text>
      ))}
      <Text color={PALETTE.dim}>/sdd-status</Text>
    </Box>
  ) : null

  const cards = (
    <Box key="cards" flexDirection={wide ? 'row' : 'column'} gap={2}>
      {view.providers.map(providerCard)}
      {specCard ?? ''}
    </Box>
  )

  // One line of context under the cards: what's running, what to try, or why only Claude plays.
  const hint =
    view.kind === 'running' && view.running ? (
      <Text key="hint" color={PALETTE.dim}>{`  “${view.running.task}”`}</Text>
    ) : view.kind === 'first_use' ? (
      <Text key="hint">
        <Text color={MUTED}>La orquesta está afinada. Prueba </Text>
        <Text color={PALETTE.brass}>/delegate auto</Text>
        <Text color={MUTED}> o </Text>
        <Text color={PALETTE.brass}>/mp-doctor</Text>
      </Text>
    ) : view.kind === 'claude_only' ? (
      <Text key="hint" color={MUTED}>Claude toca solo: cada /delegate vuelve como fallback_to_claude.</Text>
    ) : null

  const recent = roomy ? (
    <Box key="recent" flexDirection="column">
      <Text color={PALETTE.dim}>últimas delegaciones</Text>
      {view.recent.length === 0 ? <Text color={PALETTE.dim}>  —</Text> : ''}
      {view.recent.map(r => (
        <Text key={`r-${r.id}`}>
          <Text color={PALETTE.dim}>{pad(r.time, 7)}</Text>
          <Text>{pad(r.who, 12)}</Text>
          <Text color={r.mode === 'write' ? PALETTE.brass : PALETTE.dim}>{pad(r.mode, 7)}</Text>
          <Text>{pad(r.task, wide ? 46 : 24)}</Text>
          <Text color={color(r.tone)}>{` ${r.outcome}`}</Text>
        </Text>
      ))}
      {view.pending ? <Text color={color(view.pending.tone)}>{view.pending.text}</Text> : ''}
    </Box>
  ) : null

  const notice = wasCleaned ? (
    <Box key="cleaned" flexDirection={wide ? 'row' : 'column'} justifyContent="space-between">
      <Text color={PALETTE.dim}>{`─ terminal limpia · contexto intacto${m.ctxPercent !== undefined ? ` (ctx ${m.ctxPercent}%)` : ''} · ${wasCleaned.rows} filas ocultas`}</Text>
      <Button key="restore" plain hotkey="h" label="ver historial" onPress={() => void restoreTerminal($)} />
    </Box>
  ) : null

  const footer = (
    <Box key="footer" flexDirection={wide ? 'row' : 'column'} justifyContent="space-between">
      <Box flexDirection={wide ? 'row' : 'column'} columnGap={3}>
        <Button key="status" plain hotkey="1" label="/providers-status" onPress={run('multi-provider:providers-status')} />
        <Button key="config" plain hotkey="2" label="/providers-config" onPress={run('multi-provider:providers-config')} />
        <Button
          key="cleanup"
          plain
          hotkey="3"
          label="limpiar worktrees"
          onPress={() => void $.prompt.submit({ text: 'Usa la herramienta delegation_cleanup de multi-provider para limpiar los worktrees mp/* descartables (conserva los diffs pendientes de revisión).' })}
        />
        <Button key="doctor" plain hotkey="4" label="/mp-doctor" onPress={run('multi-provider:mp-doctor')} />
        <Button key="clean" plain hotkey="5" label="clean-terminal" onPress={() => void cleanTerminal($)} />
      </Box>
      <Text color={PALETTE.dim}>
        {view.chain.map((c, i) => (
          <Text key={`c${i}`}>
            {i > 0 ? <Text color={PALETTE.dim}>{' → '}</Text> : ''}
            <Text color={c.name === 'claude' ? PALETTE.text : CHAIN_COLOR} strikethrough={c.struck}>{c.name}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  )

  const body: RenderChildren = [header, cards, hint ?? '', recent ?? '', notice ?? '', footer]
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={view.border} paddingX={1}>
      {body}
    </Box>
  )
}

export const register: Register = on => {
  let firstLoadDone = false

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('verdicts')
    if (stored && typeof stored === 'object') await update($, verdicts, () => stored as Record<string, string>)
    await loadAll($)
    firstLoadDone = true

    // One-second heartbeat. It only redraws while something moves on screen
    // (a delegation in progress or a cooldown counting down). state.json and the
    // session figures are re-read every 5 seconds, specs/ every 15.
    let seconds = 0
    $.clock.every(1000, async () => {
      seconds += 1
      if (seconds % 5 === 0) {
        await loadState($)
        await loadMeta($)
      }
      if (seconds % 15 === 0) await loadSpec($)
      if (seconds % 60 === 0) await loadCardConfig($)
      await syncPane($)
      const s = await read($, snap)
      const now = await $.clock.now()
      const counting = Object.values(s?.providers ?? {}).some(p => (p?.breaker?.cooldownUntil ?? 0) > now)
      if ((await read($, running)) || runningFromJobs(s) || counting) await update($, tick, t => t + 1)
    })

    try {
      await $.command.register({
        name: 'conductor',
        description: 'Muestra el header del conductor al lado de la conversación o debajo, sobre el prompt',
        argumentHint: 'lado|abajo',
        immediate: true,
      })
    } catch {
      /* name taken: placement still follows card.placement */
    }
    try {
      await $.command.register({
        name: 'clean-terminal',
        description: 'Limpia la terminal sin perder el contexto (la conversación sigue intacta)',
        immediate: true,
      })
    } catch {
      /* name taken: the rest of the band works without the command */
    }
    return next(e)
  })

  on('command.run', { command: 'conductor' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'abajo' || arg === 'below') {
      await setPlacement($, 'below')
      return { text: 'Header del conductor: debajo, sobre el prompt.' }
    }
    if (arg && arg !== 'lado' && arg !== 'side') return { text: 'Uso: /conductor lado | /conductor abajo' }
    await setPlacement($, 'side')
    return { text: 'Header del conductor: al lado de la conversación (en una terminal angosta se dibuja sobre el prompt).' }
  })

  // The person closed the pane: the band takes over until /conductor opens it again.
  on('ui.close', async ($, e, next) => {
    const res = await next(e)
    if (e.id === PANE) await update($, paneShown, () => false)
    return res
  })

  on('command.run', { command: 'clean-terminal' }, async $ => {
    await cleanTerminal($)
    return {}
  })

  // /clear starts a new conversation: nothing left to hide.
  on('session.end', async ($, e, next) => {
    seen.clear()
    hidden = new Set()
    await update($, cleaned, () => null).catch(() => undefined)
    return next(e)
  })

  for (const component of TRANSCRIPT_SITES) {
    on('ui.render', { component }, async ($, e, next) => {
      const id = e.requestId
      if (id) {
        if (hidden.has(id)) {
          const { Box } = $.ui.resolve(e)
          return <Box key="cleaned" />
        }
        seen.add(id)
      }
      return next(e)
    }).catch(($, e, next) => next(e))
  }

  // Pushed after each turn and when a window moves a whole point; no polling.
  on('session.measure', async ($, e, next) => {
    await update($, meta, (m: SessionMeta) => ({
      ...m,
      ...(e.context.percent !== undefined ? { ctxPercent: Math.round(e.context.percent) } : {}),
      ...(e.cost ? { costUsd: e.cost.usd } : {}),
      rateLimits: e.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    })).catch(() => undefined)
    return next(e)
  })

  // The plugin's server, and the same server when the repo is opened as a project.
  for (const tool of [
    'mcp__plugin_multi-provider_multi-provider__delegate',
    'mcp__multi-provider__delegate',
    'mcp__plugin_multi-provider_multi-provider__sdd_task_delegate',
    'mcp__multi-provider__sdd_task_delegate',
  ]) {
    const isSdd = tool.endsWith('sdd_task_delegate')
    on('tool.call', { tool }, async ($, e, next) => {
      if (isSdd) await markSddStart($, e).catch(() => undefined)
      else await markStart($, e).catch(() => undefined)
      try {
        const res = await next(e)
        await markDone($, res).catch(() => undefined)
        return res
      } finally {
        await markIdle($).catch(() => undefined)
      }
    }).catch(($, e, next) => next(e))
  }

  // Worker agents end their report with "VERDICT: …" (and "delegation: <id>").
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const res = await next(e)
    await recordVerdict($, e, res).catch(() => undefined)
    return res
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, enabled))) return next(e)
    if (!firstLoadDone) {
      // session.start normally loads it. Drawing is pure, so any other first
      // load happens on a timer; its state write draws the band again.
      firstLoadDone = true
      $.clock.after(0, () => loadAll($))
    }
    if ((await read($, placement)) === 'side' && (await read($, paneShown))) return next(e)
    return (await drawHeader($, e)) ?? next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Text } = $.ui.resolve(e)
    return (await drawHeader($, e)) ?? <Text color={PALETTE.dim}>◆ conductor · esperando el primer health check</Text>
  })
}

export type { CardView }
