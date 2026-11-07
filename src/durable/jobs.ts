import { assessTrial } from "./assessment.ts";
import { exportRoadmap } from "./roadmap-export.ts";
import { workerRequest, readDispatchState, cacheDispatchState } from "./remote.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { digest } from "../config.ts";
import type { SessionJobs } from "../session-jobs.ts";
import type { WorkerSubmission } from "./contract.ts";
import { DurableWorker, JobsDoc, MessagesDoc } from "./worker.ts";
import { RemoteSnapshots } from "./remote-task.ts";
import { SupervisorDoc } from "./supervisor.ts";
import { WorkerWaitCancelled } from "./wait.ts";
import { stageActivity } from "./stage.ts";
import { outcomeProjection } from "./outcome.ts";

type Decision = { disposition: "acknowledged" | "superseded"; revision: string; note: string; at: string; replacement?: string };
export const Decisions = defineDoc<{ decisions: Record<string, Decision>; history?: Record<string, Decision[]> }>({ kind: "piccolo.decisions", version: 1, scope: "session", initial: () => ({ decisions: {} }) });
const Notifications = defineDoc<{ modes: Record<string, "follow_up" | "notify_only"> }>({ kind: "piccolo.job-notifications", version: 1, scope: "session", initial: () => ({ modes: {} }) });
type Status = ReturnType<SessionJobs["status"]> & { attention?: Array<{ id: string; question: string; stage: string }>; attention_total?: number; cwd?: string; origin?: WorkerSubmission["origin"] };
type Cached = { status: Status; result?: unknown; error?: string; inspected?: string; ranges: Array<[number, number]> };

