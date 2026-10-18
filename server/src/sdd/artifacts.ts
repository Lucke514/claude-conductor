import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Reads spec-driven (SDD) artifacts: `specs/<slug>/{spec,plan,tasks}.md`, or a
 * Small feature's single `spec.md` with a `## Tasks` section. Only the English
 * template anchors are parsed (`## T1`, `**Owner**`, `> Status:`…); every text
 * is copied verbatim, whatever its language.
 */

export type BoxState = "open" | "done" | "waived" | "deferred" | "blocked";

export interface SddTask {
  id: string;
  title: string;
  parallel: boolean;
  box: BoxState;
  /** `null` when unclaimed (`—`). */
  owner: string | null;
  component?: string;
  implements: string[];
  files: string[];
  do?: string;
  acceptance?: string;
  /** The Verify field as written. */
  verify?: string;
  /** Backticked commands of the Verify field; empty when it is a manual check. */
  verifyCommands: string[];
}

export interface QualityGate {
  gate: string;
  commands: string[];
  where: string;
  pipelineOnly: boolean;
  baseline: string;
}

export interface SddFeature {
  slug: string;
  depth: "small" | "standard";
  /** Project-relative path of the file holding the tasks (`tasks.md`, or `spec.md` at Small). */
  tasksFile: string;
  statuses: { spec: string | null; plan?: string | null; tasks: string | null };
  tasks: SddTask[];
  /** `R#`/`E#` → its full text (the bullet and its indented lines). */
  requirements: Map<string, string>;
  /** `C#` → its plan section. */
  components: Map<string, string>;
  gates: QualityGate[];
}

export type SddErrorCode =
  | "INVALID_SLUG"
  | "FEATURE_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "NO_OPEN_TASK"
  | "UNKNOWN_REFERENCE"
  | "NOT_APPROVED"
  | "TASK_CLOSED"
  | "TASK_CLAIMED"
  | "CLAIM_NOT_COMMITTED";

export class SddError extends Error {
  constructor(
    readonly code: SddErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SddError";
  }
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASK_HEADING = /^(#{2,3}) ([TG]\d+)(\s+\[P\])?\s*(?:[—–-]\s*(.*))?$/;
const BOXES: Record<string, BoxState> = { " ": "open", x: "done", X: "done", "~": "waived", ">": "deferred", "!": "blocked" };

const normalize = (text: string): string => text.replace(/\r\n?/g, "\n");

/** Value of the first `> Status:` line, lower-cased first word (`implemented — …` → `implemented`). */
export function parseStatus(text: string): string | null {
  const m = /^>\s*Status:\s*([A-Za-z-]+)/m.exec(normalize(text));
  return m ? m[1]!.toLowerCase() : null;
}

const backticked = (s: string): string[] => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim()).filter(Boolean);

function field(block: string[], name: string): string | undefined {
  const re = new RegExp(`\\*\\*${name}\\*\\*:\\s*(.*)$`);
  for (const line of block) {
    const m = re.exec(line);
    if (m) return m[1]!.replace(/\s*·\s*\*\*\w+\*\*:.*$/, "").trim();
  }
  return undefined;
}

const unclaimed = (v: string | undefined): boolean => !v || /^[—–-]+$/.test(v.trim());

const ids = (v: string | undefined): string[] => (v ? [...v.matchAll(/\b([RE]\d+)\b/g)].map((m) => m[1]!) : []);

/** Parse every `## T#` / `## G#` section (`###` inside a Small spec's `## Tasks`). */
export function parseTasks(text: string): SddTask[] {
  const lines = normalize(text).split("\n");
  const tasks: SddTask[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = TASK_HEADING.exec(lines[i]!);
    if (!h) continue;
    const level = h[1]!.length;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      const hm = /^(#+) /.exec(l);
      if (hm && hm[1]!.length <= level) break;
      block.push(l);
    }
    const boxLine = block.find((l) => /^- \[[ xX~>!]\]/.test(l));
    const owner = field(block, "Owner");
    const files = field(block, "Files");
    const component = field(block, "Component");
    const verify = field(block, "Verify");
    const task: SddTask = {
      id: h[2]!,
      title: (h[4] ?? "").trim(),
      parallel: Boolean(h[3]),
      box: boxLine ? BOXES[boxLine[3]!]! : "open",
      owner: unclaimed(owner) ? null : owner!,
      implements: ids(field(block, "Implements")),
      files: files ? (backticked(files).length ? backticked(files) : files.split(",").map((f) => f.trim()).filter((f) => f && !unclaimed(f))) : [],
      verifyCommands: verify ? backticked(verify) : [],
    };
    const c = component ? /\b(C\d+)\b/.exec(component) : null;
    if (c) task.component = c[1]!;
    for (const k of ["Do", "Acceptance"] as const) {
      const v = field(block, k);
      if (v) task[k === "Do" ? "do" : "acceptance"] = v;
    }
    if (verify) task.verify = verify;
    tasks.push(task);
  }
  return tasks;
}

/** `- **R1** — text` bullets plus their indented continuation lines. */
export function parseRequirements(specText: string): Map<string, string> {
  const lines = normalize(specText).split("\n");
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^- \*\*([RE]\d+)\*\*/.exec(lines[i]!);
    if (!m) continue;
    const body = [lines[i]!];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) body.push(lines[++i]!);
    if (!out.has(m[1]!)) out.set(m[1]!, body.join("\n"));
  }
  return out;
}

