import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { digest } from "./config.ts";
import { createWorkerControl, closeWorkerControl, queueWorkerMessage, type WorkerControl } from "./worker-control.ts";

export type JobKind = "delegate" | "workflow" | "schedule" | "experiment";
export type JobState = "queued" | "running" | "completed" | "needs_parent" | "cancelled" | "unresolved";
type Instruction = { id: string; text: string; target?: string; child_message?: string; state: "queued" | "routed" | "delivered" | "rejected" | "uncertain" };
export type JobExecution = {
  id: string; signal: AbortSignal;
  event: (value: Record<string, unknown>) => void;
  child: (target: string, tools?: string[], coordinator?: boolean) => WorkerControl;
  releaseChild: (control: WorkerControl) => void;
};
type Job = {
  id: string; kind: JobKind; state: JobState; directory: string; sequence: number;
  controller: AbortController; done: Promise<void>; result?: unknown; error?: string;
  children: Map<string, { control: WorkerControl; target: string; coordinator: boolean }>;
  messages: Instruction[];
  uncertain?: boolean;
  updatedAt: number;
  inspected?: string;
  pages?: { revision: string; ranges: Array<[number, number]> };
  review?: { disposition: "acknowledged" | "superseded"; revision: string; note: string; replacement?: string; at: string };
};
function directory(root: string, relative: string) {
  let current = fs.realpathSync(root);
  for (const part of relative.split("/")) {
    if (!part || part === "." || part === "..") throw new Error("Invalid job record path");
    current = path.join(current, part);
    try { fs.mkdirSync(current); } catch (error: any) { if (error.code !== "EEXIST") throw error; }
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) throw new Error("Job record directory must not be a symlink");
  }
  return current;
}
function write(file: string, value: unknown) {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.linkSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
const active = (job: Job) => job.state === "queued" || job.state === "running";
type Options = { maxJobs?: number; shutdownMs?: number; changed?: () => void; notify?: (ids: string[]) => void };

/** Owns executions, never adopts unfinished records from another runtime. */
export class SessionJobs {
  readonly runtime = randomUUID();
  readonly jobs = new Map<string, Job>();
  private closed = false;
  private notices = new Set<string>();
  private noticeTimer?: ReturnType<typeof setTimeout>;
  readonly root: string;
  readonly session: string;
  private options: Options;
  constructor(root: string, session: string, options: Options = {}) { this.root = root; this.session = session; this.options = options; }
  private event(job: Job, value: Record<string, unknown>) {
    job.updatedAt = Date.now();
    if (value.kind === "cancellation_unacknowledged") job.uncertain = true;
    try {
      const home = directory(this.root, `.piccolo/jobs/${job.id}`);
      write(path.join(home, `${String(++job.sequence).padStart(6, "0")}.json`), {
        ...structuredClone(value), format: 1, job: job.id, runtime: this.runtime, at: new Date().toISOString(),
      });
    } catch (error) {
      job.error = `Record failure: ${String(error)}`;
      if (active(job)) { job.uncertain = true; job.controller.abort(error); }
      throw error;
    }
    this.options.changed?.();
  }
  submit(kind: JobKind, snapshot: unknown, execute: (job: JobExecution) => Promise<unknown>): string {
    if (this.closed) throw new Error("Owning session has closed");
    if (this.jobs.size >= (this.options.maxJobs ?? 1000)) throw new Error("Session job launch budget reached");
    const id = randomUUID(); const home = directory(this.root, `.piccolo/jobs/${id}`);
    const inputs = structuredClone(snapshot);
    write(path.join(home, "launch.json"), { format: 1, id, kind, session: this.session, runtime: this.runtime,
      host: os.hostname(), lifetime: "session", created_at: new Date().toISOString(), inputs, digest: digest(inputs) });
    const job: Job = { id, kind, state: "queued", directory: home, sequence: 0, controller: new AbortController(), done: Promise.resolve(), children: new Map(), messages: [], updatedAt: Date.now() };
    this.jobs.set(id, job); this.event(job, { kind: "queued" });
    job.done = Promise.resolve().then(async () => {
      if (job.controller.signal.aborted) { job.state = "cancelled"; return; }
      job.state = "running"; this.event(job, { kind: "running" });
      job.result = await execute({ id, signal: job.controller.signal, event: value => this.event(job, value),
        child: (target, tools, coordinator = false) => {
          const control = createWorkerControl(value => {
            if (value.kind === "message_delivered" || value.kind === "message_rejected") {
              const instruction = job.messages.find(message => message.child_message === (value.message as any)?.id);
              if (instruction) instruction.state = value.kind === "message_delivered" ? "delivered" : "rejected";
            }
            this.event(job, { ...value, child: control.id, target });
          }, tools);
          job.children.set(control.id, { control, target, coordinator });
          this.event(job, { kind: "child_created", child: control.id, target, coordinator });
          this.route(job); return control;
        },
        releaseChild: control => { try { closeWorkerControl(control); } finally { job.children.delete(control.id); } },
      });
      const status = (job.result as any)?.status;
      const counts = (job.result as any)?.readiness?.task_status_counts;
      const completedSchedule = job.kind === "schedule" && status === "idle" && counts &&
        Object.entries(counts).every(([state, count]) => state === "complete" || count === 0);
      // Workflow interruption acknowledges the stopped graph, unless a child
      // explicitly reported uncertain cancellation. Native delegate interruption
      // alone is not proof that its execution stopped.
      const confirmedWorkflowStop = job.kind === "workflow" && job.controller.signal.aborted;
      job.state = job.uncertain || (status === "interrupted" && !confirmedWorkflowStop) ? "unresolved" : job.controller.signal.aborted ? "cancelled"
        : ["completed", "complete"].includes(status) || completedSchedule ? "completed" : "needs_parent";
    }).catch(error => { job.error = String(error); job.state = job.uncertain ? "unresolved" : job.controller.signal.aborted ? "cancelled" : "needs_parent"; })
      .finally(() => {
        for (const { control } of job.children.values()) {
          try { closeWorkerControl(control); } catch (error) { job.error = String(error); job.uncertain = true; job.state = "unresolved"; }
        }
        job.children.clear();
        for (const message of job.messages) if (["queued", "routed"].includes(message.state)) {
          message.state = message.state === "queued" ? "rejected" : "uncertain";
          this.event(job, { kind: "instruction_unconsumed", message, reason: "Job ended without a native message-start observation" });
        }
        write(path.join(directory(this.root, `.piccolo/jobs/${id}`), "outcome.json"), {
          format: 1, id, runtime: this.runtime, state: job.state, result: job.result, error: job.error, finished_at: new Date().toISOString(),
        });
        this.options.changed?.();
        if (!this.closed) {
          this.notices.add(id);
          this.noticeTimer ??= setTimeout(() => {
            this.noticeTimer = undefined;
            if (this.closed) return;
            const ids = [...this.notices].filter(id => !this.jobs.get(id)!.review); this.notices.clear();
            try { this.options.notify?.(ids); for (const id of ids) this.event(this.jobs.get(id)!, { kind: "notification_submitted" }); }
            catch (error) {
              for (const id of ids) {
                const job = this.jobs.get(id)!;
                job.error = `Notification failure: ${String(error)}`;
                try { this.event(job, { kind: "notification_failed", error: String(error) }); }
                catch { /* In-memory diagnostic survives when storage cannot. Never crash the host timer. */ }
              }
            }
          }, 100);
        }
      });
    // A recording failure is observable and must not become an unhandled process rejection.
    job.done = job.done.catch(error => { job.state = "unresolved"; job.error = `Record failure: ${String(error)}`; job.controller.abort(error); this.options.changed?.(); });
    return id;
  }
  private get(id: string) { const job = this.jobs.get(id); if (!job) throw new Error("Job is not owned by this session; retained records are not live executions"); return job; }
  private route(job: Job) {
    for (const message of job.messages.filter(m => m.state === "queued")) {
      const targets = [...job.children.values()].filter(child => message.target ? child.target === message.target || child.control.id === message.target : child.coordinator);
      if (targets.length !== 1) continue;
      const receipt = queueWorkerMessage(targets[0].control, message.text);
      message.state = receipt.state === "queued" ? "routed" : receipt.state; message.child_message = receipt.id;
      this.event(job, { kind: "instruction_routed", message, child: targets[0].control.id, child_message: receipt.id });
    }
  }
  message(id: string, text: string, target?: string) {
    const job = this.get(id);
    if (!active(job) || job.controller.signal.aborted) throw new Error("Ended or stopping jobs cannot receive instructions");
    if (!text.trim() || text.length > 16000) throw new Error("Instruction must contain 1..16000 characters");
    if (target && target.length > 4096) throw new Error("Instruction target is too long");
    if (job.messages.length >= 1000) throw new Error("Job instruction budget reached");
    if (["schedule", "experiment"].includes(job.kind) && !target) throw new Error("Scheduled instructions require an explicit child target from job status");
    const message: Instruction = { id: randomUUID(), text, target, state: "queued" };
    job.messages.push(message); this.event(job, { kind: "instruction_queued", message }); this.route(job);
    return { id: message.id, state: message.state, target: message.target };
  }
  private revision(job: Job) { return active(job) ? undefined : digest({ state: job.state, result: job.result, error: job.error }); }
  acknowledge(id: string, revision: string, note: string, replacement?: string) {
    const job = this.get(id);
    if (active(job) || !revision || revision !== this.revision(job) || job.inspected !== revision)
      throw new Error("Inspect this terminal job result before acknowledging its exact outcome_revision");
    if (!note.trim() || note.length > 2000) throw new Error("Acknowledgment requires a decision note of 1..2000 characters");
    if (replacement) {
      const next = this.get(replacement), ids = [...this.jobs.keys()];
      if (next.kind !== job.kind || ids.indexOf(replacement) <= ids.indexOf(id)) throw new Error("Replacement must be a later same-kind job owned by this session");
    }
    const decision = { disposition: replacement ? "superseded" as const : "acknowledged" as const, revision, note, ...(replacement ? { replacement } : {}), at: new Date().toISOString() };
    if (job.review) {
      if (job.review.revision === revision && job.review.note === note && job.review.replacement === replacement) return this.status(id);
      throw new Error("Job already has a recorded parent decision; history cannot be overwritten");
    }
    this.event(job, { kind: "parent_decision", ...decision });
    job.review = decision; this.notices.delete(id); this.options.changed?.();
    return this.status(id);
  }
  status(id: string) {
    const job = this.get(id);
    return { id, kind: job.kind, state: job.state, stopping: active(job) && job.controller.signal.aborted, lifetime: "session", host: os.hostname(), updated_at: job.updatedAt,
      record: path.relative(this.root, job.directory), error_truncated: (job.error?.length ?? 0) > 1000, outcome_revision: this.revision(job),
      parent_review: job.review ?? { disposition: active(job) ? "not_ready" : "pending" }, error: job.error?.slice(0, 1000),
      children: [...job.children.values()].slice(0, 8).map(({ control, target, coordinator }) => ({ id: control.id, target: target.slice(0, 240), target_truncated: target.length > 240, coordinator, attached: control.attached, phase: control.phase ?? "starting" })), children_total: job.children.size,
      messages: job.messages.slice(-8).map(({ id, target, state }) => ({ id, target: target?.slice(0, 240), state, ...(state === "delivered" ? { observation: "native_message_start; action_not_verified" } : {}) })), messages_total: job.messages.length,
    };
  }
  list(offset = 0, limit = 20) { return [...this.jobs.keys()].slice(offset, offset + limit).map(id => this.status(id)); }
  inspect(id: string, revision: string) {
    const job = this.get(id);
    if (!revision || revision !== this.revision(job)) throw new Error("Result changed before inspection completed");
    job.inspected = revision;
  }
  result(id: string, inspected = true) {
    const job = this.get(id), result = { ...this.status(id), error: job.error, error_truncated: false, result: structuredClone(job.result) };
    if (inspected && JSON.stringify(result).length <= 16000) job.inspected = this.revision(job);
    return result;
  }
  resultPage(id: string, revision: string, offset = 0) {
    const job = this.get(id);
    if (!revision || revision !== this.revision(job)) throw new Error("Inspect status for the current terminal outcome_revision");
    // Only the immutable outcome participates; live notification metadata cannot
    // change page offsets while the parent reads an outcome.
    const text = JSON.stringify({ state: job.state, result: job.result, error: job.error });
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= text.length) throw new Error("Result page offset is outside the outcome");
    const end = Math.min(text.length, offset + 2000);
    if (job.pages?.revision !== revision) job.pages = { revision, ranges: [] };
    const ranges = [...job.pages.ranges, [offset, end] as [number, number]].sort((a,b) => a[0]-b[0]);
    const merged: Array<[number, number]> = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]); else merged.push(range);
    }
    job.pages.ranges = merged;
    if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] === text.length) job.inspected = revision;
    return { id, outcome_revision: revision, offset, next_offset: end < text.length ? end : null, text: text.slice(offset, end), inspected: job.inspected === revision };
  }
  stop(id: string) {
    const job = this.get(id);
    if (active(job) && !job.controller.signal.aborted) {
      try { this.event(job, { kind: "stop_requested" }); } catch { /* Cancellation must survive failed recording. */ }
      finally { job.controller.abort(new Error("Explicit job stop")); }
    }
    return this.status(id);
  }
  async wait(id: string, milliseconds = 1000) {
    const job = this.get(id); let timer: ReturnType<typeof setTimeout>;
    await Promise.race([job.done, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(30000, Math.max(0, milliseconds))); })]).finally(() => clearTimeout(timer!));
    return this.result(id);
  }
  async close(reason: string) {
    if (this.closed) return;
    this.closed = true; if (this.noticeTimer) clearTimeout(this.noticeTimer); this.notices.clear();
    for (const job of this.jobs.values()) if (active(job)) {
      try { this.event(job, { kind: "session_closed", reason }); } catch { /* Continue cancelling every owned job. */ }
      finally { job.controller.abort(new Error(`Session closed: ${reason}`)); }
    }
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([Promise.allSettled([...this.jobs.values()].map(job => job.done)), new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.shutdownMs ?? 15000); })]).finally(() => clearTimeout(timer!));
    for (const job of this.jobs.values()) if (active(job)) {
      job.state = "unresolved"; job.uncertain = true;
      try { this.event(job, { kind: "shutdown_unacknowledged" }); } catch { /* Preserve the in-memory unresolved state. */ }
    }
  }
}
