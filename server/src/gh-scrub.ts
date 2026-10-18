import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAttributionLine, stripAttribution } from "./sanitize.js";

/**
 * Scrub attribution from Bash commands that create PR bodies or commits:
 *   gh pr create|edit --body "..."  /  --body-file <file>  /  -F <file>
 *   git commit -m "$(cat <<'EOF' ... EOF)"
 * Used by the PreToolUse(Bash) hook, which returns the rewritten command via updatedInput.
 */

export const TARGET_RE = /\bgh\s+pr\s+(?:create|edit)\b|\bgit\s+(?:-c\s+\S+\s+)*commit\b/;

/** Inline fragments, including the literal "\n" escapes in front of them. */
const INLINE: RegExp[] = [
  /(?:\\n)*[ \t]*co-authored-by:[^\\"'\n]*/gi,
  /(?:\\n)*[ \t]*🤖\s*generated\s+(?:with|by)\s+\[[^\]]*\]\([^)]*\)/giu,
  /(?:\\n)*[ \t]*🤖\s*generated\s+(?:with|by)\s+(?:claude\s+code|codex|antigravity|gemini)\b/giu,
  /(?:\\n)*[ \t]*generated\s+(?:with|by)\s+\[claude\s+code\]\([^)]*\)/gi,
  /(?:\\n)*[ \t]*claude-session:\s*https?:\/\/\S+?(?=\\n|["'\s]|$)/gi,
  /(?:\\n)*[ \t]*https?:\/\/(?:www\.)?claude\.ai\/(?:code\/)?session_[\w-]+/gi,
];

export interface ScrubResult {
  command: string;
  changed: boolean;
  bodyFiles: { from: string; to: string }[];
}

export function scrubCommand(
  command: string,
  io: { readFile?: (p: string) => string | undefined; writeTemp?: (content: string) => string; cwd?: string } = {},
): ScrubResult {
  if (!TARGET_RE.test(command)) return { command, changed: false, bodyFiles: [] };
  const readFile =
    io.readFile ??
    ((p: string) => {
      const abs = path.resolve(io.cwd ?? process.cwd(), p);
      return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    });
  const writeTemp =
    io.writeTemp ??
    ((content: string) => {
      const f = path.join(os.tmpdir(), `mp-pr-body-${randomBytes(4).toString("hex")}.md`);
      writeFileSync(f, content, "utf8");
      return f;
    });

  // 1) Real lines (heredoc bodies).
  const lines = command.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (isAttributionLine(line)) continue;
    const blank = line.trim() === "";
    if (blank && kept.length > 0 && kept[kept.length - 1]!.trim() === "") continue;
    kept.push(line);
  }
  // Drop a blank line right before a heredoc terminator.
  for (let i = kept.length - 1; i > 0; i--) {
    if (/^\s*EOF\b/.test(kept[i]!) && kept[i - 1]!.trim() === "") {
      kept.splice(i - 1, 1);
    }
  }
  let out = kept.join("\n");

  // 2) Inline fragments in single-line bodies with literal \n escapes.
  for (const re of INLINE) out = out.replace(re, "");

  // 3) --body-file / -F <file>
  const bodyFiles: ScrubResult["bodyFiles"] = [];
  out = out.replace(
    /(--body-file(?:=|\s+)|(?<=\s)-F\s+)("([^"]+)"|'([^']+)'|([^\s"';|&]+))/g,
    (match, flag: string, _tok: string, dq?: string, sq?: string, bare?: string) => {
      const file = dq ?? sq ?? bare ?? "";
      if (!file || file === "-") return match;
      const content = readFile(file);
      if (content === undefined) return match;
      const cleaned = stripAttribution(content);
      if (cleaned === content) return match;
      const tmp = writeTemp(cleaned);
      bodyFiles.push({ from: file, to: tmp });
      return `${flag}${quoteForShell(tmp)}`;
    },
  );
  return { command: out, changed: out !== command, bodyFiles };
}

function quoteForShell(p: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}
