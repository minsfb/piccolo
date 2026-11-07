import fs from "node:fs";
import type { Resolved } from "../config.ts";
import { workerRequest, retainedAssignment, type RemoteWorker } from "./remote.ts";

export function configuredWorker(resolved: Resolved, host: string): RemoteWorker {
  const config = resolved.config.hosts?.[host];
  if (!config?.worker_identity || !config.worker_transport) throw new Error("Host requires worker_identity and worker_transport");
  return { workspace: { host: config.hostname, cwd: config.cwd, identity: config.worker_identity }, transport: config.worker_transport };
}

/** CLI reads the live owner instead of opening or migrating its database. */
export async function experimentClient(root: string, target: RemoteWorker, action: string, ids: string[], assessmentFile?: string) {
  if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length) throw new Error("Supply 1..20 distinct experiment IDs");
  for (const id of ids) retainedAssignment(root, target, id);
  if (action === "assess") {
    if (ids.length !== 1 || !assessmentFile) throw new Error("Assessment requires one ID and a JSON spec");
    return workerRequest(target, { operation: "assess", requestId: ids[0], assessment: JSON.parse(fs.readFileSync(assessmentFile, "utf8")) });
  }
  if (assessmentFile || !["report", "compare"].includes(action) || (action === "report" ? ids.length !== 1 : ids.length < 2)) throw new Error("Use report for one ID or compare for 2..20 IDs");
  const reports: Array<{ id: string; base: string; task_digest: string; [key: string]: unknown }> = [];
  for (const id of ids) {
    const status = await workerRequest(target, { operation: "inspect", requestId: id });
    const comparison = status.task?.state.status === "terminal" ? status.task.state.outcome?.result?.comparison : undefined;
    if (!comparison) throw new Error("Experiment has no terminal comparison; inspect the original worker request");
    reports.push({ id, ...comparison, assessments: status.assessments });
  }
  if (reports.some(report => report.base !== reports[0].base || report.task_digest !== reports[0].task_digest)) throw new Error("Comparison requires identical base, tasks and correctness criteria");
  return action === "report" ? reports[0] : { comparable_inputs: true, reports, qualification: "comparison_only" };
}
