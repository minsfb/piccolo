import fs from "node:fs";
import path from "node:path";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { readAdmissions } from "./admissions.ts";
import { SupervisorDoc } from "./supervisor.ts";
import { openWorkerStorage } from "./storage.ts";
import { managedModels } from "./models.ts";
import { workerRequest, readDispatchState, cacheDispatchState, type RemoteWorker } from "./remote.ts";
import { submissionSchema } from "./contract.ts";
import { digest, type Config } from "../config.ts";
import { Decisions } from "./jobs.ts";
import { outcomeProjection } from "./outcome.ts";
import { recoveryNoticeDismissed } from "./recovery-notices.ts";

export type RecoveryJob = { id: string; kind: string; owner: string; lifetime: string; host: string; state: string;
  terminal: boolean; availability: "available" | "unavailable" | "unchecked"; reason?: string; remote?: RemoteWorker;
  attention?: Array<{ id: string; question: string; stage: string }>; result?: unknown; hasResult?: boolean; cancellationError?: string; hostName?: string; parentReview?: string; outcomeRevision?: string; unresolvedRemote?: boolean; dismissed?: boolean };
export type RecoveryInventory = { session: string; jobs: RecoveryJob[]; independent: RecoveryJob[]; error?: string };
export function localWorkerDirectory(root: string, session: string) {
  if (!session || /[\\/]/.test(session) || [".", ".."].includes(session)) throw new Error("Invalid worker session identity");
  return path.join(root, ".cache", "piccolo", "workers", session);
}

/** Read persisted tasks through public storage/Harness APIs without enabling its
 * scheduler. Inspection neither loads native policy modules nor starts Pi Env.
 */
export async function discoverJobs(root: string, session: string, ctx: ExtensionContext, config?: Config, includeDismissed = false, skipSession = false): Promise<RecoveryInventory> {
  const inventory: RecoveryInventory = { session, jobs: [], independent: [] };
  const directory = localWorkerDirectory(root, session);
  if (!skipSession && fs.existsSync(path.join(directory, "worker.sqlite"))) {
    let release: (() => void) | undefined, harness: Harness | undefined;
    try {
      const file = path.join(directory, "workspace.json"), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 16000) throw new Error("Invalid saved workspace identity");
      const workspace = JSON.parse(fs.readFileSync(file, "utf8"));
      const store = await openWorkerStorage(directory, workspace); release = store.release;
      try { harness = await Harness.open(store.storage, { registry: createRegistry(), models: managedModels(ctx.modelRegistry) }, context); }
      catch (error) { await store.storage.close(context); throw error; }
      const admissions = await readAdmissions(harness, context);
      const graph = (await harness.inspect(context)).tasks.map(item => item.record);
      const questions = (await harness.snapshot(SupervisorDoc, context))?.requests ?? {};
      const decisions = (await harness.snapshot(Decisions, context))?.decisions ?? {};
      for (const [id, admission] of Object.entries(admissions)) {
        if (admission.input.owner !== session) continue;
        const task = await harness.getTask(admission.taskId as any, context);
        if (!task) continue;
        const terminal = task.state.status === "terminal", descendants = new Set<number>([task.id]);
        let changed = true;
        while (changed) { changed = false; for (const item of graph) if (item.owner && descendants.has(item.owner) && !descendants.has(item.id)) { descendants.add(item.id); changed = true; } }
        const attention: NonNullable<RecoveryJob["attention"]> = [];
        for (const [qid, question] of Object.entries(questions)) if (question.answer === null) {
          const stage = graph.find(item => descendants.has(item.id) && item.kind === "piccolo.stage" && "checkpoint" in item.state && (item.state.checkpoint as any).conversationId === question.conversationId);
          if (stage) attention.push({ id: qid, question: question.question, stage: String(stage.id) });
        }
        const outcome: any = terminal ? task.state.outcome : undefined;
        const projection = outcomeProjection(outcome, undefined, admission.cancellationError);
        const liveStages = graph.filter(item => descendants.has(item.id) && item.kind === "piccolo.stage" && item.state.status !== "terminal");
        const missing = liveStages.find(item => !fs.existsSync((item.input as any).cwd));
        const missingModel = liveStages.find(item => { const ref = (item.input as any).spec?.model; return ref && !ctx.modelRegistry.find(ref.provider, ref.modelId); });
        inventory.jobs.push({ id, kind: admission.input.kind, owner: session, lifetime: admission.input.lifetime,
          host: admission.input.placement?.workspace.host ?? admission.input.workspace.host,
          state: terminal || admission.cancellationError ? projection.state : attention.length ? "needs_parent" : "suspended",
          terminal, availability: !admission.input.placement && (missing || missingModel) ? "unavailable" : "unchecked", remote: admission.input.placement, attention,
          parentReview: decisions[id] && projection.revision && decisions[id].revision === projection.revision ? decisions[id].disposition : terminal ? "pending" : "not_ready",
          outcomeRevision: projection.revision,
          cancellationError: admission.cancellationError, hasResult: projection.result !== undefined,
          unresolvedRemote: !!admission.input.placement && terminal && ["faulted", "failed"].includes(outcome?.status) && outcome?.result?.status !== "rejected",
          ...(outcome ? { result: outcome.result } : {}),
          ...(projection.error ? { reason: projection.error } : {}),
          ...(!admission.input.placement && (missing || missingModel) ? { reason: missing ? "Saved stage working directory is no longer available" : "Saved stage model is no longer registered on this host" } : {}) });
      }
    } catch (error) { inventory.error = String(error).slice(0, 1000); }
    finally { try { await harness?.close(context); } finally { release?.(); } }
  }
  const dispatch = path.join(root, ".cache", "piccolo", "dispatch");
  if (fs.existsSync(dispatch)) {
    const stat = fs.lstatSync(dispatch);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dispatch) !== path.resolve(dispatch)) {
      inventory.error = [inventory.error, "Invalid retained dispatch directory; restore its original real path before reconnecting."].filter(Boolean).join("; ");
      return inventory;
    }
    for (const name of fs.readdirSync(dispatch).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).slice(0, 1000)) {
      const file = path.join(dispatch, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 9 * 1024 * 1024) continue;
      try {
        const saved = JSON.parse(fs.readFileSync(file, "utf8")), submission = submissionSchema.parse(saved.submission);
        z.string().uuid().parse(submission.requestId);
        if (name !== `${submission.requestId}.json` || submission.lifetime !== "independent" || inventory.jobs.some(job => job.id === submission.requestId)) continue;
        const dismissed = recoveryNoticeDismissed(root, submission.requestId, saved);
        if (dismissed && !includeDismissed) continue;
        // The live configured assignment is resolved and verified only at attach.
        const host = Object.entries(config?.hosts ?? {}).find(([, host]) => host.worker_transport && host.worker_identity === submission.workspace.identity && host.cwd === submission.workspace.cwd && host.hostname === submission.workspace.host);
        const remote = host ? { workspace: submission.workspace, transport: host[1].worker_transport! } : undefined;
        const changed = !!remote && digest(remote) !== saved.assignment;
        const cached = readDispatchState(root, submission.requestId);
        if (cached && cached.assignment === saved.assignment && cached.handled) continue;
        inventory.independent.push({ id: submission.requestId, kind: submission.kind, owner: submission.owner, dismissed,
          lifetime: submission.lifetime, host: submission.workspace.host, state: cached && cached.assignment === saved.assignment ? cached.state : "detached", terminal: !!cached && cached.assignment === saved.assignment,
          parentReview: cached ? "pending" : "not_ready", availability: remote && !changed ? "unchecked" : "unavailable",
          ...(remote && !changed ? { remote, hostName: host![0] } : { reason: "Restore the original configured worker assignment to reconnect." }) });
      } catch { /* Malformed retained intents do not authorize reconnection. */ }
    }
  }
  return inventory;
}

