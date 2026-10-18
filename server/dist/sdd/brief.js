/** The criteria the worker must answer for: each Acceptance clause, then each implemented `R#`/`E#`. */
export function acceptanceItems(feature, task) {
    const clauses = (task.acceptance ?? "")
        .split(/;\s+/)
        .map((c) => c.trim().replace(/\.$/, ""))
        .filter(Boolean);
    return [
        ...clauses.map((text, i) => ({ id: `A${i + 1}`, text })),
        ...task.implements.map((id) => ({ id, text: feature.requirements.get(id)?.split("\n")[0]?.replace(/^- \*\*[RE]\d+\*\*\s*[—–-]\s*/, "") ?? id })),
    ];
}
export const ACCEPTANCE_VERDICTS = ["met", "not met", "unverifiable"];
export function buildTaskBrief(feature, task) {
    const lines = [
        `Implement task ${task.id} — ${task.title} of the spec-driven feature \`${feature.slug}\`.`,
        "The artifacts below are approved: follow them literally. Do not edit anything under `specs/`.",
        "",
        "### Task",
        `- **Files**: ${task.files.map((f) => `\`${f}\``).join(", ") || "—"}`,
        `- **Do**: ${task.do ?? "—"}`,
        `- **Acceptance**: ${task.acceptance ?? "—"}`,
        `- **Verify**: ${task.verify ?? "—"}`,
    ];
    if (task.implements.length > 0) {
        lines.push("", "### Requirements this task implements (from spec.md)");
        for (const id of task.implements)
            lines.push(feature.requirements.get(id) ?? `- **${id}** — (missing from spec.md)`);
    }
    if (task.component) {
        const section = feature.components.get(task.component);
        if (section)
            lines.push("", "### Component (from plan.md)", section.replace(/^### /, "#### "));
    }
    const gates = feature.gates.filter((g) => g.commands.length > 0);
    if (gates.length > 0) {
        lines.push("", "### Quality gates (every task must pass them with no new failures)");
        for (const g of gates)
            lines.push(`- ${g.gate}: ${g.commands.map((c) => `\`${c}\``).join(" · ")}${g.pipelineOnly ? " (CI only)" : ""}`);
    }
    const items = acceptanceItems(feature, task);
    const extraOutput = [
        "## Acceptance — one line per item below, exactly in this form: `- [met|not met|unverifiable] <id> — <evidence: test, file:line or command output>`",
        ...items.map((i) => `  - ${i.id}: ${i.text}`),
    ];
    return { task: lines.join("\n"), files: task.files, extraOutput };
}
//# sourceMappingURL=brief.js.map