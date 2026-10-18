import { execFile } from "node:child_process";
/** Run git with an argv array (execFile, no shell). */
export function git(args, cwd, env, input) {
    return new Promise((resolve) => {
        const child = execFile("git", args, { cwd, env: env ?? process.env, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
        if (input !== undefined)
            child.stdin?.end(input);
    });
}
export async function gitOk(args, cwd, env) {
    const r = await git(args, cwd, env);
    if (r.code !== 0)
        throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout.trim();
}
export async function repoRootOf(cwd) {
    const r = await git(["rev-parse", "--show-toplevel"], cwd);
    return r.code === 0 ? r.stdout.trim() : undefined;
}
//# sourceMappingURL=git.js.map