import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { git } from "./workflow.ts";
import { preflightWorktree } from "./worktree-preflight.ts";

type Entry = { name: string; mode: number; kind: "file" | "directory" | "link"; hash?: string; target?: string };
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function regular(file: string) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Expected a regular checkpoint file");
  return fs.readFileSync(file);
}
function inventory(root: string): Entry[] {
  const result: Entry[] = []; let bytes = 0;
  const walk = (directory: string, prefix = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (name === ".git") { if (!prefix) continue; throw new Error("Nested Git workspaces must be checkpointed separately"); }
      const relative = prefix ? `${prefix}/${name}` : name, file = path.join(directory, name), info = fs.lstatSync(file);
      if (info.isSymbolicLink()) result.push({ name: relative, kind: "link", mode: info.mode & 0o777, target: fs.readlinkSync(file) });
      else if (info.isDirectory()) { result.push({ name: relative, kind: "directory", mode: info.mode & 0o777 }); walk(file, relative); }
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > 1024 * 1024 * 1024 || info.size > 64 * 1024 * 1024) throw new Error("Checkpoint exceeds 1 GiB total or 64 MiB per file; preserve the worktree and checkpoint large artifacts separately");
        result.push({ name: relative, kind: "file", mode: info.mode & 0o777, hash: sha(regular(file)) });
      } else throw new Error("Checkpoint cannot capture special files; quiesce the owned workflow first");
      if (result.length > 100000) throw new Error("Checkpoint file limit reached; retain original worktree");
    }
  };
  walk(root); return result;
}
function copy(source: string, destination: string, entries: Entry[]) {
  for (const item of entries) {
    const target = path.join(destination, item.name);
    if (item.kind === "directory") fs.mkdirSync(target, { mode: 0o700 });
    else if (item.kind === "link") fs.symlinkSync(item.target!, target);
    else { fs.copyFileSync(path.join(source, item.name), target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, item.mode); }
  }
  for (const item of [...entries].reverse()) if (item.kind === "directory") fs.chmodSync(path.join(destination, item.name), item.mode);
}
function common(root: string) { return fs.realpathSync(path.resolve(root, git(root, "rev-parse", "--git-common-dir"))); }
function safeDirectory(root: string) {
  const absolute = path.resolve(root);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Checkpoint paths must use canonical directory ancestors");
  }
}
/** Capture a terminal owned workflow without deleting or rewriting any source.
 * Index bytes preserve staged state; payload includes untracked/ignored evidence.
 */
export function checkpointWorkflow(root: string, workflow: string, destination: string) {
  if (!/^[a-f0-9-]{36}$/.test(workflow)) throw new Error("Expected workflow ID");
  root = fs.realpathSync(root);
  const record = path.join(root, ".piccolo/workflows", workflow); safeDirectory(record);
  const launch = JSON.parse(regular(path.join(record, "launch.json")).toString());
  regular(path.join(record, "outcome.json")); // active workflows must first settle
  const worktree = fs.realpathSync(launch.worktree);
  if (common(worktree) !== common(root) || git(worktree, "symbolic-ref", "HEAD") !== `refs/heads/${launch.branch}`) throw new Error("Workflow no longer owns this worktree and branch");
  destination = path.resolve(destination); safeDirectory(path.dirname(destination));
  if (destination === worktree || destination.startsWith(worktree + path.sep)) throw new Error("Checkpoint destination must be outside the source worktree");
  const head = git(worktree, "rev-parse", "HEAD"), index = path.resolve(worktree, git(worktree, "rev-parse", "--git-path", "index"));
  if (git(worktree, "rev-parse", "--shared-index-path")) throw new Error("Split-index worktrees require a full index before checkpointing; original retained");
  const indexBytes = regular(index), entries = inventory(worktree);
  fs.mkdirSync(destination, { mode: 0o700 });
  const payload = path.join(destination, "files"); fs.mkdirSync(payload, { mode: 0o700 });
  copy(worktree, payload, entries);
  fs.writeFileSync(path.join(destination, "index"), indexBytes, { flag: "wx", mode: 0o600 });
  if (JSON.stringify(inventory(payload)) !== JSON.stringify(entries) || JSON.stringify(inventory(worktree)) !== JSON.stringify(entries)
      || !regular(index).equals(indexBytes) || git(worktree, "rev-parse", "HEAD") !== head
      || git(worktree, "symbolic-ref", "HEAD") !== `refs/heads/${launch.branch}`) throw new Error("Worktree changed during checkpoint; incomplete copy retained, original must not be removed");
  const manifest = { format: 1, id: randomUUID(), workflow, head, branch: launch.branch, common: common(root), index_hash: sha(indexBytes), entries };
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { checkpoint: destination, workflow, candidate: head, files: entries.length, original_retained: true, restore_verified: false };
}
export function restoreCheckpoint(root: string, checkpoint: string, worktree: string, branch: string) {
  root = fs.realpathSync(root); checkpoint = fs.realpathSync(checkpoint); safeDirectory(checkpoint);
  const manifestBytes = regular(path.join(checkpoint, "manifest.json"));
  if (manifestBytes.length > 16 * 1024 * 1024) throw new Error("Checkpoint manifest too large");
  const manifest = JSON.parse(manifestBytes.toString());
  if (manifest.format !== 1 || manifest.common !== common(root) || !/^[a-f0-9]{40,64}$/.test(manifest.head)) throw new Error("Checkpoint belongs to a different repository or has invalid metadata");
  const payload = path.join(checkpoint, "files"); safeDirectory(payload);
  // Walk the actual payload, never trust manifest paths as copy instructions.
  const entries = inventory(payload), index = regular(path.join(checkpoint, "index"));
  if (JSON.stringify(entries) !== JSON.stringify(manifest.entries) || sha(index) !== manifest.index_hash) throw new Error("Checkpoint integrity mismatch; no restoration started");
  const requested = path.resolve(worktree);
  const canonicalTarget = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
  if (canonicalTarget === checkpoint || canonicalTarget.startsWith(checkpoint + path.sep)) throw new Error("Restore destination must not overlap the checkpoint");
  const target = preflightWorktree(root, canonicalTarget, branch).worktree;
  git(root, "worktree", "add", "--no-checkout", "-b", branch, target, manifest.head);
  copy(payload, target, entries);
  fs.writeFileSync(path.resolve(target, git(target, "rev-parse", "--git-path", "index")), index);
  if (JSON.stringify(inventory(target)) !== JSON.stringify(entries)) throw new Error("Restoration verification failed; retain both checkpoint and restored worktree");
  return { checkpoint, worktree: target, branch, candidate: manifest.head, restore_verified: true, original_retained: true };
}
