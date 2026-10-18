import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate all persistent state from the real ~/.claude.
const root = mkdtempSync(path.join(os.tmpdir(), "mp-test-"));
process.env.MP_HOME = path.join(root, "mp-home");
process.env.MP_USER_CONFIG = path.join(root, "user-multiprovider.json");
process.env.MP_CLAUDE_SETTINGS = path.join(root, "claude-settings.json");
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.MP_CLAUDE_COMMIT;
