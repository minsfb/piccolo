import { execFileSync } from "node:child_process";

/** Refuse private prompts and transcripts in a project's trackable paths. */
export function requireIgnoredArtifacts(root: string, files: string[]) {
  for (const file of files) {
    try { execFileSync("git", ["-C", root, "check-ignore", "-q", "--", file], { stdio: "ignore", timeout: 10000 }); }
    catch { throw new Error("Ignore the Piccolo runtime artifact paths before storing private worker state; no new state was written."); }
  }
}
