import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-18T12:00:00Z')
const BAND = {
  plugin: 'multi-provider',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const

const STATE = {
  chain: ['codex', 'antigravity', 'claude'],
  providers: {
    codex: {
      health: { installed: true, enabled: true, auth: 'ok', version: 'codex-cli 0.48' },
      breaker: { state: 'closed', consecutiveFailures: 0, cooldownUntil: null },
      metrics: { day: '2026-10-18', callsToday: 3, tokensToday: 12000, durationMsToday: 102000, lastError: null, lastCallAt: '2026-10-18T11:56:00Z' },
      history: [
        { at: 'a', ok: true, tokens: 1000, durationMs: 1 },
        { at: 'b', ok: true, tokens: 4000, durationMs: 1 },
        { at: 'c', ok: true, tokens: 7000, durationMs: 1 },
      ],
    },
    antigravity: {
      health: { installed: true, enabled: true, auth: 'unknown' },
      breaker: { state: 'open', consecutiveFailures: 3, cooldownUntil: NOW + 120_000 },
      metrics: { day: '2026-10-18', callsToday: 1, tokensToday: 0, durationMsToday: 5000, lastError: { type: 'RATE_LIMIT', at: '2026-10-18T11:59:00Z' }, lastCallAt: '2026-10-18T11:59:00Z' },
    },
  },
  recent: [
    { id: '20261018115600-abc123', at: '2026-10-18T11:56:00Z', provider: 'codex', mode: 'read', status: 'success', task: 'review src/auth' },
  ],
}

function world(on: On, files: Record<string, unknown>) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  // Relative paths reach the hook resolved against the session's directory.
  const lookup = (path: string) => files[path] ?? Object.entries(files).find(([k]) => !k.startsWith('/') && path.endsWith(`/${k}`))?.[1]
  on('fs.read', async ($, e) => {
    const f = lookup(e.path)
    if (f === undefined) return { deny: `ENOENT ${e.path}` }
    return { value: typeof f === 'string' ? f : JSON.stringify(f) }
  })
  on('fs.list', async ($, e) => {
    const entries = (lookup(`${e.path}/`) as string[] | undefined) ?? []
    return { value: entries.map(name => ({ name, kind: 'dir', size: 0, isLink: false })) }
  })
  on('session.model', async () => ({ value: 'Opus 5.5' }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 84000, window: 200000, percent: 42 }, rateLimits: [], cost: { usd: 0.5 } } }))
  on('session.repo', async () => ({ value: { root: '/repo', remote: null, internal: false, name: 'claude-conductor' } }))
  // What the engine draws when no plugin draws the band.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  return clock
}

const text = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

const TASKS = `# Tasks: Demo

> Status: approved

## T1 — Parse the config

- [x] Done
- **Owner**: —

## T2 [P] — Gate auto-delegation

- [ ] Done
- **Owner**: codex (multi-provider) since 2026-10-18

## T3 [P] — Document the feature

- [ ] Done
- **Owner**: —
`

const FILES = {
  '/home/u/.claude/multi-provider/state.json': STATE,
  '/repo/.git/HEAD': 'ref: refs/heads/feature/sdd-guardrails\n',
  'specs/': ['sdd-guardrails'],
  'specs/sdd-guardrails/tasks.md': TASKS,
}

const MESSAGE = { plugin: 'multi-provider', component: 'UserMessage', props: { text: 'hola', origin: { kind: 'composer' }, isExpanded: false } } as never

describe('conductor header', () => {
  test('always expanded: session, provider cards, active spec, recent delegations and shortcuts', async ($, on) => {
    const clock = world(on, FILES)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(10)
    const t = await text(ui)
    expect(t).toContain('◆ conductor')
    expect(t).toContain('claude-conductor · feature/sdd-guardrails')
    expect(t).toContain('Opus 5.5')
    expect(t).toContain(' 42%')
    expect(t).toContain('$0.50')
    expect(t).toContain('● afinado')
    expect(t).toContain('◐ silencio 2m')
    expect(t).toContain('reintenta 02:00')
    expect(t).toContain('sdd-guardrails')
    expect(t).toContain('T2 en curso')
    expect(t).toContain(' 1/3')
    expect(t).toContain('últimas delegaciones')
    expect(t).toContain('review src/auth')
    for (const key of ['status', 'config', 'cleanup', 'doctor', 'clean']) expect(await ui.find({ key })).toBeDefined()
    expect(await ui.find({ key: 'toggle' })).toBeUndefined()
    await ui.unmount()
    // The band is also raised on the desktop app: the same tree must validate there.
    const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await text(desk)).toContain('◆ conductor')
    await desk.unmount()
  })

  test('first use teaches the next step', async ($, on) => {
    const fresh = { chain: STATE.chain, providers: { codex: { health: { installed: true, enabled: true, auth: 'ok' } }, antigravity: { health: { installed: true, enabled: true, auth: 'unknown' } } } }
    const clock = world(on, { '/home/u/.claude/multi-provider/state.json': fresh })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(10)
    const t = await text(ui)
    expect(t).toContain('La orquesta está afinada')
    expect(t).not.toContain('T2 en curso')
    await ui.unmount()
  })

  test('clean-terminal hides the rows drawn so far, keeps new ones, and restores on demand', async ($, on) => {
    const clock = world(on, FILES)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(10)
    const old = await $.ui.mount({ ...MESSAGE, surface: 'terminal', requestId: 'm-old' })
    expect(await old.find({ key: 'engine' })).toBeDefined()

    await band.press({ key: 'clean' })
    await old.redraw()
    expect(await old.find({ key: 'cleaned' })).toBeDefined()
    expect(await old.find({ key: 'engine' })).toBeUndefined()
    expect(await text(band)).toContain('terminal limpia · contexto intacto (ctx 42%) · 1 filas ocultas')

    const fresh = await $.ui.mount({ ...MESSAGE, surface: 'terminal', requestId: 'm-new' })
    expect(await fresh.find({ key: 'engine' })).toBeDefined()

    await band.press({ key: 'restore' })
    await old.redraw()
    expect(await old.find({ key: 'engine' })).toBeDefined()
    expect(await text(band)).not.toContain('terminal limpia')
    await Promise.all([band.unmount(), old.unmount(), fresh.unmount()])
  })

  test('the /clean-terminal command cleans without starting a turn', async ($, on) => {
    const clock = world(on, FILES)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(10)
    const old = await $.ui.mount({ ...MESSAGE, surface: 'terminal', requestId: 'm-1' })
    const out = await $.command.run({ command: 'clean-terminal' })
    expect(JSON.stringify(out)).not.toContain('text')
    await old.redraw()
    expect(await old.find({ key: 'cleaned' })).toBeDefined()
    await Promise.all([band.unmount(), old.unmount()])
  })

  test('draws nothing without state.json or when card.enabled is false', async ($, on) => {
    const clock = world(on, { '/home/u/.claude/multiprovider.json': { card: { enabled: false } }, '/home/u/.claude/multi-provider/state.json': STATE })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(10)
    expect(await text(ui)).not.toContain('conductor')
    await ui.unmount()
  })
})
