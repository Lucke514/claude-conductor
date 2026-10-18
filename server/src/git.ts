import { execFile } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git with an argv array (execFile, no shell). */
export function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv, input?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, env: env ?? process.env, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

export async function gitOk(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const r = await git(args, cwd, env);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export async function repoRootOf(cwd: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--show-toplevel"], cwd);
  return r.code === 0 ? r.stdout.trim() : undefined;
}
