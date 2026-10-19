import os from "node:os";
import path from "node:path";
/** Base dir for persistent state. Overridable for tests via MP_HOME. */
export function mpHome() {
    return process.env.MP_HOME ?? path.join(os.homedir(), ".claude", "multi-provider");
}
export const statePath = () => path.join(mpHome(), "state.json");
export const logsDir = () => path.join(mpHome(), "logs");
export const patchesDir = () => path.join(mpHome(), "patches");
export const worktreesDir = () => path.join(mpHome(), "worktrees");
export const locksDir = () => path.join(mpHome(), "locks");
/** User-level config (overrides the project one). Overridable via MP_USER_CONFIG. */
export function userConfigPath() {
    return process.env.MP_USER_CONFIG ?? path.join(os.homedir(), ".claude", "multiprovider.json");
}
export function projectConfigPath(projectDir) {
    return path.join(projectDir, ".claude", "multiprovider.json");
}
//# sourceMappingURL=paths.js.map