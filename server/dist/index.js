#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { delegate } from "./delegate.js";
import { SddError } from "./sdd/artifacts.js";
import { sddFeatureStatus } from "./sdd/pipeline.js";
import { sddTaskClaim, sddTaskDelegate, sddTaskRelease } from "./sdd/task-delegation.js";
import { checkHealth } from "./health.js";
import { StateStore } from "./state.js";
import { applyWorktree, cleanupWorktrees, readMeta, removeWorktree } from "./worktree.js";
const VERSION = "0.2.0";
export function projectDir() {
    const env = process.env.MP_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR;
    // Guard against an unexpanded "${CLAUDE_PROJECT_DIR}" placeholder.
    return env && !env.includes("${") ? env : process.cwd();
}
const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (err) => ({
    isError: true,
    content: [
        {
            type: "text",
            text: JSON.stringify({ status: "error", error: err.message ?? String(err), ...(err instanceof SddError ? { code: err.code } : {}) }),
        },
    ],
});
export function createServer() {
    const instanceId = `mcp-${process.pid}-${randomBytes(3).toString("hex")}`;
    const store = new StateStore();
    const server = new McpServer({ name: "multi-provider", version: VERSION });
    server.registerTool("delegate", {
        title: "Delegate a task to another AI CLI",
        description: "Delegate a self-contained task to a local AI CLI (codex = OpenAI Codex, antigravity = Google Antigravity `agy`). " +
            "Workers do NOT share your context: describe the task completely and list relevant files. " +
            "mode=read: analysis/proposals only (runs in a disposable worktree). mode=write: edits happen in an isolated git worktree " +
            "on a temporary mp/* branch; you get a diff to review and must apply it with delegation_apply (never auto-merged). " +
            "Always verify the result yourself. status=fallback_to_claude means you should do the task yourself.",
        inputSchema: {
            provider: z.enum(["codex", "antigravity", "auto"]).describe("Provider, or 'auto' to route by task type"),
            task: z.string().min(1).describe("Complete, self-contained task description"),
            files: z.array(z.string()).optional().describe("Relevant file paths (relative to the project) to embed in the prompt"),
            mode: z.enum(["read", "write"]).optional().describe("read (default) or write"),
            timeoutMs: z.number().int().positive().optional(),
            model: z.string().optional().describe("Model for the explicitly requested provider"),
            taskType: z.string().optional().describe("Routing key for provider=auto (e.g. review, refactor)"),
            fallback: z.boolean().optional().describe("Fall back through the chain on failure (default true)"),
            sessionId: z.string().optional().describe("Injected by the plugin hook; do not set manually"),
        },
    }, async (args) => {
        try {
            const dir = projectDir();
            const { config } = await loadConfig(dir);
            return json(await delegate(args, { projectDir: dir, config, store, instanceId }));
        }
        catch (err) {
            return fail(err);
        }
    });
    server.registerTool("providers_status", {
        title: "Provider health",
        annotations: { readOnlyHint: true, openWorldHint: false },
        description: "Health check for each provider: binary in PATH, --version, authentication and circuit-breaker state.",
        inputSchema: {},
    }, async () => {
        try {
            const { config } = await loadConfig(projectDir());
            const providers = await checkHealth(config, store);
            return json({ chain: config.chain, anyAvailable: providers.some((p) => p.available), providers });
        }
        catch (err) {
            return fail(err);
        }
    });
    server.registerTool("providers_config", {
        title: "Effective configuration",
        annotations: { readOnlyHint: true, openWorldHint: false },
        description: "Show the effective merged configuration (defaults <- project .claude/multiprovider.json <- ~/.claude/multiprovider.json).",
        inputSchema: {},
    }, async () => {
        try {
            return json(await loadConfig(projectDir()));
        }
        catch (err) {
            return fail(err);
        }
    });
    server.registerTool("delegation_apply", {
        title: "Apply a delegated diff",
        description: "Apply the current changes of a delegation worktree to the user's checkout with `git apply --3way` (no commit), " +
            "then delete the worktree and its mp/* branch. Only call after reviewing and verifying the diff. You commit afterwards.",
        inputSchema: { worktreePath: z.string().min(1) },
    }, async ({ worktreePath }) => {
        try {
            const id = `${Date.now()}-${randomBytes(3).toString("hex")}`;
            return json(await applyWorktree(worktreePath, id));
        }
        catch (err) {
            return fail(err);
        }
    });
    server.registerTool("delegation_discard", {
        title: "Discard a delegation",
        description: "Delete a delegation worktree and its mp/* branch without applying anything.",
        inputSchema: { worktreePath: z.string().min(1) },
    }, async ({ worktreePath }) => {
        try {
            const meta = await readMeta(worktreePath);
            await removeWorktree(meta);
            return json({ discarded: true, worktreePath, branch: meta.branch });
        }
        catch (err) {
            return fail(err);
        }
    });
    server.registerTool("delegation_cleanup", {
        title: "Clean up stale delegations",
        description: "Remove leftover mp/* worktrees and branches of the current repository.",
        inputSchema: { olderThanMinutes: z.number().int().nonnegative().optional() },
    }, async ({ olderThanMinutes }) => {
        try {
            const removed = await cleanupWorktrees(projectDir(), (olderThanMinutes ?? 0) * 60_000);
            return json({ removed });
        }
        catch (err) {
            return fail(err);
        }
    });
    const sddRef = {
        slug: z.string().min(1).describe("Feature slug: the folder under specs/"),
        task: z.string().min(1).describe("Task id (T3, G1)"),
    };
    server.registerTool("sdd_task_claim", {
        title: "Claim a spec-driven task for a worker",
        description: "Step 1 of delegating a task from specs/<slug>/tasks.md. Checks that spec, tasks and plan (when present) are approved and the task is open " +
            "and unclaimed, then writes its **Owner** line in the user's tree. It never commits: run the returned `commit` command yourself " +
            "(no attribution trailers), then call sdd_task_delegate.",
        inputSchema: {
            ...sddRef,
            task: z.string().min(1).describe("Task id (T3, G1) or 'next' for the first open, unclaimed task"),
            provider: z.enum(["codex", "antigravity", "auto"]).optional().describe("Worker to claim for (default auto: routing, then the chain)"),
        },
    }, async (args) => {
        try {
            const dir = projectDir();
            const { config } = await loadConfig(dir);
            return json(await sddTaskClaim(args, { projectDir: dir, config, store, instanceId }));
        }
        catch (err) {
            return fail(err);
        }
    });
    server.registerTool("sdd_task_delegate", {
        title: "Delegate a claimed spec-driven task",
        description: "Step 2: delegates a task already claimed with sdd_task_claim (its claim must be committed in HEAD, otherwise no worker starts). " +
            "The brief is built from the approved spec/plan/tasks; in write mode the task's Verify and the plan's gates run in the worktree. " +
            "Returns the delegate result plus `sdd` (acceptance verdicts, verification, a Notes draft). It never ticks the box or writes Notes.",
        inputSchema: {
            ...sddRef,
            mode: z.enum(["read", "write"]).optional().describe("write (default) or read"),
            timeoutMs: z.number().int().positive().optional(),
            sessionId: z.string().optional().describe("Injected by the plugin hook; do not set manually"),
        },
    }, async (args) => {
        try {
            const dir = projectDir();
            const { config } = await loadConfig(dir);
            return json(await sddTaskDelegate(args, { projectDir: dir, config, store, instanceId }));
        }
        catch (err) {
            return fail(err);
        }
    });
    server.registerTool("sdd_task_release", {
        title: "Release a spec-driven task (handback)",
        description: "Sets the task's **Owner** back to — in the user's tree (after delegation_discard, or to free a stale claim). Commit the returned command yourself.",
        inputSchema: sddRef,
    }, async (args) => {
        try {
            return json(await sddTaskRelease(args, { projectDir: projectDir() }));
        }
        catch (err) {
            return fail(err);
        }
    });
    server.registerTool("sdd_feature_status", {
        title: "Spec-driven pipeline status",
        annotations: { readOnlyHint: true, openWorldHint: false },
        description: "Read-only. Without slug: every feature under specs/ with its stage (Spec → Plan → Tasks → Implementación → Verificación → Cerrada), task progress, warning count and next step. With slug: that feature in full (Status of each artifact, open tasks and owners, last verification report, warnings, next step). Never writes anything; the next step is a suggestion.",
        inputSchema: { slug: z.string().min(1).optional().describe("Feature slug: the folder under specs/; omit for every feature") },
    }, async (args) => {
        try {
            return json(await sddFeatureStatus(args, { projectDir: projectDir() }));
        }
        catch (err) {
            return fail(err);
        }
    });
    return server;
}
async function main() {
    const server = createServer();
    await server.connect(new StdioServerTransport());
}
main().catch((err) => {
    process.stderr.write(`multi-provider MCP server failed: ${err.stack ?? err}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map