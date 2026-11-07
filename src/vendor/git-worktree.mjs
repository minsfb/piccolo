#!/usr/bin/env node
// Portable Git placement helper. Keep consumers' vendored copies byte-identical.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
});
const line = text => text.replace(/\n$/, "");
function stat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
function registry(cwd) {
  return git(cwd, "worktree", "list", "--porcelain", "-z").split("\0\0").filter(Boolean).map(record => {
    const fields = record.split("\0");
    return { root: fields.find(field => field.startsWith("worktree "))?.slice(9), bare: fields.includes("bare") };
  });
}

/** The first registered checkout is Git's primary worktree, including detached
 * HEAD, submodules and separate Git directories. Never infer it from .git's parent. */
export function owningRepository(cwd) {
  const entries = registry(cwd), first = entries[0];
  if (!first?.root || first.bare) throw new Error("No primary Git checkout; choose an explicit worktree destination for this repository layout.");
  const common = fs.realpathSync(line(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")));
  // Git's registry derives a main path from metadata for gitfile layouts.
  // Their shared core.worktree is authoritative (relative to the common dir).
  let primary = first.root;
  if (fs.realpathSync(line(git(cwd, "rev-parse", "--absolute-git-dir"))) === common) primary = line(git(cwd, "rev-parse", "--show-toplevel"));
  try {
    const configured = line(git(cwd, "config", "--file", path.join(common, "config"), "--path", "--get", "core.worktree"));
    if (configured) primary = path.resolve(common, configured);
  } catch (error) { if (error.status !== 1) throw error; }
  let owner;
  try {
    owner = fs.realpathSync(primary);
    if (owner === common || fs.realpathSync(line(git(owner, "rev-parse", "--show-toplevel"))) !== owner ||
      fs.realpathSync(line(git(owner, "rev-parse", "--path-format=absolute", "--git-common-dir"))) !==
      common) throw new Error("different repository");
  } catch {
    throw new Error("Primary Git checkout is unavailable or ambiguous; choose an explicit worktree destination. Do not create a nested .worktrees area.");
  }
  return owner;
}

export function worktreeName(branch) {
  if (typeof branch !== "string" || !branch) throw new Error("A branch is required to name the task worktree");
  const name = branch.replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (!/^[a-zA-Z0-9]/.test(name) || name.length > 160) throw new Error("Choose a short branch name starting with a letter or number, or an explicit worktree destination");
  return name;
}
export function defaultWorktreePath(cwd, branch) {
  return path.join(owningRepository(cwd), ".worktrees", worktreeName(branch));
}

/** Read-only planning; preparation only owns the area directory and ignore rule,
 * never a task destination, branch, index, commit or existing worktree contents. */
export function planWorktreeArea(cwd) {
  const ownerRoot = owningRepository(cwd), area = path.join(ownerRoot, ".worktrees"), ignoreFile = path.join(ownerRoot, ".gitignore");
  const areaStat = stat(area), ignoreStat = stat(ignoreFile);
  if (areaStat && (!areaStat.isDirectory() || areaStat.isSymbolicLink())) throw new Error("Repository .worktrees must be a real directory");
  if (ignoreStat && (!ignoreStat.isFile() || ignoreStat.isSymbolicLink())) throw new Error("Repository .gitignore must be a regular file");
  if (git(ownerRoot, "ls-files", "-z", "--", ".worktrees").length) throw new Error("Repository tracks .worktrees contents; reconcile them before preparing task isolation");
  const ignore = ignoreStat ? fs.readFileSync(ignoreFile, "utf8") : "";
  let ignored = false;
  try { git(ownerRoot, "check-ignore", "--no-index", "-q", "--", ".worktrees/"); ignored = true; }
  catch (error) { if (error.status !== 1) throw error; }
  const hasRule = ignore.split(/\r?\n/).some(line => ["/.worktrees/", ".worktrees/"].includes(line.trim()));
  return { format: 1, ownerRoot, area, ignoreFile, ignoreRule: "/.worktrees/", ignoreMissing: !hasRule || !ignored, areaMissing: !areaStat };
}
export function prepareWorktreeArea(cwd) {
  const plan = planWorktreeArea(cwd);
  if (plan.ignoreMissing) {
    const old = stat(plan.ignoreFile) ? fs.readFileSync(plan.ignoreFile, "utf8") : "";
    const fd = fs.openSync(plan.ignoreFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
    try { fs.writeFileSync(fd, `${old && !old.endsWith("\n") ? "\n" : ""}${plan.ignoreRule}\n`); }
    finally { fs.closeSync(fd); }
  }
  if (plan.areaMissing) fs.mkdirSync(plan.area, { mode: 0o700 });
  return planWorktreeArea(cwd);
}

/** Explicit locations remain explicit. Only the standard parent is prepared. */
export function planWorktreeParent(cwd, destination) {
  const original = path.resolve(destination), originalParent = path.dirname(original);
  let target = original;
  try { target = path.join(fs.realpathSync(originalParent), path.basename(original)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const parent = path.dirname(target);
  const common = fs.realpathSync(line(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")));
  if (target === common || target.startsWith(common + path.sep)) throw new Error("Task worktrees cannot be placed inside Git administrative metadata");
  const entries = registry(cwd);
  for (const entry of entries.slice(1)) {
    if (!entry.root || entry.bare) continue;
    const root = stat(entry.root) ? fs.realpathSync(entry.root) : path.resolve(entry.root);
    if (target.startsWith(path.join(root, ".worktrees") + path.sep)) throw new Error("Nested task worktree areas are unsupported; reuse the owning repository's .worktrees directory");
  }
  let owner;
  try { owner = owningRepository(cwd); }
  catch { return; } // An explicit existing parent is valid for unusual layouts.
  const area = path.join(owner, ".worktrees");
  // Check the caller's actual area entry before following an explicit alias.
  if (originalParent === area) planWorktreeArea(cwd);
  if (target.startsWith(area + path.sep) && path.relative(area, target).split(path.sep).includes(".worktrees")) throw new Error("Nested task worktree areas are unsupported; reuse the owning repository's .worktrees directory");
  if (parent === area) return planWorktreeArea(cwd);
}
export function prepareWorktreeParent(cwd, destination) {
  if (planWorktreeParent(cwd, destination)) return prepareWorktreeArea(cwd);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { cwd: { type: "string" }, branch: { type: "string" } } });
    if (positionals.length !== 1 || !["plan", "prepare"].includes(positionals[0])) throw new Error("Usage: node git-worktree.mjs plan|prepare [--cwd PATH] [--branch NAME]");
    const cwd = path.resolve(values.cwd ?? process.cwd());
    if (values.branch) git(cwd, "check-ref-format", "refs/heads/" + values.branch);
    const name = values.branch ? worktreeName(values.branch) : undefined;
    const result = (positionals[0] === "plan" ? planWorktreeArea : prepareWorktreeArea)(cwd);
    if (name) result.worktree = path.join(result.area, name);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
