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
/** Failures the plugin or its configuration caused: they never count against the provider. */
const NOT_ATTRIBUTABLE = ["CANCELLED", "STALLED", "PERMISSION_BLOCKED"];
export function isAttributable(type) {
    return !NOT_ATTRIBUTABLE.includes(type);
}
export const PROVIDER_NAMES = ["codex", "antigravity"];
//# sourceMappingURL=types.js.map