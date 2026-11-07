import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../config.ts";
import type { WorkerSubmission } from "./contract.ts";

/** Shared immutable attempt claims bridge legacy and Durable owners; outcomes remain in Durable. */
export function claimSchedule(root: string, input: WorkerSubmission) {
  if (input.kind !== "schedule") return { rollback() {} };
  let directory = fs.realpathSync(root);
  for (const segment of [".piccolo", "schedules"]) {
    directory = path.join(directory, segment);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error("Schedule claims require real directories");
  }
  const planned = Object.entries(input.pipeline.nodes).map(([task, node]) => {
    const attempt = node.attempt ?? 1, id = digest({ task, attempt });
    const home = path.join(directory, id);
    if (fs.existsSync(home) && (!fs.lstatSync(home).isDirectory() || fs.lstatSync(home).isSymbolicLink())) throw new Error("Invalid schedule claim directory");
    const file = path.join(home, "launch.json");
    const claim = { format: 1, task_id: task, attempt, durable: { requestId: input.requestId, workspace: input.workspace, fingerprint: digest(input) } };
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 1000000 || digest(JSON.parse(fs.readFileSync(file, "utf8"))) !== digest(claim)) throw new Error(`Task ${task} attempt ${attempt} is already claimed; inspect its original owner`);
    }
    return { home, file, claim };
  });
  const allocated: typeof planned = [];
  const createdHomes = new Set<string>();
  const rollback = () => {
    for (const item of allocated) {
      if (fs.existsSync(path.join(item.home, "outcome.json"))) throw new Error("Claim has an outcome; refusing to release it");
      if (digest(JSON.parse(fs.readFileSync(item.file, "utf8"))) !== digest(item.claim)) throw new Error("Claim ownership changed; reconcile explicitly");
      fs.unlinkSync(item.file);
    }
    for (const home of createdHomes) if (!fs.readdirSync(home).length) fs.rmdirSync(home);
  };
  try { for (const { home, file, claim } of planned) {
    try { fs.mkdirSync(home, { mode: 0o700 }); createdHomes.add(home); }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
    if (!fs.lstatSync(home).isDirectory() || fs.lstatSync(home).isSymbolicLink()) throw new Error("Invalid schedule claim directory");
    const temporary = path.join(home, `.${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(claim)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.linkSync(temporary, file); allocated.push({ home, file, claim }); }
      catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 1000000 || digest(JSON.parse(fs.readFileSync(file, "utf8"))) !== digest(claim)) throw new Error(`Task ${claim.task_id} attempt ${claim.attempt} is already claimed; inspect its original owner`);
      }
      const fdDir = fs.openSync(home, "r"); try { fs.fsyncSync(fdDir); } finally { fs.closeSync(fdDir); }
    } finally { fs.unlinkSync(temporary); }
  } } catch (error) { try { rollback(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Claim allocation failed and cleanup needs reconciliation"); } throw error; }
  return { rollback };
}
