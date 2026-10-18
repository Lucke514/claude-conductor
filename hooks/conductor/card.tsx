// Conductor card: a band above the prompt showing the multi-provider
// orchestra (provider health, circuit breakers, recent delegations, live
// progress). Reads ~/.claude/multi-provider/state.json; never runs the CLIs.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, ToolCallResult } from 'claude-code'

import type { Running, SessionTally, StateFile } from '../../types'
import {
  bar,
  buildCard,
  fmtDuration,
  fmtTokens,
  pad,
  PALETTE,
  parseVerdict,
  type CardView,
  type ProviderView,
  type Tone,
} from './model'

const snap = atom({ plugin: 'multi-provider', key: 'snap' } as const, null)
const enabled = atom({ plugin: 'multi-provider', key: 'enabled' } as const, true)
const expanded = atom({ plugin: 'multi-provider', key: 'expanded' } as const, false)
const running = atom({ plugin: 'multi-provider', key: 'running' } as const, null)
const tick = atom({ plugin: 'multi-provider', key: 'tick' } as const, 0)
const verdicts = atom({ plugin: 'multi-provider', key: 'verdicts' } as const, {})
const session = atom({ plugin: 'multi-provider', key: 'session' } as const, { calls: 0, tokens: 0 })

const CHAIN_COLOR = '#6CC6D8'
const MUTED = '#AAB1BC'
const STRONG = '#F2F4F7'
const MAX_VERDICTS = 30

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

