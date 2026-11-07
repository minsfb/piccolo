import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { prepareWorktreeParent } from "./vendor/git-worktree.mjs";

export function preflightWorktree(root: string, worktree: string, branch: string) {
  if (!path.isAbsolute(worktree)) throw new Error("Worktree path must be absolute");
  const target = path.resolve(worktree), parent = path.dirname(target);
  try { fs.lstatSync(target); throw new Error("Worktree destination already exists; retain it and choose a new path"); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  const command = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }).trim();
  command("check-ref-format", "refs/heads/" + branch);
  if (command("for-each-ref", "--format=%(refname)", "refs/heads/" + branch).split("\n").includes("refs/heads/" + branch)) throw new Error("Workflow branch already exists; retain it and choose a new branch");
  prepareWorktreeParent(root, target);
  // Existing canonical parent is deliberate: do not guess another location or
  // leave recursive directories behind when an explicit sandbox path is denied.
  let canonical: string;
  try {
    canonical = fs.realpathSync(parent);
    if (!fs.statSync(canonical).isDirectory()) throw new Error("not a directory");
    const probe = path.join(canonical, `.piccolo-write-probe-${randomUUID()}`);
    fs.mkdirSync(probe, { mode: 0o700 });
    try { const fd = fs.openSync(path.join(probe, "probe"), "wx", 0o600); fs.closeSync(fd); fs.unlinkSync(path.join(probe, "probe")); }
    finally { fs.rmdirSync(probe); }
  } catch {
    throw new Error("Worktree parent must be writable by this Pi session. The default is the owning repository's ignored .worktrees/; an explicit location needs an existing parent and normal Pi startup access. No branch was created.");
  }
  return { worktree: path.join(canonical, path.basename(target)), branch, parent_writable: true };
}

/** Evaluate the selected commit's ignore rules with the repository's native
 * info/global excludes, without creating a branch or changing its index. */
export function preflightBaseIgnores(root: string, base: string) {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  if (git("ls-tree", "-r", "--name-only", base, "--", ".pi").trim()) throw new Error("Selected base tracks .pi runtime files; reconcile the base before launching a workflow.");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-base-ignore-"));
  try {
    let ignore = "";
    const entry = git("ls-tree", base, "--", ".gitignore").trim();
    if (entry && !/^100(?:644|755) blob /.test(entry)) throw new Error("Selected base .gitignore must be a regular file");
    if (entry) ignore = git("show", `${base}:.gitignore`);
    fs.writeFileSync(path.join(temporary, ".gitignore"), ignore, { mode: 0o600 });
    const gitDir = git("rev-parse", "--absolute-git-dir").trim();
    for (const file of [".pi/piccolo-profile.json", ".pi/settings.json"]) {
      try {
        execFileSync("git", ["--git-dir", gitDir, "--work-tree", temporary, "check-ignore", "--no-index", "-q", "--", file], { cwd: temporary, stdio: "pipe", timeout: 30000 });
      } catch {
        throw new Error("Selected upstream base does not ignore .pi runtime files. Commit /.pi/ in that base, or add an intentional repository-local info/exclude rule, then retry. No workflow branch or worktree was created.");
      }
    }
    return { base, runtime_ignored: true };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
