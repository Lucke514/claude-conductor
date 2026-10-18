import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
/** Files that must never be read into a prompt (credentials / secrets). */
const SENSITIVE = [
    /(^|[\\/])\.env(\..*)?$/i,
    /(^|[\\/])\.codex[\\/]/i,
    /(^|[\\/])auth\.json$/i,
    /(^|[\\/])\.gemini[\\/]/i,
    /(^|[\\/])\.ssh[\\/]/i,
    /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
    /\.(pem|key|p12|pfx|keystore|jks)$/i,
    /(^|[\\/])\.(npmrc|netrc|pypirc)$/i,
    /(^|[\\/])\.git-credentials$/i,
    /(^|[\\/])credentials(\.json)?$/i,
    /(^|[\\/])\.aws[\\/]/i,
    /(^|[\\/])\.config[\\/]gcloud[\\/]/i,
    /(^|[\\/])(oauth|token)s?\.json$/i,
    /(^|[\\/])secrets?\.(json|ya?ml|toml)$/i,
];
export function isSensitivePath(p) {
    return SENSITIVE.some((re) => re.test(p));
}
const LANG = {
    ".ts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx", ".json": "json",
    ".md": "md", ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".rb": "ruby",
    ".sh": "bash", ".yml": "yaml", ".yaml": "yaml", ".sql": "sql", ".css": "css", ".html": "html", ".cs": "csharp",
};
async function readFileForPrompt(rel, projectDir, maxFileBytes, budget) {
    const abs = path.resolve(projectDir, rel);
    const relToProject = path.relative(projectDir, abs);
    const display = relToProject.split(path.sep).join("/");
    if (relToProject.startsWith("..") || path.isAbsolute(relToProject)) {
        return { report: { path: rel, included: false, reason: "outside project directory" } };
    }
    if (isSensitivePath(abs) || isSensitivePath(display)) {
        return { report: { path: display, included: false, reason: "sensitive file (credentials/secrets) — never shared" } };
    }
    let buf;
    try {
        const st = await fs.stat(abs);
        if (!st.isFile())
            return { report: { path: display, included: false, reason: "not a regular file" } };
        const fh = await fs.open(abs, "r");
        try {
            const want = Math.min(st.size, maxFileBytes, Math.max(0, budget.left));
            buf = Buffer.alloc(want);
            await fh.read(buf, 0, want, 0);
        }
        finally {
            await fh.close();
        }
        if (buf.includes(0))
            return { report: { path: display, included: false, reason: "binary file" } };
        const truncated = buf.length < st.size;
        if (buf.length === 0 && st.size > 0) {
            return { report: { path: display, included: false, reason: "total prompt size budget exhausted" } };
        }
        budget.left -= buf.length;
        const lang = LANG[path.extname(abs).toLowerCase()] ?? "";
        const text = buf.toString("utf8");
        const fence = text.includes("```") ? "````" : "```";
        const note = truncated ? ` (truncated to ${buf.length} of ${st.size} bytes)` : "";
        return {
            report: { path: display, included: true, bytes: buf.length, truncated },
            block: `### ${display}${note}\n${fence}${lang}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}\n`,
        };
    }
    catch (err) {
        return { report: { path: display, included: false, reason: `unreadable: ${err.code ?? "error"}` } };
    }
}
export function constraintsFor(mode) {
    const common = [
        "You are a worker delegated by Claude Code, which supervises and reviews your result. You do NOT share its conversation context: rely only on this prompt and the repository in your current directory.",
        "Never run `git commit`, `git push`, create branches/tags, or open pull requests. Commits are reserved for the supervisor and are blocked by a hook.",
        "Never add `Co-authored-by:` trailers, 'Generated with …' lines or any AI attribution anywhere.",
        "Never read, print or copy credentials or secrets (e.g. ~/.codex/auth.json, OAuth tokens, .env files, private keys).",
        "Stay inside the current directory. Do not access the network unless the task strictly requires it.",
        "If something is ambiguous, state your assumption explicitly instead of asking questions — nobody will answer interactively.",
    ];
    if (mode === "read") {
        return [
            "READ-ONLY MODE: analyse and propose only. Do NOT create, modify, move or delete any file. Show proposed code changes as unified diffs or code blocks inside your answer.",
            ...common,
        ];
    }
    return [
        "WRITE MODE: you may edit files in the current directory (an isolated git worktree). Leave all changes uncommitted in the working tree.",
        "Keep changes minimal and focused on the objective. Do not reformat unrelated code or touch lockfiles unless required.",
        ...common,
    ];
}
export function outputFormatFor(mode) {
    const sections = [
        "Answer in Markdown with exactly these sections:",
        "## Summary — 1–3 sentences with the outcome.",
        mode === "write"
            ? "## Changes — list every file you changed and why."
            : "## Findings — numbered list; each item cites `path:line` when applicable.",
        mode === "write" ? "## Verification — commands you ran (lint/tests) and their result, or why you could not run them." : "## Proposal — concrete changes as unified diffs or code blocks (do not apply them).",
        "## Risks — anything the supervisor should double-check.",
    ];
    return sections.join("\n");
}
export async function buildPrompt(input) {
    const budget = { left: input.maxTotalBytes };
    const reports = [];
    const blocks = [];
    for (const f of input.files ?? []) {
        const { report, block } = await readFileForPrompt(f, input.projectDir, input.maxFileBytes, budget);
        reports.push(report);
        if (block)
            blocks.push(block);
    }
    const parts = [
        "# Delegated task",
        "",
        "## Objective",
        input.task.trim(),
        "",
        "## Constraints",
        ...constraintsFor(input.mode).map((c) => `- ${c}`),
        "",
    ];
    if (blocks.length > 0 || reports.length > 0) {
        parts.push("## Relevant files", "Contents captured by the supervisor (the repository in your current directory is the source of truth).", "");
        parts.push(...blocks);
        const skipped = reports.filter((r) => !r.included);
        if (skipped.length > 0) {
            parts.push("Files not included:", ...skipped.map((r) => `- ${r.path}: ${r.reason}`), "");
        }
    }
    parts.push("## Expected output", outputFormatFor(input.mode), "");
    const prompt = parts.join("\n");
    return { prompt, sha256: createHash("sha256").update(prompt).digest("hex"), files: reports };
}
//# sourceMappingURL=prompt-builder.js.map