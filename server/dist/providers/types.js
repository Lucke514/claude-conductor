export const ERROR_TYPES = [
    "NOT_INSTALLED",
    "AUTH",
    "RATE_LIMIT",
    "QUOTA",
    "TIMEOUT",
    "NON_ZERO_EXIT",
    "EMPTY_OUTPUT",
    "PARSE_ERROR",
    /** The delegation was cancelled (MCP cancellation or delegation_cancel): never the provider's fault. */
    "CANCELLED",
    /** No output for `idleTimeoutMs`: killed by the plugin, not the provider's fault. */
    "STALLED",
    /** The worker waited for a permission the headless run cannot grant (configuration). */
    "PERMISSION_BLOCKED",
];
/**
 * The failures a provider is to blame for (R7). Everything else — cancelled, stalled, a
 * permission the headless run cannot grant, a binary that is not installed — never counts.
 */
const ATTRIBUTABLE = ["AUTH", "QUOTA", "RATE_LIMIT", "PARSE_ERROR", "EMPTY_OUTPUT", "NON_ZERO_EXIT", "TIMEOUT"];
export function isAttributable(type) {
    return ATTRIBUTABLE.includes(type);
}
export const PROVIDER_NAMES = ["codex", "antigravity"];
//# sourceMappingURL=types.js.map