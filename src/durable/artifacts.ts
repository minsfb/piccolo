import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Refuse private prompts and transcripts in a project's trackable paths. */
export function requireIgnoredArtifacts(root: string, files: string[]) {
  const original = path.resolve(root), canonical = fs.realpathSync(original);
  try { execFileSync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], { stdio: "ignore", timeout: 10000 }); }
  catch { throw new Error("Piccolo runtime artifacts require a Git workspace; no new state was written."); }
  const inspected = new Set<string>();
  for (const file of files) {
    const absolute = path.resolve(original, file);
    const relative = path.relative(absolute === canonical || absolute.startsWith(canonical + path.sep) ? canonical : original, absolute);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || relative.split(path.sep).includes(".git"))
      throw new Error("Runtime artifact path is outside its owning workspace or enters Git metadata; no new state was written.");
    let ancestor = canonical;
    for (const part of relative.split(path.sep).slice(0, -1)) {
      ancestor = path.join(ancestor, part);
      if (inspected.has(ancestor)) continue;
      let stat;
      try { stat = fs.lstatSync(ancestor); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Runtime artifact ancestors must be real directories; no new state was written.");
      try {
        fs.lstatSync(path.join(ancestor, ".git"));
        throw new Error("Runtime artifact path crosses a nested Git repository; no new state was written.");
      } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      inspected.add(ancestor);
    }
    const target = path.join(canonical, relative);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Runtime artifact must be a regular file; no new state was written.");
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    try { execFileSync("git", ["-C", canonical, "check-ignore", "-q", "--", target], { stdio: "ignore", timeout: 10000 }); }
    catch { throw new Error("Ignore the Piccolo runtime artifact paths before storing private worker state; no new state was written."); }
  }
}
