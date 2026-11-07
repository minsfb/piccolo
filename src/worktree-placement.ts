import fs from "node:fs";
import path from "node:path";
export { owningRepository, worktreeName, planWorktreeArea, prepareWorktreeArea } from "./vendor/git-worktree.mjs";
import { defaultWorktreePath, planWorktreeParent } from "./vendor/git-worktree.mjs";

/** Selection is read-only. The launch's persisted preparation phase owns writes. */
export function selectWorktreePath(root: string, branch: string, explicit?: string, candidate?: string): string {
  if (candidate && !explicit) throw new Error("Candidate continuation requires its explicit existing worktree");
  const target = explicit ?? defaultWorktreePath(root, branch);
  if (!path.isAbsolute(target)) throw new Error("Worktree path must be absolute");
  planWorktreeParent(root, target);
  const parent = path.dirname(target);
  try { return path.join(fs.realpathSync(parent), path.basename(target)); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; return path.resolve(target); }
}
