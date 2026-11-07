import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Resolved, Agent } from "./config.ts";
import { packageRoot } from "./config.ts";

export function projectRoot(cwd: string): string {
  try { return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return path.resolve(cwd); }
}
function directory(root: string, relative: string): string {
  let current = fs.realpathSync(root);
  for (const part of relative.split("/")) {
    if (!part || part === "." || part === "..") throw new Error("Invalid record directory");
    current = path.join(current, part);
    try { fs.mkdirSync(current); } catch (e: any) { if (e.code !== "EEXIST") throw e; }
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Record directory must not be a symlink: ${current}`);
  }
  return current;
}
export function writeNew(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
export function initializeRecords(root: string): string[] {
  const destination = directory(root, ".piccolo");
  const created: string[] = [];
  for (const file of fs.readdirSync(path.join(packageRoot, "templates/execution"))) {
    const target = path.join(destination, file);
    if (fs.existsSync(target)) continue;
    fs.copyFileSync(path.join(packageRoot, "templates/execution", file), target, fs.constants.COPYFILE_EXCL);
    created.push(target);
  }
  return created;
}
export function startRun(root: string, input: { type: string; task: string; cwd?: string; task_id?: string; parent_run_id?: string; resolved: Resolved; agent: Agent; parent: unknown; runtime?: unknown }): { id: string; directory: string; finish(value: unknown): string } {
  const id = randomUUID();
  const runDirectory = directory(root, `.piccolo/runs/${id}`);
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  writeNew(path.join(runDirectory, "launch.json"), { format: 1, id, created_at: new Date().toISOString(), host: os.hostname(), project_root: root, cwd: root, piccolo_version: version, ...input });
  return { id, directory: runDirectory, finish(value) {
    const file = path.join(runDirectory, "outcome.json");
    writeNew(file, { format: 1, run_id: id, finished_at: new Date().toISOString(), ...value as object });
    return file;
  } };
}
