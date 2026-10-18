import { promises as fs } from "node:fs";
import path from "node:path";
import { statePath } from "../paths.js";
import type { RecentDelegation } from "../state.js";
import { listWorktrees } from "../worktree.js";
import { parseScope, parseStatus, parseTasks, parseVerificationReports, readFeatureArtifacts, SddError } from "./artifacts.js";
import type { ScopeRow, VerificationReport } from "./artifacts.js";

export type PipelineDelegation = Partial<RecentDelegation>;
/** A task with a live mp/* worktree: in progress or awaiting review, never orphaned. */
export type LiveTask = { slug: string; taskId: string };
export type Stage = "Spec" | "Plan" | "Tasks" | "Implementación" | "Verificación" | "Cerrada" | "Descartada" | "Desconocida";
export interface FeatureStatus {
  slug: string;
  depth: "small" | "standard";
  statuses: { spec: string | null; plan?: string | null; tasks?: string | null };
  stage: Stage;
  substage?: string;
  tasks: { open: number; done: number; waived: number; deferred: number; blocked: number; total: number; openList: { id: string; owner: string | null }[] };
  verification?: VerificationReport;
  nextStep: string;
  warnings: { code: string; detail: string; taskId?: string }[];
  notes: string[];
}

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function inventory(projectDir: string): Promise<{ slugs: string[]; scope: ScopeRow[] }> {
  const base = path.join(projectDir, "specs");
  let directories: string[];
  try { directories = (await fs.readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
  catch { return { slugs: [], scope: [] }; }
  const slugs: string[] = [];
  const scope: ScopeRow[] = [];
  for (const dir of ["", ...directories]) {
    if (dir && await exists(path.join(base, dir, "spec.md"))) slugs.push(dir);
    try { scope.push(...parseScope(await fs.readFile(path.join(base, dir, "scope.md"), "utf8"))); } catch { /* Optional scope. */ }
  }
  return { slugs, scope };
}

async function delegations(recent?: readonly PipelineDelegation[]): Promise<readonly PipelineDelegation[] | undefined> {
  if (recent !== undefined) return recent;
  try {
    const state = JSON.parse(await fs.readFile(statePath(), "utf8"));
    if (state?.version !== 1 || (state.recent !== undefined && !Array.isArray(state.recent))) return undefined;
    const rows: unknown[] = state.recent ?? [];
    if (rows.some((r) => !r || typeof r !== "object")) return undefined;
    return rows as PipelineDelegation[];
  } catch { return undefined; }
}

async function calculate(projectDir: string, slug: string, scope: ScopeRow[], recent: readonly PipelineDelegation[] | undefined, live: readonly LiveTask[]): Promise<FeatureStatus> {
  const artifacts = await readFeatureArtifacts(projectDir, slug);
  const result: FeatureStatus = {
    slug, depth: artifacts.depth, statuses: { spec: null }, stage: "Desconocida",
    tasks: { open: 0, done: 0, waived: 0, deferred: 0, blocked: 0, total: 0, openList: [] },
    nextStep: "", warnings: [], notes: recent === undefined ? ["delegation state unavailable"] : [],
  };
  for (const name of ["spec", "plan", "tasks"] as const) {
    const text = artifacts[name];
    if (text !== undefined) result.statuses[name] = parseStatus(text);
    if ((text !== undefined && result.statuses[name] === null) ||
        (text === undefined && (name === "spec" || await exists(path.join(projectDir, "specs", slug, `${name}.md`))))) {
      result.warnings.push({ code: "malformed", detail: `specs/${slug}/${name}.md: unreadable or missing > Status:` });
    }
  }
  const small = artifacts.depth === "small";
  // Same Small contract as loadFeature: spec Status and tasks from ## Tasks onward.
  if (small) result.statuses.tasks = result.statuses.spec;
  const spec = artifacts.spec ?? "";
  const taskText = small ? spec.slice(spec.search(/^## Tasks\b/m)) : (artifacts.tasks ?? "");
  const tasks = parseTasks(taskText);
  for (const task of tasks) {
    result.tasks[task.box]++;
    if (task.box === "open") result.tasks.openList.push({ id: task.id, owner: task.owner });
  }
  result.tasks.total = tasks.length;
  // The generic report parser counts table rows; the pipeline reports only R#/E# verdicts.
  const reportText = taskText.split("\n").filter((line) => {
    if (!line.trim().startsWith("|")) return true;
    const cells = line.trim().split("|").slice(1, -1).map((cell) => cell.trim());
    return cells.includes("Verdict") || cells.every((cell) => /^:?-+:?$/.test(cell)) || /^[RE]\d+$/.test(cells[0] ?? "");
  }).join("\n");
  const reports = parseVerificationReports(reportText);
  const verification = reports[reports.length - 1];
  if (verification) result.verification = verification;
  const status = result.statuses.spec;
  if (!result.warnings.length) {
    result.stage = status === "implemented" ? "Cerrada"
      : status === "superseded" || status === "abandoned" ? "Descartada"
      : status !== "approved" ? "Spec"
      : !small && result.statuses.plan !== "approved" ? "Plan"
      : !small && result.statuses.tasks !== "approved" ? "Tasks"
      : result.tasks.open + result.tasks.blocked > 0 ? "Implementación" : "Verificación";
  }
  if (result.stage === "Verificación") result.substage = !verification ? "sin reporte"
    : verification.converged ? "convergido" : `pass ${verification.pass} no convergido`;
  const steps: Record<Stage, string> = {
    Spec: "Revisar y aprobar spec.md.", Plan: "Crear o revisar y aprobar plan.md.", Tasks: "Crear o revisar y aprobar tasks.md.",
    Implementación: tasks.some((t) => t.box === "open" && t.owner === null) ? `/sdd-delegate ${slug} next`
      : result.tasks.blocked ? "Resolver las tareas bloqueadas." : "Completar las tareas reclamadas.",
    Verificación: verification?.converged ? "Marcar el spec como implemented."
      : verification?.pending ? `Resolver lo que falta para converger (${verification.pending}) y repetir la verificación.`
      : verification ? "Resolver lo que falta para converger y repetir la verificación." : "Ejecutar la verificación y registrar un reporte.",
    Cerrada: "Feature cerrada; no hay siguiente paso.", Descartada: "Feature descartada; no hay siguiente paso.",
    Desconocida: "Corregir los artefactos indicados en los avisos malformed.",
  };
  result.nextStep = steps[result.stage];
  if (verification?.converged && status !== "implemented") result.warnings.push({ code: "ready_to_close", detail: "Verificación convergida; spec sin implemented." });
  if (status === "implemented" && result.tasks.open + result.tasks.blocked > 0) result.warnings.push({ code: "closed_with_open_tasks", detail: "Spec implemented con tareas abiertas o bloqueadas." });
  const relevant = recent?.filter((r) => r.sdd?.slug === slug && tasks.some((t) => t.id === r.sdd?.taskId));
  for (const task of tasks) {
    if (task.box === "open" && task.owner && /^(codex|agy|antigravity)\b/i.test(task.owner) && relevant && !relevant.some((r) => r.sdd?.taskId === task.id) &&
        !live.some((l) => l.slug === slug && l.taskId === task.id)) {
      result.warnings.push({ code: "orphan_claim", taskId: task.id, detail: `${task.id}: ${task.owner}` });
    }
  }
  for (const row of relevant ?? []) {
    for (const violation of row.violations ?? []) {
      // Only the identifier is exposed: audit details can contain paths or diffs.
      result.warnings.push({ code: "violations", taskId: row.sdd!.taskId, detail: violation.type });
    }
  }
  const expected = result.stage === "Cerrada" ? "done" : result.stage === "Descartada" ? (status === "abandoned" ? "abandoned" : "deferred")
    : result.stage === "Spec" ? "pending" : "in-progress";
  for (const row of scope.filter((r) => r.slug === slug)) {
    if (result.stage !== "Desconocida" && row.status !== expected) result.warnings.push({ code: "scope_mismatch", detail: `scope Status: ${row.status}; etapa: ${result.stage}; esperado: ${expected}` });
  }
  return result;
}

export async function featureStatus(projectDir: string, slug: string, recent?: readonly PipelineDelegation[], live: readonly LiveTask[] = []): Promise<FeatureStatus> {
  // Reuse the artifact reader's slug validation before any slug-specific path access.
  await readFeatureArtifacts(projectDir, slug);
  const { slugs, scope } = await inventory(projectDir);
  if (!slugs.includes(slug)) throw new SddError("FEATURE_NOT_FOUND", `feature '${slug}' not found. Available features: ${slugs.join(", ") || "none"}`);
  return calculate(projectDir, slug, scope, await delegations(recent), live);
}

export async function listFeatureStatus(projectDir: string, recent?: readonly PipelineDelegation[], live: readonly LiveTask[] = []): Promise<FeatureStatus[]> {
  const { slugs, scope } = await inventory(projectDir);
  const rows = await delegations(recent);
  const rank = (slug: string) => Math.min(...scope.filter((r) => r.slug === slug).map((r) => r.rank), Infinity);
  slugs.sort((a, b) => (rank(a) - rank(b)) || (a < b ? -1 : a > b ? 1 : 0));
  return Promise.all(slugs.map((slug) => calculate(projectDir, slug, scope, rows, live)));
}

export interface FeatureSummary {
  slug: string;
  stage: Stage;
  substage?: string;
  /** Closed tasks ([x], [~], [>]) over the total. */
  closed: number;
  total: number;
  /** The claimed open task, else the next free one. */
  current?: { id: string; owner: string | null };
  warnings: number;
  nextStep: string;
}

function summarize(f: FeatureStatus): FeatureSummary {
  const claimed = f.tasks.openList.find((t) => t.owner !== null);
  const current = claimed ?? f.tasks.openList[0];
  return {
    slug: f.slug,
    stage: f.stage,
    ...(f.substage ? { substage: f.substage } : {}),
    closed: f.tasks.done + f.tasks.waived + f.tasks.deferred,
    total: f.tasks.total,
    ...(current ? { current } : {}),
    warnings: f.warnings.length,
    nextStep: f.nextStep,
  };
}

/** The sdd_feature_status tool: one feature in full, or a summary of every feature (R6). */
export async function sddFeatureStatus(
  args: { slug?: string },
  ctx: { projectDir: string },
): Promise<FeatureStatus | { features: FeatureSummary[]; notes: string[] }> {
  const live = (await listWorktrees(ctx.projectDir).catch(() => [])).flatMap((m) => (m.sdd ? [m.sdd] : []));
  if (args.slug) return featureStatus(ctx.projectDir, args.slug, undefined, live);
  const all = await listFeatureStatus(ctx.projectDir, undefined, live);
  const notes = all.length ? [...new Set(all.flatMap((f) => f.notes))] : ["no SDD features"];
  return { features: all.map(summarize), notes };
}
