import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadFeature, resolveTask } from "../src/sdd/artifacts.js";
import { checkDelegable, claimCommitted, commitCommand, ownerValue, replaceOwner, writeOwner } from "../src/sdd/claim.js";
import { makeRepo } from "./helpers.js";
import { PLAN, SPEC, TASKS, writeFeature } from "./sdd-fixtures.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const OWNER = "codex (multi-provider) since 2026-10-18";

function repoWithFeature(files: Record<string, string> = { "spec.md": SPEC, "plan.md": PLAN, "tasks.md": TASKS }) {
  const repo = makeRepo();
  writeFeature(repo, "demo", files);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "demo: artifacts");
  return repo;
}

describe("sdd claim", () => {
  it("R5: rejects unapproved spec, tasks or existing plan, and closed tasks", async () => {
    for (const [name, text] of [["spec.md", SPEC], ["tasks.md", TASKS], ["plan.md", PLAN]] as const) {
      const repo = repoWithFeature({ "spec.md": SPEC, "plan.md": PLAN, "tasks.md": TASKS, [name]: text.replace("> Status: approved", "> Status: in-review") });
      const f = await loadFeature(repo, "demo");
      expect(() => checkDelegable(f, resolveTask(f, "T3"))).toThrow(`specs/demo/${name} is 'Status: in-review'`);
    }
    const f = await loadFeature(repoWithFeature({ "spec.md": SPEC, "tasks.md": TASKS }), "demo");
    expect(() => checkDelegable(f, resolveTask(f, "T3"))).not.toThrow();
    expect(() => checkDelegable(f, resolveTask(f, "T1"))).toThrow("T1 is done");
    expect(() => checkDelegable(f, resolveTask(f, "T2"))).toThrow("T2 is blocked");
    for (const [box, word] of [["~", "waived"], [">", "deferred"]]) {
      const g = await loadFeature(repoWithFeature({ "spec.md": SPEC, "tasks.md": TASKS.replace("- [ ] Done\n- **Owner**: —\n- **Component**: C2 · **Implements**: R1, E2", `- [${box}] Done\n- **Owner**: —\n- **Component**: C2 · **Implements**: R1, E2`) }), "demo");
      expect(() => checkDelegable(g, resolveTask(g, "T3"))).toThrow(`T3 is ${word}`);
    }
  });

  it("E6: a claimed task cannot be claimed again; delegate expects its own owner", async () => {
    const f = await loadFeature(repoWithFeature(), "demo");
    expect(() => checkDelegable(f, resolveTask(f, "T4"))).toThrow(`T4 is already claimed by '${OWNER}'`);
    expect(() => checkDelegable(f, resolveTask(f, "T4"), OWNER)).not.toThrow();
    expect(() => checkDelegable(f, resolveTask(f, "T3"), OWNER)).toThrow("T3 is owned by '—'");
  });

  it("R6/R9: writeOwner changes only that task's Owner line, CRLF kept", async () => {
    const repo = repoWithFeature();
    const f = await loadFeature(repo, "demo");
    const file = path.join(repo, "specs/demo/tasks.md");
    await writeOwner(repo, f, "T3", OWNER);
    const after = readFileSync(file, "utf8");
    const changed = after.split("\n").filter((l, i) => l !== TASKS.split("\n")[i]);
    expect(changed).toEqual([`- **Owner**: ${OWNER}`]);
    await writeOwner(repo, f, "T3", "—");
    expect(readFileSync(file, "utf8")).toBe(TASKS);
    const crlf = TASKS.replace(/\n/g, "\r\n");
    expect(replaceOwner(crlf, "T3", "x")).toBe(crlf.replace("Construir el brief\r\n\r\n- [ ] Done\r\n- **Owner**: —", "Construir el brief\r\n\r\n- [ ] Done\r\n- **Owner**: x"));
    expect(ownerValue("codex", new Date("2026-10-18T22:00:00Z"))).toBe(OWNER);
  });

  it("E10/SC2: the returned command commits only tasks.md; claimCommitted flips after it", async () => {
    const repo = repoWithFeature();
    writeFileSync(path.join(repo, "index.ts"), "export const a = 2;\n");
    let f = await loadFeature(repo, "demo");
    await writeOwner(repo, f, "T3", OWNER);
    f = await loadFeature(repo, "demo");
    expect(await claimCommitted(repo, f, "T3", OWNER)).toBe(false);
    const cmd = commitCommand(f, "T3", "claim");
    expect(cmd.display).toBe('git commit -m "demo: claim T3" -- specs/demo/tasks.md');
    execFileSync(cmd.argv[0]!, cmd.argv.slice(1), { cwd: repo, stdio: "pipe" });
    expect(git(repo, "show", "--name-only", "--format=%s", "HEAD").split("\n")).toEqual(["demo: claim T3", "", "specs/demo/tasks.md"]);
    expect(git(repo, "status", "--porcelain")).toBe("M index.ts");
    expect(await claimCommitted(repo, f, "T3", OWNER)).toBe(true);
    await writeOwner(repo, f, "T3", "—");
    expect(await claimCommitted(repo, await loadFeature(repo, "demo"), "T3", OWNER)).toBe(false);
  });
});
