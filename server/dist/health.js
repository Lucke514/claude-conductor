import { CircuitBreaker } from "./circuit-breaker.js";
import { AntigravityAdapter } from "./providers/antigravity.js";
import { CodexAdapter } from "./providers/codex.js";
import { PROVIDER_NAMES } from "./providers/types.js";
export function makeAdapters(config) {
    return {
        codex: new CodexAdapter(config.providers.codex),
        antigravity: new AntigravityAdapter(config.providers.antigravity),
    };
}
export function makeBreaker(config) {
    return new CircuitBreaker({ threshold: config.circuitBreaker.threshold, cooldownMs: config.circuitBreaker.cooldownMs });
}
export async function checkHealth(config, store, adapters = makeAdapters(config)) {
    const state = await store.read();
    const breaker = makeBreaker(config);
    for (const p of PROVIDER_NAMES)
        breaker.load(p, state.providers[p]?.breaker);
    const reports = await Promise.all(PROVIDER_NAMES.map(async (p) => {
        if (!config.providers[p].enabled) {
            return { provider: p, enabled: false, installed: false, auth: "unknown", checkedAt: new Date().toISOString(), error: "disabled in config" };
        }
        try {
            return await adapters[p].healthCheck();
        }
        catch (err) {
            return { provider: p, enabled: true, installed: false, auth: "unknown", checkedAt: new Date().toISOString(), error: err.message };
        }
    }));
    const statuses = reports.map((r) => {
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
//# sourceMappingURL=health.js.map