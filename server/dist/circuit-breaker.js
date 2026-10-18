/**
 * Per-provider circuit breaker.
 *  closed    -> requests allowed; N consecutive failures open it.
 *  open      -> requests rejected until cooldown elapses.
 *  half_open -> one trial request; success closes, failure re-opens.
 */
export class CircuitBreaker {
    opts;
    states = new Map();
    now;
    constructor(opts) {
        this.opts = opts;
        this.now = opts.now ?? Date.now;
    }
    /** Seed from persisted state (state.json). */
    load(provider, snap) {
        if (snap)
            this.states.set(provider, { ...snap });
    }
    snapshot(provider) {
        const s = this.get(provider);
        // Reflect a lapsed cooldown without mutating.
        if (s.state === "open" && s.cooldownUntil !== null && this.now() >= s.cooldownUntil) {
            return { ...s, state: "half_open" };
        }
        return { ...s };
    }
    get(provider) {
        let s = this.states.get(provider);
        if (!s) {
            s = { state: "closed", consecutiveFailures: 0, openedAt: null, cooldownUntil: null };
            this.states.set(provider, s);
        }
        return s;
    }
    /** Whether a request may go through. Transitions open -> half_open after cooldown. */
    canRequest(provider) {
        const s = this.get(provider);
        if (s.state === "closed" || s.state === "half_open")
            return true;
        if (s.cooldownUntil !== null && this.now() >= s.cooldownUntil) {
            s.state = "half_open";
            return true;
        }
        return false;
    }
    remainingCooldownMs(provider) {
        const s = this.get(provider);
        if (s.state !== "open" || s.cooldownUntil === null)
            return 0;
        return Math.max(0, s.cooldownUntil - this.now());
    }
    onSuccess(provider) {
        this.states.set(provider, { state: "closed", consecutiveFailures: 0, openedAt: null, cooldownUntil: null });
    }
    onFailure(provider) {
        const s = this.get(provider);
        s.consecutiveFailures++;
        if (s.state === "half_open" || s.consecutiveFailures >= this.opts.threshold) {
            const now = this.now();
            s.state = "open";
            s.openedAt = now;
            s.cooldownUntil = now + this.opts.cooldownMs;
        }
    }
}
//# sourceMappingURL=circuit-breaker.js.map