/** card.enabled from ~/.claude/multiprovider.json (wins) or the project's .claude/multiprovider.json. */
async function loadEnabled($: EngineInterface): Promise<void> {
  const home = await homeDir($)
  const userPath = (await $.env.get('MP_USER_CONFIG')) ?? (home ? `${home}/.claude/multiprovider.json` : undefined)
  const pick = (c: unknown) => (c as { card?: { enabled?: unknown } } | undefined)?.card?.enabled
  const user = userPath ? pick(await readJson($, userPath)) : undefined
  const project = pick(await readJson($, '.claude/multiprovider.json'))
  const value = typeof user === 'boolean' ? user : typeof project === 'boolean' ? project : true
  if ((await read($, enabled)) !== value) await update($, enabled, () => value)
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

export const register: Register = on => {
  let firstLoadDone = false

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('verdicts')
    if (stored && typeof stored === 'object') await update($, verdicts, () => stored as Record<string, string>)
    if ((await $.store.get('expanded')) === true) await update($, expanded, () => true)
    await loadEnabled($)
    await loadState($)
    firstLoadDone = true

    // One-second heartbeat. It only redraws while something moves on screen
    // (a delegation in progress or a cooldown counting down); state.json is
    // re-read every 10 seconds.
    let seconds = 0
    $.clock.every(1000, async () => {
      seconds += 1
      if (seconds % 10 === 0) {
        await loadState($)
        if (seconds % 60 === 0) await loadEnabled($)
      }
      const s = await read($, snap)
      const now = await $.clock.now()
      const counting = Object.values(s?.providers ?? {}).some(p => (p?.breaker?.cooldownUntil ?? 0) > now)
      if ((await read($, running)) || counting) await update($, tick, t => t + 1)
    })
    return next(e)
  })

  // The plugin's server, and the same server when the repo is opened as a project.
  on('tool.call', { tool: 'mcp__plugin_multi-provider_multi-provider__delegate' }, async ($, e, next) => {
    await markStart($, e).catch(() => undefined)
    try {
      const res = await next(e)
      await markDone($, res).catch(() => undefined)
      return res
    } finally {
      await markIdle($).catch(() => undefined)
    }
   }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'mcp__multi-provider__delegate' }, async ($, e, next) => {
    await markStart($, e).catch(() => undefined)
    try {
      const res = await next(e)
      await markDone($, res).catch(() => undefined)
      return res
    } finally {
      await markIdle($).catch(() => undefined)
    }
   }).catch(($, e, next) => next(e))

  // Worker agents end their report with "VERDICT: …" (and "delegation: <id>").
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const res = await next(e)
    await recordVerdict($, e, res).catch(() => undefined)
    return res
   }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, enabled))) return next(e)
    const state = await read($, snap)
    if (!firstLoadDone) {
      // session.start normally loads it. Drawing is pure, so any other first
      // load happens on a timer; its state write draws the band again.
      firstLoadDone = true
      $.clock.after(0, async () => {
        await loadEnabled($)
        await loadState($)
      })
    }
    if (!state) return next(e)
    const isExpanded = await read($, expanded)
    const view = buildCard({
      state,
      now: await $.clock.now(),
      running: await read($, running),
      verdicts: await read($, verdicts),
      session: await read($, session),
      tick: await read($, tick),
    })
    const { Box, Text, Button } = $.ui.resolve(e)
    const wide = e.props.bodyColumns >= 100

    const toggle = async () => {
      const value = !(await read($, expanded))
      await update($, expanded, () => value)
      await $.store.set('expanded', value)
    }
    const run = (command: string) => () => void $.command.run({ command })

    const header = (
      <Box key="header" flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color={PALETTE.brass} bold>◆ conductor</Text>
          <Text color={PALETTE.dim}>{`  ·  ${view.summary}`}</Text>
        </Text>
        <Text color={PALETTE.dim}>
          {'partitura '}
          {view.chain.map((c, i) => (
            <Text key={`c${i}`}>
              {i > 0 ? <Text color={PALETTE.dim}>{' → '}</Text> : ''}
              <Text color={c.name === 'claude' ? PALETTE.text : CHAIN_COLOR} strikethrough={c.struck}>{c.name}</Text>
            </Text>
          ))}
        </Text>
      </Box>
    )

    const providerRow = (p: ProviderView) => (
      <Box key={`row-${p.name}`} flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color={STRONG} bold>{pad(p.short, 7)}</Text>
          <Text color={color(p.tone)}>{pad(p.badge, 17)}</Text>
          <Text color={MUTED}>{p.detail}</Text>
        </Text>
        <Text color={color(p.tone)}>{p.spark}</Text>
      </Box>
    )

    const lastLine = view.last ? (
      <Text key="last" color={PALETTE.dim}>
        {'última  '}
        <Text color={PALETTE.text}>{view.last.who}</Text>
        {` · ${view.last.task} · `}
        <Text color={color(view.last.tone)}>{view.last.outcome}</Text>
        {` · ${view.last.ago}`}
      </Text>
    ) : (
      <Text key="last" color={PALETTE.dim}>sin delegaciones todavía</Text>
    )

    const footer = (extra?: RenderChildren) => (
      <Box key="footer" flexDirection="row" justifyContent="space-between">
        {lastLine}
        <Box flexDirection="row" gap={2}>
          {extra}
          <Button key="toggle" plain hotkey="e" label={isExpanded ? 'compactar' : 'expandir'} onPress={toggle} />
        </Box>
      </Box>
    )

    let body: RenderChildren
    if (view.kind === 'running' && view.running) {
      const r = view.running
      const others = view.providers.filter(p => p.short !== r.provider)
      body = [
        <Text key="run">
          <Text color={PALETTE.brass}>{`${r.spinner} `}</Text>
          <Text color={STRONG} bold>{r.provider}</Text>
          <Text>{` tocando · `}</Text>
          <Text color={r.mode === 'write' ? PALETTE.brass : MUTED}>{r.mode}</Text>
          <Text>{` · ${r.elapsed}`}</Text>
        </Text>,
        <Text key="task" color={PALETTE.dim}>{`  “${r.task}”`}</Text>,
        <Text key="others">
          {others.map(p => (
            <Text key={`o-${p.name}`}>
              <Text color={PALETTE.dim}>{`${p.short} `}</Text>
              <Text color={color(p.tone)}>{`${p.badge}   `}</Text>
            </Text>
          ))}
        </Text>,
      ]
    } else if (view.kind === 'first_use') {
      body = [
        <Text key="ready">
          {view.providers.map(p => (
            <Text key={`r-${p.name}`}>
              <Text color={STRONG} bold>{`${p.short} `}</Text>
              <Text color={color(p.tone)}>{`${p.badge}     `}</Text>
            </Text>
          ))}
        </Text>,
        <Text key="hint1" color={MUTED}>La orquesta está afinada. Prueba:</Text>,
        <Text key="hint2">
          <Text color={PALETTE.brass}>{'  /delegate auto'}</Text>
          <Text>{' revisa este módulo y dame una segunda opinión'}</Text>
        </Text>,
        <Box key="footer" flexDirection="row" gap={2}>
          <Button key="setup" plain hotkey="s" label="/mp-setup" onPress={run('multi-provider:mp-setup')} />
        </Box>,
      ]
    } else if (view.kind === 'claude_only') {
      body = [
        <Text key="none">
          {view.providers.map(p => (
            <Text key={`n-${p.name}`}>
              <Text color={STRONG} bold>{`${p.short} `}</Text>
              <Text color={color(p.tone)}>{`${p.badge}   `}</Text>
            </Text>
          ))}
        </Text>,
        <Text key="solo" color={MUTED}>Claude toca solo: cada /delegate vuelve como fallback_to_claude.</Text>,
        <Box key="footer" flexDirection="row" gap={2}>
          <Button key="status" plain hotkey="1" label="/providers-status" onPress={run('multi-provider:providers-status')} />
        </Box>,
      ]
    } else if (isExpanded) {
      const card = (p: ProviderView) => (
        <Box
          key={`card-${p.name}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={p.tone === 'ok' ? '#1F4A33' : p.tone === 'error' ? '#6A2E2E' : '#5A4A1F'}
          paddingX={1}
          flexGrow={1}
        >
          <Box flexDirection="row" justifyContent="space-between">
            <Text color={STRONG} bold>{p.short}</Text>
            <Text color={color(p.tone)}>{p.badge}</Text>
          </Box>
          <Text color={PALETTE.dim}>{[p.version, p.auth ? `auth ${p.auth === 'ok' ? 'ok' : p.auth === 'missing' ? 'ausente' : 'desconocida'}` : ''].filter(Boolean).join(' · ') || ' '}</Text>
          <Text>{'hoy     '}<Text color={color(p.tone)}>{bar(p.callsToday, view.maxCalls)}</Text><Text color={MUTED}>{` ${p.callsToday} llamadas`}</Text></Text>
          <Text>{'tokens  '}<Text color={p.tokensToday ? color(p.tone) : '#3A414C'}>{bar(p.tokensToday, view.maxTokens)}</Text><Text color={MUTED}>{p.tokensToday ? ` ${fmtTokens(p.tokensToday)}` : ' no reportados'}</Text></Text>
          <Text>{'tiempo  '}<Text color={color(p.tone)}>{bar(p.durationMsToday, view.maxDuration)}</Text><Text color={MUTED}>{` ${fmtDuration(p.durationMsToday)}`}</Text></Text>
          <Text color={p.kind === 'cooldown' || p.kind === 'half_open' ? PALETTE.warn : PALETTE.dim}>{p.fix ?? p.breakerLine}</Text>
        </Box>
      )
      body = [
        <Box key="cards" flexDirection={wide ? 'row' : 'column'} gap={2}>
          {view.providers.map(card)}
        </Box>,
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
        </Box>,
        <Box key="footer" flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={3}>
            <Button key="status" plain hotkey="1" label="/providers-status" onPress={run('multi-provider:providers-status')} />
            <Button key="config" plain hotkey="2" label="/providers-config" onPress={run('multi-provider:providers-config')} />
            <Button
              key="cleanup"
              plain
              hotkey="3"
              label="limpiar worktrees"
              onPress={() => void $.prompt.submit({ text: 'Usa la herramienta delegation_cleanup de multi-provider para limpiar los worktrees mp/* huérfanos.' })}
            />
          </Box>
          <Button key="toggle" plain hotkey="e" label="compactar" onPress={toggle} />
        </Box>,
      ]
    } else {
      const fixes = view.providers.filter(p => p.fix)
      body = [
        ...view.providers.map(providerRow),
        footer(fixes.length ? <Button key="status" plain hotkey="1" label="/providers-status" onPress={run('multi-provider:providers-status')} /> : undefined),
      ]
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={view.border} paddingX={1}>
        {header}
        {body}
      </Box>
    )
  })
}

export type { CardView }
