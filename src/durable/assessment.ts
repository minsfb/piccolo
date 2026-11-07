import { z } from "zod";
import { defineDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { digest } from "../config.ts";
import type { DurableWorker } from "./worker.ts";

export const assessmentSchema = z.strictObject({ trial: z.string().min(1), outcomeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  verdict: z.enum(["pass", "fail", "uncertain"]), assessor: z.string().min(1).max(500), provenance: z.enum(["human_reported", "agent_reported"]),
  evidence: z.array(z.string().min(1).max(2000)).min(1).max(20), note: z.string().min(1).max(6000) });
type Assessment = z.infer<typeof assessmentSchema>;
export const Assessments = defineDoc<{ requests: Record<string, Record<string, Assessment>> }>({ kind: "piccolo.experiment-assessments", version: 1,
  scope: "session", initial: () => ({ requests: {} }) });

export async function assessTrial(worker: DurableWorker, requestId: string, value: unknown) {
  const assessment = assessmentSchema.parse(value);
  const { input } = await worker.admission(requestId);
  if (input.kind !== "experiment" || input.placement) throw new Error("Assess on the assigned experiment worker");
  if (input.pipeline.nodes[assessment.trial]?.criterion?.kind !== "rubric") throw new Error("Only rubric criteria accept reported assessments");
  const task = (await worker.inspect(requestId)).task;
  if (task?.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("Experiment must settle before assessment");
  const result = (task.state.outcome.result as any)?.results?.[assessment.trial];
  if (!result || digest(result) !== assessment.outcomeDigest) throw new Error("Assessment binds a different trial outcome");
  await worker.harness.commit(async tx => {
    const doc = await tx.doc(Assessments), requests = doc.requests[requestId] ??= {};
    if (requests[assessment.trial] && digest(requests[assessment.trial]) !== digest(assessment)) throw new Error("Reported assessment cannot be overwritten");
    requests[assessment.trial] = assessment;
  }, context);
  return assessment;
}
