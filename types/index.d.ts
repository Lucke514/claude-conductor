// Contract of the values the conductor card keeps in $.state (self-contained:
// mirrors the shapes in hooks/conductor/model.ts).

export type Running = { provider: string; mode: string; task: string; startedAt: number }
export type SessionTally = { calls: number; tokens: number }

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
      expanded: boolean
      running: Running | null
      tick: number
      verdicts: Record<string, string>
      session: SessionTally
    }
  }
}
