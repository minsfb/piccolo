import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { digest } from "../config.ts";
import { evaluateRoadmap, roadmapSchema } from "../roadmap.ts";
import { git, requireCandidate } from "../workflow.ts";
import { acquireScheduleLock, safeSchedulerPath } from "../scheduler.ts";
import { sourceDigest } from "./pipeline.ts";
import type { DurableWorker } from "./worker.ts";

const Exports = defineDoc<{ requests: Record<string, { before: string; after: string; bytes: string; result: string; complete: boolean }> }>({
  kind: "piccolo.roadmap-exports", version: 1, scope: "session", initial: () => ({ requests: {} }),
});

/** Explicit projection under the legacy coordinator lock; recovery reconciles exact file contents. */
export async function exportRoadmap(worker: DurableWorker, requestId: string) {
  const admission = await worker.admission(requestId), input = admission.input;
  if (input.kind !== "schedule" || input.placement) throw new Error("Export on the assigned schedule worker");
  const { task } = await worker.inspect(requestId);
  if (task?.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("Inspect and reconcile the incomplete schedule before exporting");
  const result = task.state.outcome.result as any;
  if (!result?.results) throw new Error("Schedule has no settled node results");
  const root = input.workspace.cwd, file = safeSchedulerPath(root, ".piccolo/roadmap.json");
  const controller = new AbortController();
  const release = await acquireScheduleLock(root, controller);
  const checkOwner = () => { if (controller.signal.aborted) throw new Error("Schedule export lock lost"); };
  try {
    let intent = (await worker.harness.snapshot(Exports, context))?.requests[requestId];
    if (!intent) {
      if (sourceDigest(file) !== input.pipeline.source.files[".piccolo/roadmap.json"]) throw new Error("Roadmap changed; reconcile it before exporting this schedule");
      const document = roadmapSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      for (const item of document.tasks) {
        const node = result.results[item.id];
        if (!node) continue;
        const specification = input.pipeline.nodes[item.id];
        if (!specification || specification.work.kind !== "workflow") throw new Error("Invalid scheduled workflow result");
        const output = node.result, spec = specification.work.workflow;
        if (node.status === "complete") {
          if (output.worktree !== spec.worktree || output.branch !== spec.branch) throw new Error("Schedule result has a different workspace");
          requireCandidate(output.worktree, output.candidate, output.branch);
          git(root, "merge-base", "--is-ancestor", spec.base, output.candidate);
          for (const need of item.needs) {
            const candidate = result.results[need.task]?.result?.candidate ?? document.tasks.find(task => task.id === need.task)?.candidate;
            if (!candidate) throw new Error("Missing predecessor candidate");
            git(root, "merge-base", "--is-ancestor", candidate, output.candidate);
            item.recorded_dependencies[need.task] = candidate;
          }
          item.status = "complete"; item.candidate = output.candidate; item.branch = output.branch;
        } else item.status = "blocked";
      }
      const evaluated = evaluateRoadmap(root, document);
      for (const item of document.tasks.filter(item => result.results[item.id]?.status === "complete"))
        if (evaluated.stale[item.id] || evaluated.waiting[item.id]) throw new Error("Export would contain stale dependency evidence");
      const bytes = JSON.stringify(document, null, 2) + "\n";
      const value = { before: sourceDigest(file), after: digestBytes(bytes), bytes, result: digest(result), complete: false };
      await worker.harness.commit(async tx => { const doc = await tx.doc(Exports); doc.requests[requestId] ??= value; }, context);
      intent = (await worker.harness.snapshot(Exports, context))!.requests[requestId];
    }
    if (intent.result !== digest(result)) throw new Error("Export outcome changed");
    const current = sourceDigest(file);
    if (current !== intent.before && current !== intent.after) throw new Error("Roadmap changed after export intent; reconcile explicitly");
    if (current === intent.before) {
      const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
      try {
        safeSchedulerPath(root, ".piccolo/roadmap.json");
        const mode = fs.statSync(file).mode & 0o777;
        fs.writeFileSync(temporary, intent.bytes, { flag: "wx", mode }); fs.chmodSync(temporary, mode);
        if (sourceDigest(file) !== intent.before) throw new Error("Roadmap changed during export");
        checkOwner(); fs.renameSync(temporary, file);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    for (const [id, node] of Object.entries(result.results) as Array<[string, any]>) {
      const attempt = input.pipeline.nodes[id].attempt ?? 1;
      const home = safeSchedulerPath(root, `.piccolo/schedules/${digest({ task: id, attempt })}`);
      const outcome = { format: 1, task: id, status: node.status === "complete" ? "complete" : "blocked", result: node.result, durable_request: requestId };
      const destination = path.join(home, "outcome.json"), temporary = path.join(home, `.${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(outcome), { flag: "wx", mode: 0o600 });
        try { checkOwner(); fs.linkSync(temporary, destination); }
        catch (error: any) { if (error.code !== "EEXIST" || !fs.lstatSync(destination).isFile() || digest(JSON.parse(fs.readFileSync(destination, "utf8"))) !== digest(outcome)) throw error; }
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    await worker.harness.commit(async tx => { (await tx.doc(Exports)).requests[requestId].complete = true; }, context);
    return { requestId, file, digest: intent.after, exported: true };
  } finally { await release(); }
}

import { createHash } from "node:crypto";
function digestBytes(bytes: string) { return createHash("sha256").update(bytes).digest("hex"); }
