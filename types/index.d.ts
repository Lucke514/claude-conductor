// Contract of the values the conductor header keeps in $.state (self-contained:
// mirrors the shapes in hooks/conductor/model.ts).

export type Running = { provider: string; mode: string; task: string; startedAt: number }
export type SessionTally = { calls: number; tokens: number }
export type SessionMeta = { model?: string; ctxPercent?: number; costUsd?: number; repo?: string; branch?: string }
export type Cleaned = { at: number; rows: number }
export type Placement = 'side' | 'below'

export type SpecTask = { id: string; title: string; box: string; owner: string }
export type SpecProgress = {
  slug: string
  status: string
  done: number
  total: number
  current?: SpecTask & { state: 'en curso' | 'siguiente' }
}

export type ProviderStateFile = {
  health?: { installed?: boolean; enabled?: boolean; auth?: string; version?: string }
  breaker?: { state?: string; consecutiveFailures?: number; cooldownUntil?: number | null }
  metrics?: {
    day?: string
    callsToday?: number
    tokensToday?: number
    durationMsToday?: number
    lastError?: { type: string; message?: string; at: string } | null
    lastCallAt?: string | null
  }
  history?: { at: string; ok: boolean; tokens: number; durationMs: number }[]
}

export type RecentFile = {
  id: string
  at: string
  requested?: string
  provider: string | null
  mode: string
  status: string
  task: string
  filesChanged?: number
  durationMs?: number
}

export type StateFile = {
  chain?: string[]
  providers?: { codex?: ProviderStateFile; antigravity?: ProviderStateFile }
  recent?: RecentFile[]
}

declare module 'claude-code' {
  interface PluginState {
    'multi-provider': {
      snap: StateFile | null
      enabled: boolean
      running: Running | null
      tick: number
      verdicts: Record<string, string>
      session: SessionTally
      meta: SessionMeta
      spec: SpecProgress | null
      cleaned: Cleaned | null
      placement: Placement
      paneShown: boolean
    }
  }
}