/** `### C1 — …` sections of a plan, up to the next heading of level ≤ 3. */
export function parseComponents(planText: string): Map<string, string> {
  const lines = normalize(planText).split("\n");
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^### (C\d+)\b/.exec(lines[i]!);
    if (!m) continue;
    const body = [lines[i]!];
    while (i + 1 < lines.length && !/^#{1,3} /.test(lines[i + 1]!)) body.push(lines[++i]!);
    out.set(m[1]!, body.join("\n").trimEnd());
  }
  return out;
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** The first `| Gate | Command | Where | Baseline |` table in the text. */
export function parseGates(text: string): QualityGate[] {
  const lines = normalize(text).split("\n");
  const start = lines.findIndex((l) => /^\|\s*Gate\s*\|\s*Command\s*\|/i.test(l));
  if (start < 0) return [];
  const head = cells(lines[start]!).map((c) => c.toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const gates: QualityGate[] = [];
  for (let i = start + 2; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
    const row = cells(lines[i]!);
    const where = row[col("where")] ?? "";
    gates.push({
      gate: row[col("gate")] ?? "",
      commands: backticked(row[col("command")] ?? ""),
      where,
      pipelineOnly: /pipeline-only/i.test(where),
      baseline: (row[col("baseline")] ?? "").replace(/^`|`$/g, ""),
    });
  }
  return gates;
}

export interface VerificationReport {
  pass: number;
  /** null when the report has no readable Converged anchor. */
  converged: boolean | null;
  /** What follows "Converged: no —": what convergence is waiting on. */
  pending?: string;
  verdicts: Record<string, number>;
}

/** Reports in document order, restricted to the Verification reports section. */
export function parseVerificationReports(md: string): VerificationReport[] {
  const lines = normalize(md).split("\n");
  const start = lines.findIndex((line) => /^## Verification reports\s*$/.test(line));
  if (start < 0) return [];
  const reports: VerificationReport[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i]!)) break;
    const heading = /^### Verification report — .+ — pass (\d+)\s*$/.exec(lines[i]!);
    if (!heading) continue;
    const block: string[] = [];
    while (i + 1 < lines.length && !/^#{1,3} /.test(lines[i + 1]!)) block.push(lines[++i]!);
    const converged = /^Converged:[ \t]*(yes|no)\b(?:[ \t]*—[ \t]*(.+))?/m.exec(block.join("\n"));
    const counts = new Map<string, number>();
    const table = block.findIndex((line) => line.trim().startsWith("|") && cells(line).includes("Verdict"));
    if (table >= 0) {
      const column = cells(block[table]!).indexOf("Verdict");
      for (let j = table + 2; j < block.length && block[j]!.trim().startsWith("|"); j++) {
        const verdict = cells(block[j]!)[column];
        if (verdict) counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
      }
    }
    // fromEntries defines own properties, so a verdict named "__proto__" stays a plain key.
    const verdicts: Record<string, number> = Object.fromEntries(counts);
    const report: VerificationReport = { pass: Number(heading[1]), converged: converged ? converged[1] === "yes" : null, verdicts };
    if (converged?.[1] === "no" && converged[2]) report.pending = converged[2].trim();
    reports.push(report);
  }
  return reports;
}

export interface ScopeRow {
  slug: string;
  rank: number;
  status: string;
}

/** Read the Slug table; keep Status text verbatim and rank numeric. */
export function parseScope(md: string): ScopeRow[] {
  const lines = normalize(md).split("\n");
  const start = lines.findIndex((line) => /^\|\s*Slug\s*\|/.test(line) && cells(line).includes("Rank") && cells(line).includes("Status"));
  if (start < 0) return [];
  const head = cells(lines[start]!);
  const rows: ScopeRow[] = [];
  for (let i = start + 2; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
    const row = cells(lines[i]!);
    const slug = row[head.indexOf("Slug")];
    const rank = row[head.indexOf("Rank")];
    const status = row[head.indexOf("Status")];
    if (slug && SLUG.test(slug) && rank && /^\d+$/.test(rank) && status) rows.push({ slug, rank: Number(rank), status });
  }
  return rows;
}

export interface FeatureArtifacts {
  spec?: string;
  plan?: string;
  tasks?: string;
  depth: "small" | "standard";
}

/** Missing or unreadable files remain undefined; never invent a draft Status. */
export async function readFeatureArtifacts(projectDir: string, slug: string): Promise<FeatureArtifacts> {
  if (!SLUG.test(slug)) throw new SddError("INVALID_SLUG", `invalid feature slug '${slug}'`);
  const dir = path.join(projectDir, "specs", slug);
  const [spec, plan, tasks] = await Promise.all(
    ["spec.md", "plan.md", "tasks.md"].map((name) => readText(path.join(dir, name))),
  );
  const small = tasks === undefined && plan === undefined && spec !== undefined && /^## Tasks\b/m.test(spec);
  return { spec, plan, tasks, depth: small ? "small" : "standard" };
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return normalize(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function listSlugs(projectDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(projectDir, "specs"), { withFileTypes: true });
    const slugs: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(projectDir, "specs", e.name);
      const tasks = await readText(path.join(dir, "tasks.md"));
      const spec = tasks === undefined ? await readText(path.join(dir, "spec.md")) : undefined;
      if (tasks !== undefined || (spec !== undefined && /^## Tasks\b/m.test(spec))) slugs.push(e.name);
    }
    return slugs.sort();
  } catch {
    return [];
  }
}

function smallTasksSection(spec: string): string {
  const m = /^## Tasks\b.*$/m.exec(spec);
  return m ? spec.slice(m.index) : "";
}

/** Load a feature's artifacts (E1: unknown slug lists the available ones; E7: Small spec). */
export async function loadFeature(projectDir: string, slug: string): Promise<SddFeature> {
  const { spec, plan, tasks, depth } = await readFeatureArtifacts(projectDir, slug);
  const small = depth === "small";
  if (spec === undefined || (tasks === undefined && !small)) {
    const slugs = await listSlugs(projectDir);
    throw new SddError(
      "FEATURE_NOT_FOUND",
      `feature '${slug}' has no ${spec === undefined ? "specs/" + slug + "/spec.md" : "tasks.md"}. ` +
        `Available features: ${slugs.length ? slugs.join(", ") : "none (no specs/<slug>/tasks.md found)"}`,
    );
  }
  const taskText = small ? smallTasksSection(spec) : tasks!;
  const feature: SddFeature = {
    slug,
    depth: small ? "small" : "standard",
    tasksFile: path.posix.join("specs", slug, small ? "spec.md" : "tasks.md"),
    statuses: { spec: parseStatus(spec), tasks: small ? parseStatus(spec) : parseStatus(tasks!) },
    tasks: parseTasks(taskText),
    requirements: parseRequirements(spec),
    components: plan ? parseComponents(plan) : new Map(),
    gates: parseGates(small ? spec : (plan ?? "")),
  };
  if (plan !== undefined) feature.statuses.plan = parseStatus(plan);
  return feature;
}

const describeOpen = (f: SddFeature): string => {
  const open = f.tasks.filter((t) => t.box === "open");
  return open.length ? open.map((t) => `${t.id} (owner: ${t.owner ?? "—"})`).join(", ") : "none";
};

/** Resolve `T#`, `G#` or `next` (first open, unclaimed task in document order). E2 on failure. */
export function resolveTask(feature: SddFeature, ref: string): SddTask {
  const r = ref.trim();
  if (r.toLowerCase() === "next") {
    const t = feature.tasks.find((x) => x.box === "open" && x.owner === null);
    if (!t) throw new SddError("NO_OPEN_TASK", `no open, unclaimed task in ${feature.tasksFile}. Open tasks: ${describeOpen(feature)}`);
    return t;
  }
  const t = feature.tasks.find((x) => x.id.toLowerCase() === r.toLowerCase());
  if (!t) throw new SddError("TASK_NOT_FOUND", `task '${r}' not found in ${feature.tasksFile}. Open tasks: ${describeOpen(feature)}`);
  return t;
}

/** E4: every `R#`/`E#` the task implements is in spec.md, and its `C#` is in plan.md. */
export function checkReferences(feature: SddFeature, task: SddTask): void {
  const missing = task.implements.filter((id) => !feature.requirements.has(id));
  if (task.component && feature.depth === "standard" && !feature.components.has(task.component)) missing.push(task.component);
  if (missing.length > 0) {
    throw new SddError(
      "UNKNOWN_REFERENCE",
      `${task.id} cites ${missing.join(", ")}, which ${missing.length > 1 ? "do" : "does"} not exist in the feature's artifacts — fix spec/plan/tasks first`,
    );
  }
}
