import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fsutil.js";
import { git, repoRootOf } from "../git.js";
import { parseTasks, SddError } from "./artifacts.js";
/**
 * Claim and handback of an SDD task (spec-driven's `**Owner**` rule). The tool
 * only rewrites the Owner line; Claude makes every commit (R6) with the command
 * returned here, whose pathspec keeps any other change out of it (E10).
 */
const CLOSED = { done: "done", waived: "waived", deferred: "deferred", blocked: "blocked" };
/** R5/E6: approved artifacts, open box and the expected owner (`null` = must be unclaimed). */
export function checkDelegable(feature, task, expectedOwner = null) {
    const artifacts = [
        ["spec.md", feature.statuses.spec],
        ...(feature.depth === "standard" ? [["tasks.md", feature.statuses.tasks]] : []),
        ...(feature.statuses.plan !== undefined ? [["plan.md", feature.statuses.plan]] : []),
    ];
    for (const [name, status] of artifacts) {
        if (status !== "approved") {
            throw new SddError("NOT_APPROVED", `specs/${feature.slug}/${name} is 'Status: ${status ?? "missing"}' — only approved artifacts can be delegated`);
        }
    }
    const closed = CLOSED[task.box];
    if (closed)
        throw new SddError("TASK_CLOSED", `${task.id} is ${closed} and cannot be delegated`);
    if (task.owner !== expectedOwner) {
        throw new SddError("TASK_CLAIMED", expectedOwner === null
            ? `${task.id} is already claimed by '${task.owner}' — release it first (sdd_task_release) if that claim is stale`
            : `${task.id} is owned by '${task.owner ?? "—"}', not '${expectedOwner}' — claim it with sdd_task_claim first`);
    }
}
export const ownerValue = (provider, date = new Date()) => `${provider} (multi-provider) since ${date.toISOString().slice(0, 10)}`;
/** Replace the `**Owner**` line of one task in text, keeping every other byte. */
export function replaceOwner(text, taskId, value) {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => new RegExp(`^#{2,3} ${taskId}\\b`).test(l));
    if (start < 0)
        throw new SddError("TASK_NOT_FOUND", `task '${taskId}' not found`);
    for (let i = start + 1; i < lines.length && !/^#{1,3} /.test(lines[i]); i++) {
        const m = /^(- \*\*Owner\*\*:).*?(\r?)$/.exec(lines[i]);
        if (m) {
            lines[i] = `${m[1]} ${value}${m[2]}`;
            return lines.join("\n");
        }
    }
    throw new SddError("TASK_NOT_FOUND", `task '${taskId}' has no **Owner** line`);
}
/** Write the Owner line of a task into the user's working tree (R6 claim, R9 handback with `—`). */
export async function writeOwner(projectDir, feature, taskId, value) {
    const file = path.join(projectDir, feature.tasksFile);
    const [text, st] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    await writeFileAtomic(file, replaceOwner(text, taskId, value));
    await fs.chmod(file, st.mode & 0o777);
}
/** `git commit -m "<slug>: claim T3" -- specs/<slug>/tasks.md`: only the tasks file goes in (E10). */
export function commitCommand(feature, taskId, kind) {
    const message = `${feature.slug}: ${kind} ${taskId}`;
    const argv = ["git", "commit", "-m", message, "--", feature.tasksFile];
    return { argv, display: `git commit -m "${message}" -- ${feature.tasksFile}` };
}
/** SC2: HEAD holds the claim and the working tree has not reverted it. */
export async function claimCommitted(projectDir, feature, taskId, owner) {
    if (!(await repoRootOf(projectDir)))
        return false;
    // `HEAD:./path` resolves against cwd, so symlinked or 8.3 temp paths never mismatch the repo root.
    const head = await git(["show", `HEAD:./${feature.tasksFile}`], projectDir);
    if (head.code !== 0)
        return false;
    const committed = parseTasks(head.stdout).find((t) => t.id === taskId);
    const current = feature.tasks.find((t) => t.id === taskId);
    return committed?.owner === owner && current?.owner === owner;
}
export function notCommittedError(feature, taskId, owner) {
    return new SddError("CLAIM_NOT_COMMITTED", `the claim of ${taskId} ('${owner}') is not committed in HEAD — run \`${commitCommand(feature, taskId, "claim").display}\` first. No worker was started.`);
}
//# sourceMappingURL=claim.js.map