/** Disposable UI cache of Durable commits. Only decisions are written, on the same Harness mutation line. */
export class DurableJobs {
  readonly runtime = randomUUID();
  readonly jobs = new Map<string, Cached>();
  readonly root: string;
  readonly session: string;
  readonly worker: DurableWorker;
  private changed: () => void;
  private notify: (ids: string[]) => void;
  private pending = Promise.resolve();
  private refreshing = false;
  private dirty = false;
  private unsubscribe: () => void;
  private closed = false;
  private release: () => void | Promise<void>;
  private notices = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private shutdownMs: number;
  constructor(root: string, session: string, worker: DurableWorker, options: { changed: () => void; notify: (ids: string[]) => void; release: () => void | Promise<void>; shutdownMs?: number }) {
    this.root = root; this.session = session; this.worker = worker;
    this.changed = options.changed; this.notify = options.notify; this.release = options.release;
    this.shutdownMs = options.shutdownMs ?? 15000;
    this.unsubscribe = worker.harness.subscribeCommits(() => {
      this.dirty = true;
      if (this.refreshing) return;
      this.refreshing = true;
      this.pending = this.pending.then(async () => { while (this.dirty && !this.closed) { this.dirty = false; await this.refresh(); } })
        .catch(() => { /* Explicit reads report storage failures. */ }).finally(() => { this.refreshing = false; });
    });
  }
  async refresh() {
    const admissions = (await this.worker.harness.snapshot(JobsDoc, context))?.requests ?? {};
    const decisions = (await this.worker.harness.snapshot(Decisions, context))?.decisions ?? {};
    const messages = (await this.worker.harness.snapshot(MessagesDoc, context))?.messages ?? {};
    const questions = (await this.worker.harness.snapshot(SupervisorDoc, context))?.requests ?? {};
    const remoteSnapshots = (await this.worker.harness.snapshot(RemoteSnapshots, context))?.requests ?? {};
    const graph = { tasks: (await this.worker.harness.inspect(context)).tasks.map(item => item.record) };
    for (const [id, admission] of Object.entries(admissions)) {
      if (admission.input.owner !== this.session) continue;
      const previous = this.jobs.get(id);
      const task = await this.worker.harness.getTask(admission.taskId as any, context);
      if (!task) continue;
      const outcome = task.state.status === "terminal" ? task.state.outcome : undefined;
      const connectionError = task.kind === "piccolo.remote" && "checkpoint" in task.state ? (task.state.checkpoint as any)?.error : undefined;
      const { result, error, revision, state: projectedState } = outcomeProjection(outcome, connectionError, admission.cancellationError);
      let state: Status["state"] = projectedState;
      const descendants = new Set<number>([task.id]);
      let added = true;
      while (added) { added = false; for (const child of graph.tasks) if (child.owner && descendants.has(child.owner) && !descendants.has(child.id)) { descendants.add(child.id); added = true; } }
      const remote = task.kind === "piccolo.remote" ? remoteSnapshots[id] : undefined;
      const children = graph.tasks.filter(child => descendants.has(child.id) && child.kind === "piccolo.stage");
      const attention: NonNullable<Status["attention"]> = [...(remote?.attention ?? [])];
      for (const [id, question] of Object.entries(questions)) if (question.answer === null) {
        const stage = children.find(child => "checkpoint" in child.state && (child.state.checkpoint as any)?.conversationId === question.conversationId);
        if (stage) attention.push({ id, question: question.question, stage: String(stage.id) });
      }
      if (!outcome && !error && task.kind === "piccolo.stage" && stageActivity(task) === "waiting") state = "queued";
      if (attention.length && !outcome) state = "needs_parent";
      const instructions: Status["messages"] = [...(remote?.messages ?? [])];
      for (const [messageId, message] of Object.entries(messages).filter(([, message]) => message.requestId === id)) {
        if (instructions.some(receipt => receipt.id === messageId)) continue;
        const submission = message.submissionId ? await this.worker.harness.submission(message.submissionId as any, context) : undefined;
        const receipt = await submission?.status(context);
        const decision = message.supervisorId ? await this.worker.harness.getTask(Number(message.supervisorId) as any, context) : undefined;
        const queued = message.queuedStageId ? await this.worker.harness.getTask(message.queuedStageId as any, context) : undefined;
        const delivered = receipt?.status === "done" || decision?.state.status === "terminal" || (queued?.state.status === "terminal" && queued.state.outcome.status === "completed");
        instructions.push({ id: messageId, target: message.target ?? undefined, state: message.remoteState === "unresolved" ? "uncertain" : message.remoteState === "pending" ? "queued" : delivered ? "delivered" : receipt?.status === "unanswered" ? "rejected" : message.queuedStageId && !message.conversationId ? "queued" : "routed",
          ...(delivered ? { observation: "durable_input_answered; action_not_verified" } : {}) });
      }
      const status: Status = { id, kind: admission.input.kind, state, stopping: task.abortRequested, lifetime: admission.input.lifetime, host: (admission.input.placement?.workspace ?? admission.input.workspace).host,
        cwd: admission.input.cwd ?? admission.input.placement?.workspace.cwd ?? admission.input.workspace.cwd, origin: admission.input.origin,
        updated_at: task.endedAt ?? task.startedAt ?? Date.now(), record: `durable:${admission.input.workspace.identity}/${id}`, error_truncated: (error?.length ?? 0) > 1000,
        outcome_revision: revision, parent_review: decisions[id] && revision && decisions[id].revision === revision ? decisions[id] : { disposition: outcome ? "pending" : "not_ready" }, error: error?.slice(0, 1000),
        children: remote ? remote.children.slice(0, 8) : children.slice(0, 8).map(child => ({ id: String(child.id), target: String(child.id), target_truncated: false, coordinator: true, attached: true, phase: stageActivity(child) })),
        children_total: remote?.children.length ?? children.length, messages: instructions.slice(-8), messages_total: instructions.length, attention: attention.slice(0, 4), attention_total: attention.length };
      const sameRevision = revision === previous?.status.outcome_revision;
      this.jobs.set(id, { status, result, error, inspected: sameRevision ? previous?.inspected : undefined, ranges: sameRevision ? previous?.ranges ?? [] : [] });
      if (((outcome && !sameRevision && decisions[id]?.revision !== revision) || attention.some(question => !previous?.status.attention?.some(prior => prior.id === question.id))) && !this.closed) {
        this.notices.add(id);
        this.timer ??= setTimeout(() => { this.timer = undefined; const ids = [...this.notices]; this.notices.clear(); if (!this.closed) { try { this.notify(ids); } catch { this.changed(); } } }, 100);
      }
    }
    this.changed();
  }
  async submit(request: WorkerSubmission) {
    if (this.closed || request.owner !== this.session) throw new Error("Job owner differs from this session");
    await this.worker.submit(request); await this.refresh(); return request.requestId;
  }
  async notificationModes() { return (await this.worker.harness.snapshot(Notifications, context))?.modes ?? {}; }
  async setNotification(id: string, mode: "follow_up" | "notify_only") {
    this.get(id);
    await this.worker.harness.commit(async tx => { (await tx.doc(Notifications)).modes[id] ??= mode; }, context);
  }
  async attach(value: unknown, target: import("./remote.ts").RemoteWorker) {
    if (this.closed) throw new Error("Jobs are closed");
    const admission = await this.worker.attach(value, target, this.session); await this.refresh(); return admission.input.requestId;
  }
  private get(id: string) { const job = this.jobs.get(id); if (!job) throw new Error("Job is not owned by this session"); return job; }
  status(id: string): Status {
    const value = structuredClone(this.get(id).status);
    value.stopping ||= this.worker.stopping(id);
    value.error ??= this.worker.abortError(id);
    return value;
  }
  list(offset = 0, limit = 20) { return [...this.jobs.keys()].slice(offset, offset + limit).map(id => this.status(id)); }
  inspect(id: string, revision: string) { const job = this.get(id); if (!revision || revision !== job.status.outcome_revision) throw new Error("Result changed before inspection"); job.inspected = revision; }
  result(id: string, inspected = true) {
    const job = this.get(id), result = { ...this.status(id), error: job.error, error_truncated: false, result: structuredClone(job.result) };
    if (inspected && result.outcome_revision && JSON.stringify(result).length <= 16000) this.inspect(id, result.outcome_revision);
    return result;
  }
  resultPage(id: string, revision: string, offset = 0) {
    const job = this.get(id);
    if (!revision || revision !== job.status.outcome_revision) throw new Error("Read status for the terminal outcome revision");
    const text = JSON.stringify({ state: job.status.state, result: job.result, error: job.error });
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= text.length) throw new Error("Invalid result page offset");
    const end = Math.min(text.length, offset + 2000);
    const ranges: Array<[number, number]> = [...job.ranges, [offset, end]];
    ranges.sort((a, b) => a[0] - b[0]); job.ranges = [];
    for (const range of ranges) { const last = job.ranges.at(-1); if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else job.ranges.push(range); }
    if (job.ranges.length === 1 && job.ranges[0][0] === 0 && job.ranges[0][1] === text.length) this.inspect(id, revision);
    return { id, outcome_revision: revision, offset, next_offset: end < text.length ? end : null, text: text.slice(offset, end), inspected: job.inspected === revision };
  }
  async acknowledge(id: string, revision: string, note: string, replacement?: string) {
    const job = this.get(id);
    if (!revision || revision !== job.status.outcome_revision || job.inspected !== revision) throw new Error("Inspect this terminal job result before acknowledging its exact outcome_revision");
    if (!note.trim() || note.length > 2000) throw new Error("Acknowledgment needs a decision note of 1..2000 characters");
    if (replacement) { const next = this.get(replacement), ids = [...this.jobs.keys()]; if (next.status.kind !== job.status.kind || ids.indexOf(replacement) <= ids.indexOf(id)) throw new Error("Replacement must be a later same-kind job"); }
    await this.worker.harness.commit(async tx => {
      const doc = await tx.doc(Decisions), prior = doc.decisions[id];
      if (prior?.revision === revision) { if (prior.note !== note || prior.replacement !== replacement) throw new Error("Decision history cannot be overwritten"); return; }
      if (prior) { doc.history ??= {}; doc.history[id] = [...(doc.history[id] ?? []), JSON.parse(JSON.stringify(prior))]; }
      doc.decisions[id] = { disposition: replacement ? "superseded" : "acknowledged", revision, note, at: new Date().toISOString(), ...(replacement ? { replacement } : {}) };
    }, context);
    this.notices.delete(id); await this.refresh();
    const admission = await this.worker.admission(id);
    if (admission.input.placement) try {
      const cached = readDispatchState(this.root, id), task = (await this.worker.inspect(id)).task;
      if (cached && task?.state.status === "terminal") {
        const outcome: any = task.state.outcome;
        cacheDispatchState(this.root, admission.input.placement, id, cached.state, cached.state === "rejected" ? outcome.result?.admission : outcome, true);
      }
    } catch { /* The durable parent decision remains authoritative if advisory cache is unavailable. */ }
    return this.status(id);
  }
  async message(id: string, text: string, target?: string, messageId: string = randomUUID()) {
    z.string().uuid().parse(messageId);
    if (!text.trim() || text.length > 16000) throw new Error("Instruction must contain 1..16000 characters");
    const prior = (await this.worker.harness.snapshot(MessagesDoc, context))?.messages[messageId];
    if (prior && (prior.requestId !== id || prior.text !== text || prior.target !== (target ?? null))) throw new Error("Message ID reused with different input");
    const children = this.status(id).children;
    if (!prior && !target && children.length > 1) throw new Error("Select a single active stage before messaging this workflow");
    // Persist the identity before a remote send. The same explicit message ID
    // can reconcile a lost delivery response without adding a second input.
    const assignment = (await this.worker.admission(id)).input.placement;
    if (assignment) await this.worker.harness.commit(async tx => {
      const doc = await tx.doc(MessagesDoc), prior = doc.messages[messageId];
      if (prior && (prior.requestId !== id || prior.text !== text || prior.target !== (target ?? null))) throw new Error("Message ID reused with different input");
      doc.messages[messageId] ??= { requestId: id, text, target: target ?? null, conversationId: 0, submissionId: null, remoteState: "pending" };
    }, context);
    try {
      const submission = await this.worker.message(id, messageId, text, target);
      if (assignment) await this.worker.harness.commit(async tx => { const value = (await tx.doc(MessagesDoc)).messages[messageId]; value.remoteState = "routed"; value.remoteReceipt = submission; }, context);
      return { id: messageId, state: "routed", submission };
    } catch (error) {
      if (assignment) await this.worker.harness.commit(async tx => { (await tx.doc(MessagesDoc)).messages[messageId].remoteState = "unresolved"; }, context);
      throw error;
    }
  }
  async assess(id: string, assessment: unknown) {
    this.get(id);
    const assignment = (await this.worker.admission(id)).input.placement;
    return assignment ? workerRequest(assignment, { operation: "assess", requestId: id, assessment }) : assessTrial(this.worker, id, assessment);
  }
  private async fullExperimentReport(id: string) {
    this.get(id);
    const admission = await this.worker.admission(id);
    if (admission.input.kind !== "experiment") throw new Error("Job is not an experiment");
    const status = admission.input.placement ? await workerRequest(admission.input.placement, { operation: "inspect", requestId: id }) : await this.worker.status(id);
    const outcome = status.task?.state.status === "terminal" ? status.task.state.outcome : undefined;
    return { id, comparison: outcome?.result?.comparison ?? null, assessments: status.assessments };
  }
  async experimentReport(id: string, offset = 0, revision?: string) {
    const report = await this.fullExperimentReport(id), current = digest(report), text = JSON.stringify(report);
    if (offset && revision !== current) throw new Error("Experiment report changed; restart pagination at offset 0");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= text.length) throw new Error("Invalid report offset");
    const end = Math.min(text.length, offset + 2000);
    return { id, report_revision: current, offset, next_offset: end < text.length ? end : null, text: text.slice(offset, end) };
  }
  async exportSchedule(id: string) {
    this.get(id);
    const assignment = (await this.worker.admission(id)).input.placement;
    return assignment ? workerRequest(assignment, { operation: "export_schedule", requestId: id }) : exportRoadmap(this.worker, id);
  }
  async stop(id: string, milliseconds = 1000) {
    const wait = withCancel(context), timer = setTimeout(() => wait.cancel(), Math.min(30000, Math.max(0, milliseconds)));
    let pending = false;
    try { await this.worker.abort(id, wait.context); }
    catch (error) { if (!(error instanceof WorkerWaitCancelled)) throw error; pending = true; }
    finally { clearTimeout(timer); wait.cancel(); }
    if (!pending) await this.refresh();
    return this.status(id);
  }
  async wait(id: string, milliseconds = 1000) {
    const wait = withCancel(context);
    const timer = setTimeout(() => wait.cancel(), Math.min(30000, Math.max(0, milliseconds)));
    try { await this.worker.wait(id, wait.context); }
    catch (error) { if (!wait.context.abortSignal?.aborted) throw error; }
    finally { clearTimeout(timer); wait.cancel(); }
    await this.refresh(); return this.result(id);
  }
  async close(reason: string) {
    this.closed = true; clearTimeout(this.timer); this.notices.clear(); this.unsubscribe();
    try { await this.worker.close(reason === "suspend" ? "suspend" : "cancel-session", this.session, this.shutdownMs); } finally { await this.release(); }
  }
}
