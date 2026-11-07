import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { git } from "./workflow.ts";
import { digest } from "./config.ts";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
export const roadmapSchema = z.strictObject({ format: z.literal(1), tasks: z.array(z.strictObject({
  id, title: z.string().min(1), status: z.enum(["planned", "running", "complete", "blocked", "challenge"]),
  needs: z.array(z.strictObject({ task: id, requires: z.enum(["commit", "merge"]).default("commit"), merged_into: z.string().optional() })).default([]),
  candidate: sha.optional(), branch: z.string().optional(),
  recorded_dependencies: z.record(id, sha).default({}),
})) });
export function evaluateRoadmap(root: string, value: unknown) {
  const roadmap = roadmapSchema.parse(value);
  const byId = new Map(roadmap.tasks.map(t => [t.id, t]));
  if (byId.size !== roadmap.tasks.length) throw new Error("Duplicate roadmap task identity");
  const done = new Set<string>(); const visiting = new Set<string>();
  const visit = (name: string) => {
    if (visiting.has(name)) throw new Error("Roadmap dependency cycle");
    if (done.has(name)) return;
    const task = byId.get(name); if (!task) throw new Error(`Unknown dependency ${name}`);
    visiting.add(name); for (const need of task.needs) visit(need.task); visiting.delete(name); done.add(name);
  };
  for (const task of roadmap.tasks) visit(task.id);
  const valid = (candidate?: string) => { try { return !!candidate && git(root, "rev-parse", "--verify", `${candidate}^{commit}`) === candidate; } catch { return false; } };
  const stale: Record<string, string[]> = {};
  const waiting: Record<string, string[]> = {};
  const ready: string[] = [];
  for (const task of roadmap.tasks) {
    const reasons: string[] = []; const drift: string[] = [];
    if (task.status === "complete" && !valid(task.candidate)) drift.push("Completed task has no available candidate commit");
    if (task.branch && task.candidate) {
      try { if (git(root, "rev-parse", "--verify", "--end-of-options", `${task.branch}^{commit}`) !== task.candidate) drift.push("Branch moved since candidate was recorded"); }
      catch { drift.push("Recorded branch is unavailable"); }
    }
    for (const need of task.needs) {
      const upstream = byId.get(need.task)!;
      if (upstream.status !== "complete" || !valid(upstream.candidate)) reasons.push(`${need.task}: requires a completed available candidate`);
      if (need.requires === "merge") {
        if (!need.merged_into) reasons.push(`${need.task}: merge prerequisite needs merged_into`);
        else try { const target = git(root, "rev-parse", "--verify", "--end-of-options", `${need.merged_into}^{commit}`); git(root, "merge-base", "--is-ancestor", upstream.candidate ?? "missing", target); }
        catch { reasons.push(`${need.task}: candidate not verified merged into ${need.merged_into}`); }
      }
      if (["running", "complete"].includes(task.status) && task.recorded_dependencies[need.task] !== upstream.candidate) drift.push(`${need.task}: upstream changed or dependency binding missing; revalidate dependent work`);
    }
    if (drift.length) stale[task.id] = drift;
    if (reasons.length) waiting[task.id] = reasons;
  }
  // Propagate stale evidence through all joins; status=complete alone is insufficient.
  for (const name of done) {
    const task = byId.get(name)!;
    for (const need of task.needs) if (stale[need.task] || waiting[need.task]) (waiting[name] ??= []).push(`${need.task}: upstream evidence needs reconciliation`);
    if (task.status === "planned" && !stale[name] && !waiting[name]) ready.push(name);
  }
  return { format: 1, digest: digest(roadmap), ready, waiting, stale, tasks: roadmap.tasks, automatic_launch: false };
}
export function readRoadmap(root: string) {
  const file = path.join(root, ".piccolo/roadmap.json");
  return { file, ...evaluateRoadmap(root, JSON.parse(fs.readFileSync(file, "utf8"))) };
}
