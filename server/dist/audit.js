import { promises as fs } from "node:fs";
import path from "node:path";
import { logsDir } from "./paths.js";
import { today } from "./state.js";
export async function appendAudit(entry, dir = logsDir()) {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, `${today()}.jsonl`), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}
//# sourceMappingURL=audit.js.map