/** Bound remote probes. An unavailable endpoint is not evidence that its work
 * stopped. Local execution and policy readiness are validated again on resume.
 */
export async function probeJobs(inventory: RecoveryInventory, root?: string, limit = 20, timeoutMs = 3000) {
  const candidates = [...inventory.jobs, ...inventory.independent].filter(job => !job.terminal || job.unresolvedRemote).slice(0, limit);
  const probe = async (job: RecoveryJob) => {
    if (!job.remote) { if (job.state !== "detached" && job.availability === "unchecked") job.availability = "available"; return; }
    try {
      const status = await workerRequest(job.remote, { operation: "inspect", requestId: job.id }, undefined, timeoutMs);
      job.availability = "available"; job.attention = status.attention;
      if (status.task?.state.status === "terminal") {
        const projected = outcomeProjection(status.task.state.outcome, undefined, job.cancellationError), revision = projected.revision;
        if (revision !== job.outcomeRevision) job.parentReview = "pending";
        job.outcomeRevision = revision;
        job.terminal = true; job.state = projected.state; job.result = projected.result; job.hasResult = projected.result !== undefined; job.reason = projected.error;
        if (root) try { cacheDispatchState(root, job.remote, job.id, "terminal", status.task.state.outcome); } catch { /* Advisory cache only. */ }
      } else { job.terminal = false; job.state = job.cancellationError ? "unresolved" : status.attention?.length ? "needs_parent" : "running"; job.parentReview = "not_ready"; job.outcomeRevision = undefined; job.result = undefined; job.hasResult = false; }
    } catch (error) { job.availability = "unavailable"; job.reason = `Remote work may still exist. ${String(error).slice(0, 700)}`; }
  };
  for (let offset = 0; offset < candidates.length; offset += 4) await Promise.all(candidates.slice(offset, offset + 4).map(probe));
  return inventory;
}
