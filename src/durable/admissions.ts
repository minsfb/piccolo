import { defineDoc, defineDocFamily, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { digest } from "../config.ts";
import type { WorkerSubmission } from "./contract.ts";

export type Admission = { taskId: number; fingerprint: string; input: WorkerSubmission; originOwner?: string; previousControllers?: number[]; cancellationRequested?: boolean; cancellationError?: string };
type StoredAdmission = Omit<Admission, "input"> & { input?: WorkerSubmission; inputKey?: string };
type Jobs = { requests: Record<string, StoredAdmission> };
export const JobsDoc = defineDoc<Jobs>({ kind: "piccolo.jobs", version: 2, scope: "session", initial: () => ({ requests: {} }), migrate: value => value as Jobs });
export const JobInputs = defineDocFamily<{ input: WorkerSubmission | null }, WorkerSubmission | null>({ kind: "piccolo.job-input", version: 1, scope: "session", family: true, initial: input => ({ input }) });

/** Immutable inputs live once per Job, outside the frequently changing index. */
export async function persistAdmission(tx: Tx, id: string, admission: Admission) {
  const input = await tx.doc(JobInputs, id, admission.input);
  if (!input.input || digest(input.input) !== digest(admission.input)) throw new Error("Immutable Job input changed");
  const { input: _input, ...metadata } = admission;
  (await tx.doc(JobsDoc)).requests[id] = { ...metadata, inputKey: id };
}
export async function resolveAdmission(tx: Tx, id: string, stored: StoredAdmission): Promise<Admission> {
  if (stored.inputKey !== undefined && stored.inputKey !== id) throw new Error("Saved Job input reference differs from its request identity");
  const input = stored.input ?? (await tx.doc(JobInputs, stored.inputKey ?? id, null)).input;
  if (!input) throw new Error("Saved Job input is missing; reconcile its original store");
  if (input.requestId !== id) throw new Error("Saved Job input differs from its request identity");
  const { inputKey: _key, ...metadata } = stored;
  return { ...JSON.parse(JSON.stringify(metadata)), input: JSON.parse(JSON.stringify(input)) };
}
export async function readAdmissions(harness: Pick<Harness, "snapshot">, context: Context): Promise<Record<string, Admission>> {
  const entries = (await harness.snapshot(JobsDoc, context))?.requests ?? {};
  const result: Record<string, Admission> = {};
  for (const [id, stored] of Object.entries(entries)) {
    if (stored.inputKey !== undefined && stored.inputKey !== id) throw new Error("Saved Job input reference differs from its request identity");
    const input = stored.input ?? (await harness.snapshot(JobInputs, stored.inputKey ?? id, context))?.input;
    if (!input) throw new Error("Saved Job input is missing; reconcile its original store");
    if (input.requestId !== id) throw new Error("Saved Job input differs from its request identity");
    const { inputKey: _key, ...metadata } = stored;
    result[id] = { ...metadata, input } as Admission;
  }
  return result;
}

export async function readAdmission(harness: Pick<Harness, "snapshot">, id: string, context: Context): Promise<Admission | undefined> {
  const stored = (await harness.snapshot(JobsDoc, context))?.requests[id];
  if (!stored) return;
  if (stored.inputKey !== undefined && stored.inputKey !== id) throw new Error("Saved Job input reference differs from its request identity");
  const input = stored.input ?? (await harness.snapshot(JobInputs, stored.inputKey ?? id, context))?.input;
  if (!input) throw new Error("Saved Job input is missing; reconcile its original store");
  if (input.requestId !== id) throw new Error("Saved Job input differs from its request identity");
  const { inputKey: _key, ...metadata } = stored;
  return { ...metadata, input } as Admission;
}
