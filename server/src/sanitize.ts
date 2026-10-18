/**
 * Attribution / co-authorship scrubbing for commit messages and PR bodies.
 *
 * This module has NO imports on purpose: the compiled file is copied verbatim
 * into a repo's hooks directory by `/mp-setup` and must run standalone.
 */

/** Whole-line patterns removed from messages (case-insensitive). */
export const ATTRIBUTION_LINE_PATTERNS: RegExp[] = [
  // Any co-author trailer (Claude, Codex, agy, anyone else).
  /^\s*co-authored-by\s*:.*$/i,
  // "🤖 Generated with [Claude Code](https://claude.com/claude-code)" and variants.
  /^\s*(?:🤖\s*)?generated\s+(?:with|by)\s+\[?claude(?:\s+code)?\]?(?:\(.*?\))?.*$/i,
  /^\s*🤖\s*generated\b.*$/iu,
  // Codex / Antigravity / Gemini style attribution lines.
  /^\s*(?:🤖\s*)?generated\s+(?:with|by)\s+\[?(?:openai\s+)?(?:codex|antigravity|gemini|google\s+antigravity)\b.*$/i,
  // Session trailers / links (claude.ai/code/session_..., claude.ai/chat/...).
  /^\s*claude-session\s*:.*$/i,
  /^\s*(?:\S+\s*)?https?:\/\/(?:www\.)?claude\.ai\/(?:code\/)?(?:session|chat)[\w/\-?=&#.%]*\s*$/i,
];

/** Inline fragments removed when they appear inside a line. */
const INLINE_PATTERNS: RegExp[] = [
  /🤖\s*Generated\s+(?:with|by)\s+\[[^\]]*\]\([^)]*\)/giu,
  /🤖\s*Generated\s+(?:with|by)\s+(?:Claude\s+Code|Codex|Antigravity|Gemini)\b/giu,
  /Generated\s+(?:with|by)\s+\[Claude\s+Code\]\([^)]*\)/gi,
  /https?:\/\/(?:www\.)?claude\.ai\/(?:code\/)?session_[\w-]+/gi,
];

export function isAttributionLine(line: string): boolean {
  return ATTRIBUTION_LINE_PATTERNS.some((re) => re.test(line));
}

/**
 * Remove attribution lines and fragments. Keeps git comment lines ("# ...")
 * untouched and collapses the blank lines left behind.
 */
export function stripAttribution(message: string): string {
  const eol = message.includes("\r\n") ? "\r\n" : "\n";
  const lines = message.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    if (isAttributionLine(raw)) continue;
    let line = raw;
    for (const re of INLINE_PATTERNS) line = line.replace(re, "");
    if (line !== raw && line.trim() === "") continue;
    out.push(line.replace(/[ \t]+$/, line === raw ? "" : ""));
  }
  // Collapse 3+ consecutive blank lines into 1 and trim trailing blanks.
  const collapsed: string[] = [];
  for (const l of out) {
    const blank = l.trim() === "";
    const prevBlank = collapsed.length > 0 && collapsed[collapsed.length - 1]!.trim() === "";
    if (blank && prevBlank) continue;
    collapsed.push(l);
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1]!.trim() === "") collapsed.pop();
  const trailingNewline = /\r?\n$/.test(message);
  return collapsed.join(eol) + (trailingNewline && collapsed.length > 0 ? eol : "");
}

export function hasAttribution(message: string): boolean {
  return stripAttribution(message) !== message.replace(/(\r?\n)+$/, (m) => (m.length ? m.slice(0, m.includes("\r") ? 2 : 1) : m));
}

/**
 * Clean a body that is embedded in a single shell argument using literal
 * "\n" escapes (e.g. gh pr create --body "Summary\n\n🤖 Generated with ...").
 */
export function stripAttributionEscaped(body: string): string {
  if (!body.includes("\\n")) return stripAttribution(body);
  const decoded = body.split("\\n").join("\n");
  return stripAttribution(decoded).split("\n").join("\\n");
}
