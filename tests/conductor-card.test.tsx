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
  on('fs.read', async ($, e) => {
    const f = files[e.path]
    if (f === undefined) return { deny: `ENOENT ${e.path}` }
    return { value: typeof f === 'string' ? f : JSON.stringify(f) }
  })
  // What the engine draws when no plugin draws the band.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  return clock
}

const text = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

describe('conductor card', () => {
  test('compact band shows providers, cooldown, chain and last delegation', async ($, on) => {
    const clock = world(on, { '/home/u/.claude/multi-provider/state.json': STATE })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(10)
    const t = await text(ui)
    expect(t).toContain('◆ conductor')
    expect(t).toContain('● afinado')
    expect(t).toContain('◐ silencio 2m')
    expect(t).toContain('review src/auth')
    expect(t).toContain('partitura ')
    expect(await ui.find({ key: 'toggle' })).toBeDefined()
    await ui.unmount()
    // The band is also raised on the desktop app: the same tree must validate there.
    const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await text(desk)).toContain('◆ conductor')
    await desk.unmount()
  })

  test('expands with the e button and lists recent delegations', async ($, on) => {
    const clock = world(on, { '/home/u/.claude/multi-provider/state.json': STATE })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(10)
    await ui.press({ key: 'toggle' })
    const t = await text(ui)
    expect(t).toContain('últimas delegaciones')
    expect(t).toContain('reintenta 02:00')
    expect(await ui.find({ key: 'status' })).toBeDefined()
    await ui.unmount()
  })

  test('first use teaches the next step', async ($, on) => {
    const fresh = { chain: STATE.chain, providers: { codex: { health: { installed: true, enabled: true, auth: 'ok' } }, antigravity: { health: { installed: true, enabled: true, auth: 'unknown' } } } }
    const clock = world(on, { '/home/u/.claude/multi-provider/state.json': fresh })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(10)
    expect(await text(ui)).toContain('La orquesta está afinada')
    await ui.unmount()
  })

  test('draws nothing without state.json or when card.enabled is false', async ($, on) => {
    const clock = world(on, { '/home/u/.claude/multiprovider.json': { card: { enabled: false } }, '/home/u/.claude/multi-provider/state.json': STATE })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(10)
    expect(await text(ui)).not.toContain('conductor')
    await ui.unmount()
  })
})
