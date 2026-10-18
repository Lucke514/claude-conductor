import { CircuitBreaker } from "./circuit-breaker.js";
import type { MpConfig } from "./config.js";
import { AntigravityAdapter } from "./providers/antigravity.js";
import { CodexAdapter } from "./providers/codex.js";
import { PROVIDER_NAMES, type HealthReport, type ProviderAdapter, type ProviderName } from "./providers/types.js";
import type { BreakerSnapshot, StateStore } from "./state.js";

export function makeAdapters(config: MpConfig): Record<ProviderName, ProviderAdapter> {
  return {
    codex: new CodexAdapter(config.providers.codex),
    antigravity: new AntigravityAdapter(config.providers.antigravity),
  };
}

export function makeBreaker(config: MpConfig): CircuitBreaker {
  return new CircuitBreaker({ threshold: config.circuitBreaker.threshold, cooldownMs: config.circuitBreaker.cooldownMs });
}

export interface ProviderStatus extends HealthReport {
  breaker: BreakerSnapshot & { remainingCooldownMs: number };
  /** Usable right now: enabled, installed, not unauthenticated, breaker not open. */
  available: boolean;
}

export async function checkHealth(
  config: MpConfig,
  store: StateStore,
  adapters: Record<ProviderName, ProviderAdapter> = makeAdapters(config),
): Promise<ProviderStatus[]> {
  const state = await store.read();
  const breaker = makeBreaker(config);
  for (const p of PROVIDER_NAMES) breaker.load(p, state.providers[p]?.breaker);

  const reports = await Promise.all(
    PROVIDER_NAMES.map(async (p): Promise<HealthReport> => {
      if (!config.providers[p].enabled) {
        return { provider: p, enabled: false, installed: false, auth: "unknown", checkedAt: new Date().toISOString(), error: "disabled in config" };
      }
      try {
        return await adapters[p].healthCheck();
      } catch (err) {
        return { provider: p, enabled: true, installed: false, auth: "unknown", checkedAt: new Date().toISOString(), error: (err as Error).message };
      }
    }),
  );

  const statuses = reports.map((r): ProviderStatus => {
    const snap = breaker.snapshot(r.provider);
    return {
      ...r,
      breaker: { ...snap, remainingCooldownMs: breaker.remainingCooldownMs(r.provider) },
      available: r.enabled && r.installed && r.auth !== "missing" && snap.state !== "open",
    };
  });

  await store.update((s) => {
    s.chain = [...config.chain];
    for (const st of statuses) {
      const p = (s.providers[st.provider] ??= {});
      p.health = {
        installed: st.installed,
        enabled: st.enabled,
        auth: st.auth,
        checkedAt: st.checkedAt,
        ...(st.version ? { version: st.version } : {}),
      };
    }
  });
  return statuses;
}
