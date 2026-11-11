import fs from "node:fs";
import path from "node:path";
import { digest } from "../config.ts";
import { transportRequest } from "../remote.ts";
import { workerRequestSchema, type WorkerSubmission, type Workspace } from "./contract.ts";
import { z } from "zod";
import { requireIgnoredArtifacts } from "./artifacts.ts";
import { randomUUID } from "node:crypto";

export type RemoteWorker = { workspace: Workspace; transport: string[] };
export type AdmissionRejection = { state: "rejected"; requestId: string; fingerprint: string; error?: string };
export class RemoteRejected extends Error {
  readonly admission?: AdmissionRejection;
  constructor(message: string, admission?: AdmissionRejection) { super(message); this.admission = admission; }
}
export type DispatchState = { assignment: string; requestId: string; state: "terminal" | "rejected"; outcomeDigest: string; handled: boolean };
export function readDispatchState(root: string, requestId: string): DispatchState | undefined {
  z.string().uuid().parse(requestId);
  try {
  const file = path.join(root, ".cache", "piccolo", "dispatch", `${requestId}.state.json`);
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 16000) return;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.requestId !== requestId || !["terminal", "rejected"].includes(value.state) || typeof value.handled !== "boolean") return;
  const handledFile = path.join(path.dirname(file), `${requestId}.handled.json`);
  if (fs.existsSync(handledFile)) {
    const stat = fs.lstatSync(handledFile);
    if (stat.isFile() && stat.size <= 16000) {
      const handled = JSON.parse(fs.readFileSync(handledFile, "utf8"));
      value.handled ||= handled.handled === true && handled.assignment === value.assignment && handled.outcomeDigest === value.outcomeDigest;
    }
  }
  return value;
  } catch { return undefined; } // Malformed advisory cache cannot hide retained work.
}
/** Advisory discovery cache, bound to the immutable assignment. It cannot admit,
 * resume or cancel work and contains no prompts/transcripts. */
export function cacheDispatchState(root: string, target: RemoteWorker, requestId: string, state: DispatchState["state"], outcome: unknown, handled = false) {
  const directory = path.join(root, ".cache", "piccolo", "dispatch"), file = path.join(directory, `${requestId}.state.json`);
  requireIgnoredArtifacts(root, [file]);
  if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new Error("Dispatch cache requires its original real directory");
  const prior = readDispatchState(root, requestId);
  const value = { assignment: digest(target), requestId, state, outcomeDigest: digest(outcome), handled: false };
  if (prior && (prior.assignment !== value.assignment || prior.outcomeDigest !== value.outcomeDigest)) throw new Error("Dispatch outcome cache changed; reconcile the original worker");
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  const destination = handled ? path.join(directory, `${requestId}.handled.json`) : file;
  requireIgnoredArtifacts(root, [destination]);
  try {
    if (!prior || handled) {
      fs.writeFileSync(temporary, JSON.stringify({ ...value, handled }), { flag: "wx", mode: 0o600 });
      try { fs.linkSync(temporary, destination); } catch (error: any) { if (error.code !== "EEXIST") throw error; }
    }
  }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function retainedAssignment(root: string, target: RemoteWorker, requestId: string) {
  z.string().uuid().parse(requestId);
  const file = path.join(root, ".cache", "piccolo", "dispatch", `${requestId}.json`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 9 * 1024 * 1024) throw new Error("Invalid retained dispatch intent");
  const intent = JSON.parse(fs.readFileSync(file, "utf8"));
  if (intent.assignment !== digest(target) || intent.submission.requestId !== requestId) throw new Error("Restore the original worker assignment before reconnecting");
  return intent;
}
export async function workerRequest(target: RemoteWorker, request: unknown, signal?: AbortSignal, timeoutMs = 40000) {
  const value = workerRequestSchema.parse({ ...(request as object), workspace: target.workspace });
  const response = await transportRequest(target.transport, value, timeoutMs, true, 16 * 1024 * 1024, signal);
  if (response.error) throw new RemoteRejected(response.error, response.admission);
  return response.result;
}

/** Save assignment before network dispatch. Retries retain request ID, workspace and transport. */
export async function dispatchRemote(root: string, target: RemoteWorker, submission: WorkerSubmission, signal?: AbortSignal, beforeSubmit?: () => Promise<void>) {
  if (digest(target.workspace) !== digest(submission.workspace)) throw new RemoteRejected("Submission differs from assigned worker workspace");
  try {
    z.string().uuid().parse(submission.requestId);
    requireIgnoredArtifacts(root, [path.join(".cache", "piccolo", "dispatch", `${submission.requestId}.json`)]);
  } catch (error) { throw new RemoteRejected(String(error)); }
  let directory = fs.realpathSync(root);
  for (const name of [".cache", "piccolo", "dispatch"]) {
    directory = path.join(directory, name);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Dispatch storage must not be symlinked");
  }
  const file = path.join(directory, `${submission.requestId}.json`);
  const intent = { version: 1, assignment: digest(target), submission };
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(intent)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directoryFd = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    if (!fs.lstatSync(file).isFile() || digest(JSON.parse(fs.readFileSync(file, "utf8"))) !== digest(intent)) throw new RemoteRejected("Remote assignment/input changed for an existing request; reconcile its original worker");
  }
  const info = await workerRequest(target, { operation: "info" }, signal);
  if (info.version !== 1 || info.registry !== "piccolo-1" || digest(info.workspace) !== digest(target.workspace)) throw new RemoteRejected("Remote worker identity or registry mismatch");
  if (!info.capabilities?.submissionFeatures?.includes("admission-rejection-receipt")) throw new RemoteRejected("Upgrade the assigned worker: durable admission rejection receipts are required before dispatch");
  const required = [...(submission.cwd ? ["delegate-cwd"] : []), ...(submission.origin ? ["job-origin"] : []),
    ...((submission.kind === "schedule" || submission.kind === "experiment") && submission.pipeline.timeoutMs ? ["pipeline-timeout"] : [])];
  if (required.some(feature => !info.capabilities?.submissionFeatures?.includes(feature))) throw new RemoteRejected("Upgrade the assigned worker before submitting these execution-contract features");
  await beforeSubmit?.();
  const admitted = await workerRequest(target, { operation: "submit", submission }, signal);
  if (admitted.fingerprint !== digest(submission)) throw new RemoteRejected("Remote admission fingerprint mismatch");
  return admitted;
}
