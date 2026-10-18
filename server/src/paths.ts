import os from "node:os";
import path from "node:path";

/** Base dir for persistent state. Overridable for tests via MP_HOME. */
export function mpHome(): string {
  return process.env.MP_HOME ?? path.join(os.homedir(), ".claude", "multi-provider");
}

export const statePath = (): string => path.join(mpHome(), "state.json");
export const logsDir = (): string => path.join(mpHome(), "logs");
export const patchesDir = (): string => path.join(mpHome(), "patches");
export const worktreesDir = (): string => path.join(mpHome(), "worktrees");

/** User-level config (overrides the project one). Overridable via MP_USER_CONFIG. */
export function userConfigPath(): string {
  return process.env.MP_USER_CONFIG ?? path.join(os.homedir(), ".claude", "multiprovider.json");
}

export function projectConfigPath(projectDir: string): string {
  return path.join(projectDir, ".claude", "multiprovider.json");
}
