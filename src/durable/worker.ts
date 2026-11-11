import { BACKGROUND_CONTEXT as context, withAbortSignal, withCancel } from "@earendil-works/chord/context";
import { Harness, ProviderDoc, createRegistry, defineDoc, defineExtension, hook, GenerationTask, CompactionTask, DEFAULT_COMPACTION_POLICY, type CompactionPolicy, type HarnessOptions, type Storage, type TaskId, type ToolRegistration, type ConversationId } from "@earendil-works/pi-durable";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import { digest } from "../config.ts";
import { compactionSchema } from "./compaction.ts";
import { fingerprint, submissionSchema, type StageSpec, type WorkerSubmission, type Workspace } from "./contract.ts";
import { stageActivity, createStageTask } from "./stage.ts";
import { createWorkflowTask } from "./workflow.ts";
import { createPipelineTasks } from "./pipeline.ts";
import { SupervisorDoc } from "./supervisor.ts";
import { claimSchedule } from "./claims.ts";
import { Assessments } from "./assessment.ts";
import { RemoteTask, RemoteSnapshots } from "./remote-task.ts";
import { workerRequest, retainedAssignment, type RemoteWorker } from "./remote.ts";
import { acquireConversation, StageOwner, type StageResources } from "./pool.ts";
import { hasUncertainEffects, preserveEffectUncertainty } from "./effects.ts";
import { acquireScheduleLock } from "../scheduler.ts";
import { waitWithContext } from "./wait.ts";
import fs from "node:fs";
import path from "node:path";
import { JobsDoc, persistAdmission, readAdmissions, readAdmission, resolveAdmission, type Admission } from "./admissions.ts";
import { Decisions } from "./decisions.ts";
import { outcomeProjection } from "./outcome.ts";
export { JobsDoc } from "./admissions.ts";

class SubmissionValidationError extends Error {}
const WorkerConfiguration = defineDoc<{ fingerprint: string | null; compaction?: CompactionPolicy; policyFingerprint?: string | null }>({ kind: "piccolo.worker-configuration", version: 1, scope: "session", initial: () => ({ fingerprint: null }) });
const RejectionsDoc = defineDoc<{ requests: Record<string, { fingerprint: string; error: string }> }>({ kind: "piccolo.rejections", version: 1, scope: "session", initial: () => ({ requests: {} }) });
const LaunchesDoc = defineDoc<{ initialized: boolean; owners: Record<string, number[]> }>({ kind: "piccolo.stage-launches", version: 1, scope: "session", initial: () => ({ initialized: false, owners: {} }) });
const WorkerErrors = defineDoc<{ compaction: string | null }>({ kind: "piccolo.worker-errors", version: 1, scope: "session", initial: () => ({ compaction: null }) });
export { MessagesDoc } from "./messages.ts";
import type { NativePolicy } from "./native-policy.ts";
import { MessagesDoc } from "./messages.ts";
export type WorkerOptions = {
  workspace: Workspace; models: Models; storage: Storage;
  env: NonNullable<HarnessOptions["env"]>; tools: readonly ToolRegistration[];
  capacity?: number; maxJobs?: number;
  resources?: StageResources;
  policy?: NativePolicy;
  compaction?: CompactionPolicy;
  prepareWorktree?: (cwd: string) => Promise<void>;
  instructions?: (cwd: string, spec: StageSpec) => string | Promise<string>;
  validateStage?: (spec: StageSpec) => Promise<void>;
  resume?: boolean;
  dispatchOnly?: boolean;
  reuseStoredCompaction?: boolean;
  legacyCompactions?: CompactionPolicy[];
  maxLaunchesPerOwner?: number;
  cancellationOnly?: boolean;
};

/** One worker owns one Harness. Every returned status is read from a committed task/document. */
export class DurableWorker {
  readonly harness: Harness;
  private options: WorkerOptions;
  private stage: ReturnType<typeof createStageTask>;
  private workflow: ReturnType<typeof createWorkflowTask>;
  private pipeline: ReturnType<typeof createPipelineTasks>["pipelineTask"];
  private closed = false;
  private closing?: Promise<void>;
  private resourceError?: unknown;
  private admissions = new Map<string, Admission>();
  private aborts = new Map<string, Promise<any>>();
  private abortErrors = new Map<string, string>();
  private recoveryPending = false;
  get savedSuspended() { return this.recoveryPending; }
  private compactionError?: string;
  private savedCancellationFault?: string;
  get savedCancellationError() { return this.savedCancellationFault ?? [...this.admissions.values()].find(admission => admission.cancellationError)?.cancellationError; }
  private cancellationRuns = 0;
  get cancellationOnly() { return !!this.options.cancellationOnly; }
  private constructor(harness: Harness, options: WorkerOptions, stage: ReturnType<typeof createStageTask>, workflow: ReturnType<typeof createWorkflowTask>, pipeline: ReturnType<typeof createPipelineTasks>["pipelineTask"]) {
    this.harness = harness; this.options = options; this.stage = stage; this.workflow = workflow; this.pipeline = pipeline;
  }
  static async open(options: WorkerOptions) {
    if (options.cancellationOnly) {
      if (options.policy || options.tools.length) throw new Error("Cancellation-only recovery cannot load executable policy or tools");
      options = { ...options, resume: false, env: () => { throw new Error("Cancellation-only recovery cannot execute an environment"); },
        prepareWorktree: async () => { throw new Error("Cancellation-only recovery cannot prepare worktrees"); },
        instructions: () => { throw new Error("Cancellation-only recovery cannot launch stages"); } };
    }
    let compaction = compactionSchema.parse(options.compaction ?? DEFAULT_COMPACTION_POLICY);
    const admittedRequests = new WeakSet<object>();
    const requestErrors = new WeakMap<object, unknown>();
    const guardedModels: Models = { ...options.models, streamSimple(model, transcript, streamOptions) {
      if (options.cancellationOnly) throw new Error("Cancellation-only recovery cannot execute a model");
      const first = transcript.messages[0];
      if (!first || !admittedRequests.delete(first)) throw (first && requestErrors.get(first)) ?? new Error("Worker request did not pass capacity and policy checks");
      return options.models.streamSimple(model, transcript, streamOptions);
    }, async completeSimple(model, transcript, streamOptions) {
      if (options.cancellationOnly) throw new Error("Cancellation-only recovery cannot compact");
      // Compaction resumes directly in its persisted summarize phase, without
      // beforeCompact. Resolve its persisted public provider identity at the model
      // boundary so the child cannot outrun its parent's capacity reacquisition.
      const ctx = streamOptions?.signal ? withAbortSignal(streamOptions.signal, context) : context;
      if (!streamOptions?.sessionId) throw new Error("Compaction request has no provider identity");
      const live = await harness.inspect(ctx);
      const candidates = new Set(live.tasks.filter(task => task.record.kind === CompactionTask.definition.name).map(task => task.record.conversationId));
      let conversationId: ConversationId | undefined;
      for (const id of candidates) if ((await harness.snapshot(ProviderDoc, id, ctx))?.sessionId === streamOptions.sessionId) {
        if (conversationId !== undefined) throw new Error("Ambiguous compaction provider identity");
        conversationId = id;
      }
      if (conversationId === undefined) throw new Error("Compaction request has no live owned conversation");
      const owner = await harness.snapshot(StageOwner, conversationId, ctx);
      if (!owner?.stageId) throw new Error("Compaction conversation has no persisted capacity owner");
      await options.resources?.acquire(owner.stageId, ctx);
      if (await hasUncertainEffects(harness, conversationId, ctx)) throw new Error("Uncertain tool effect requires reconciliation before compaction");
      return options.models.completeSimple(model, transcript, streamOptions);
    } };
    const registered = options.tools.map(preserveEffectUncertainty).map(tool => options.policy?.wrap(tool) ?? tool).map(tool => ({ ...tool, async execute(args: any, api: Parameters<typeof tool.execute>[1], ctx: Parameters<typeof tool.execute>[2]) {
      await acquireConversation(options.resources, api, ctx);
      return tool.execute(args, api, ctx);
    } }));
    const tools = new Map(registered.map(tool => [tool.name, tool]));
    const stage = createStageTask(async (spec: StageSpec, cwd) => ({
      model: spec.model, thinkingLevel: spec.thinkingLevel, instructions: [await options.instructions?.(cwd, spec), spec.instructions].filter(Boolean).join("\n\n"), cwd,
      tools: [...new Set([...spec.tools, ...(tools.has("ask_parent") ? ["ask_parent"] : [])])].map(name => { const tool = tools.get(name); if (!tool) throw new Error(`Unavailable tool: ${name}`); return tool; }),
    }), options.capacity ?? 8, options.resources, async (id, ctx) => {
      await harness.commit(async tx => {
        const jobs = (await tx.doc(JobsDoc)).requests;
        let current = await tx.task(id as TaskId), admission: Admission | undefined;
        while (current) {
          const matched = Object.entries(jobs).find(([, item]) => item.taskId === current!.id);
          if (matched) admission = await resolveAdmission(tx, matched[0], matched[1]);
          if (admission || !current.owner) break;
          current = await tx.task(current.owner as TaskId);
        }
        if (!admission) throw new Error("Stage has no persisted Job owner; reconcile before launching");
        const launches = await tx.doc(LaunchesDoc), owned = launches.owners[admission.input.owner] ?? [];
        if (owned.includes(id)) return;
        if (owned.length >= (options.maxLaunchesPerOwner ?? 1000)) throw new Error("Session stage launch guideline reached; reconcile possible runaway work");
        launches.owners[admission.input.owner] = [...owned, id];
      }, ctx);
    });
    const registry = createRegistry();
    const workflow = createWorkflowTask(stage, options.prepareWorktree ?? (async () => {}));
    const { pipelineTask, nodeTask } = createPipelineTasks(stage, workflow);
    registry.install(defineExtension({ name: "piccolo-worker", tasks: [stage, workflow, pipelineTask, nodeTask, RemoteTask], tools: registered,
      hooks: [hook(GenerationTask, { async beforeRequest(request, api, ctx) { try { await acquireConversation(options.resources, api, ctx);
          if (await hasUncertainEffects(harness, api.conversationId, ctx)) throw new Error("Uncertain tool effect requires parent reconciliation before continuing");
          const result = await options.policy?.beforeRequest(request.messages, api, ctx) ?? request;
          if (!result.messages.length) throw new Error("Policy produced an empty transcript");
          const messages = [{ ...result.messages[0] }, ...result.messages.slice(1)];
          admittedRequests.add(messages[0]); return { messages };
          } catch (error) { if (request.messages[0]) requestErrors.set(request.messages[0], error); throw error; } } }),
        hook(CompactionTask, { async beforeCompact(compaction, api, ctx) {
          try { await acquireConversation(options.resources, api, ctx); await options.policy?.beforeCompact(compaction, api, ctx); }
          catch (error) {
            worker.compactionError = String(error).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 1000);
            await harness.commit(async tx => { (await tx.doc(WorkerErrors)).compaction = worker.compactionError!; }, ctx);
            return { decline: true as const };
          }
          if (worker.compactionError) {
            await harness.commit(async tx => { (await tx.doc(WorkerErrors)).compaction = null; }, ctx);
            worker.compactionError = undefined;
          }
          return undefined;
        } })] }));
    const harness = await Harness.open(options.storage, { registry, models: guardedModels, env: options.env, settings: { get compaction() { return compaction; } } }, context);
    options.policy?.bind(harness);
    try {
      await harness.root(context);
      await harness.commit(async tx => {
        const doc = await tx.doc(WorkerConfiguration);
        if (options.cancellationOnly) {
          if (doc.compaction) compaction = compactionSchema.parse(doc.compaction);
          return; // Retain original identity; cancellation does not authorize a policy migration.
        }
        const policy = options.policy?.fingerprint ?? null;
        if (doc.fingerprint && doc.fingerprint !== digest({ compaction, policy })) {
          const candidates = options.reuseStoredCompaction ? [doc.compaction, ...(options.legacyCompactions ?? [])].filter(Boolean) : [];
          const original = candidates.find(candidate => doc.fingerprint === digest({ compaction: candidate, policy }));
          if (!original) throw new Error("Worker policy changed; use the original configuration to resume or reconcile the existing work");
          compaction = compactionSchema.parse(original);
        }
        doc.fingerprint = digest({ compaction, policy }); doc.compaction = compaction; doc.policyFingerprint = policy;
      }, context);
      await harness.commit(async tx => {
        if (!options.cancellationOnly) {
          for (const [id, admission] of Object.entries((await tx.doc(JobsDoc)).requests))
            if (admission.input) await persistAdmission(tx, id, admission as Admission);
        }
        const launches = await tx.doc(LaunchesDoc);
        if (launches.initialized) return;
        const admissions = (await tx.doc(JobsDoc)).requests;
        let cursor;
        do {
          const page = await tx.scanTasks({ kind: "piccolo.stage" }, 1000, cursor);
          for (const stage of page.items) {
            let current = stage, owner: string | undefined;
            while (current) {
              const admission = Object.entries(admissions).find(([, item]) => item.taskId === current.id);
              if (admission) { owner = (await resolveAdmission(tx, admission[0], admission[1])).input.owner; break; }
              if (!current.owner) break;
              const parent = await tx.task(current.owner as TaskId); if (!parent) break; current = parent;
            }
            if (owner) launches.owners[owner] = [...(launches.owners[owner] ?? []), stage.id];
          }
          cursor = page.next;
        } while (cursor);
        launches.initialized = true;
      }, context);
    } catch (error) { await harness.close(context); throw error; }
    options = { ...options, compaction };
    const worker = new DurableWorker(harness, options, stage, workflow, pipelineTask);
    if (options.cancellationOnly) worker.recoveryPending = true;
    try {
    worker.compactionError = (await harness.snapshot(WorkerErrors, context))?.compaction ?? undefined;
    for (const [id, admission] of Object.entries(await readAdmissions(harness, context))) worker.admissions.set(id, JSON.parse(JSON.stringify(admission)));
    for (const admission of worker.admissions.values()) {
      const live = (await harness.getTask(admission.taskId as TaskId, context))?.state.status !== "terminal";
      // A crash can fall between the Job intent commit and the task abort mark.
      // Reconcile that intent before either automatic or explicit scheduling.
      if (admission.cancellationRequested && live) await harness.abortTask(admission.taskId as TaskId, context);
      if (options.resume === false && live) worker.recoveryPending = true;
      if (!options.cancellationOnly && options.dispatchOnly && !admission.input.placement && live) throw new Error("Dispatch-only recovery cannot run saved local tasks without their original policy");
    } } catch (error) { await worker.close("suspend"); throw error; }
    harness.subscribeCommits(publication => {
      for (const change of publication.changes) if (change.type === "task" && change.value.kind === "piccolo.stage" && change.value.state.status === "terminal") {
        try { options.resources?.release(change.value.id); } catch (error) { worker.resourceError = error; }
        options.policy?.releaseStage(change.value.id);
      }
    });
    // Independent work resumes. Session work is explicitly cancelled by its host's lifecycle.
    if (options.resume !== false) harness.resume();
    return worker;
  }
  async submit(value: unknown) {
    if (this.options.cancellationOnly) throw new Error("Cancellation-only recovery cannot submit work");
    if (this.recoveryPending) throw new Error("Saved Jobs are suspended; explicitly resume or cancel them before submitting new work");
    const input = submissionSchema.parse(value);
    try { return await this.admit(input); }
    catch (error) {
      // A durable negative receipt excludes later admission of this request ID.
      // An unreadable/failed store cannot establish definite absence.
      if (error instanceof SubmissionValidationError && digest(input.workspace) === digest(this.options.workspace)) try {
        await this.harness.commit(async tx => {
          if ((await tx.doc(JobsDoc)).requests[input.requestId]) return;
          const doc = await tx.doc(RejectionsDoc);
          if (Object.keys(doc.requests).length >= 10000 && !doc.requests[input.requestId]) throw new Error("Rejection history limit reached");
          doc.requests[input.requestId] ??= { fingerprint: fingerprint(input), error: String(error).slice(0, 1000) };
        }, context);
      } catch { /* Preserve uncertainty when a negative receipt cannot commit. */ }
      throw error;
    }
  }
  async rejection(requestId: string) {
    const receipt = (await this.harness.snapshot(RejectionsDoc, context))?.requests[requestId];
    return receipt ? { state: "rejected" as const, requestId, fingerprint: receipt.fingerprint, error: receipt.error } : undefined;
  }
  private async admit(input: WorkerSubmission) {
    if (this.closed) throw new Error("Worker is closed");
    if (this.resourceError) throw new Error(`Worker capacity requires reconciliation: ${String(this.resourceError)}`);
    if (this.options.dispatchOnly && !input.placement) throw new Error("This controller has no local worker policy. Configure PICCOLO_WORKER_POLICY and start a new session for local execution.");
    if (input.kind === "delegate" && input.cwd && !input.placement &&
      (fs.realpathSync(input.cwd) !== input.cwd || (input.cwd !== this.options.workspace.cwd && !input.cwd.startsWith(this.options.workspace.cwd + path.sep)))) throw new Error("Delegate cwd must be canonical and inside its assigned workspace");
    if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) throw new SubmissionValidationError("Worker submission exceeds 8 MiB; compact captured context");
    if (JSON.stringify(input.workspace) !== JSON.stringify(this.options.workspace)) throw new SubmissionValidationError("Workspace identity mismatch");
    const existing = this.admissions.get(input.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint(input)) throw new Error("Request ID reused with different input");
      this.admissions.set(input.requestId, JSON.parse(JSON.stringify(existing)));
      this.harness.resume();
      return existing;
    }
    const rejected = await this.rejection(input.requestId);
    if (rejected) throw new Error(`Request was rejected before admission: ${rejected.error}. Submit a new request identity after resolving it.`);
    const available = new Set(this.options.tools.map(tool => tool.name));
    const specs = input.kind === "delegate" ? [input.stage] : input.kind === "workflow" ? Object.values(input.workflow.stages).flat() :
      Object.values(input.pipeline.nodes).flatMap(node => node.work.kind === "delegate" ? [node.work.stage] : Object.values(node.work.workflow.stages).flat());
    for (const spec of input.placement ? [] : specs) {
      await this.options.validateStage?.(spec);
      for (const name of spec.tools) if (!available.has(name)) throw new SubmissionValidationError(`Unavailable worker tool: ${name}`);
      const model = this.options.models.getModel(spec.model.provider, spec.model.modelId);
      if (!model) throw new SubmissionValidationError("Model unavailable on worker");
      if (!getSupportedThinkingLevels(model).includes(spec.thinkingLevel)) throw new SubmissionValidationError("Requested thinking level is unavailable on worker");
      if (spec.requirements?.host && !["local", this.options.workspace.host].includes(spec.requirements.host)) throw new Error("Worker host does not satisfy the agent requirement");
      if (spec.requirements?.platform && spec.requirements.platform !== process.platform) throw new Error("Worker platform does not satisfy the agent requirement");
      for (const input of spec.requirements?.input ?? []) if (!model.input.includes(input)) throw new Error(`Worker model does not support required ${input} input`);
      if (!model.input.includes("image") && spec.context?.some(message => typeof message === "object" && message && !Array.isArray(message) &&
        Array.isArray(message.content) && message.content.some(part => part && typeof part === "object" && !Array.isArray(part) && part.type === "image"))) throw new Error("Worker model does not support captured image input");
    }
    const executionRoot = input.placement?.workspace.cwd ?? this.options.workspace.cwd;
    if (input.kind === "workflow" && input.workflow.root !== executionRoot) throw new SubmissionValidationError("Workflow root differs from worker workspace");
    if (input.kind === "schedule" || input.kind === "experiment") {
      if (input.pipeline.source.root !== executionRoot || Object.values(input.pipeline.nodes).some(node =>
        (node.work.kind === "workflow" ? node.work.workflow.root : node.work.root) !== executionRoot)) throw new Error("Pipeline root differs from worker workspace");
    }
    const root = await this.harness.root(context);
    const remoteSubmission = { ...input, workspace: input.placement?.workspace ?? input.workspace };
    delete remoteSubmission.placement;
    const lockController = new AbortController();
    const releaseClaimsLock = input.kind === "schedule" ? await acquireScheduleLock(this.options.workspace.cwd, lockController) : undefined;
    let claims: ReturnType<typeof claimSchedule> | undefined;
    try {
    const admission = await this.harness.commit(async tx => {
      const doc = await tx.doc(JobsDoc);
      const existing = doc.requests[input.requestId];
      if (existing) {
        if (existing.fingerprint !== fingerprint(input)) throw new Error("Request ID reused with different input");
        return resolveAdmission(tx, input.requestId, existing);
      }
      if ((await tx.doc(RejectionsDoc)).requests[input.requestId]) throw new Error("Request was rejected before admission; use a new identity after reconciliation");
      if (await this.unreviewedAdmissions(tx, input.owner) >= (this.options.maxJobs ?? 1000)) throw new Error("Session job admission budget reached; inspect and acknowledge completed Jobs");
      if (Object.keys(doc.requests).length >= 10000) throw new Error("Worker admission history safety limit reached; reconcile and retain this store before starting a new owned store");
      if (lockController.signal.aborted) throw new Error("Schedule coordinator lock lost during admission");
      claims = claimSchedule(this.options.workspace.cwd, input);
      const options = { ownership: { kind: "conversation" as const }, conversationId: root.id };
      const taskId = input.placement ? await tx.createTask(RemoteTask, { root: this.options.workspace.cwd, target: input.placement,
        submission: remoteSubmission }, options) : input.kind === "delegate"
        ? await tx.createTask(this.stage, { spec: input.stage, cwd: input.cwd ?? input.workspace.cwd }, options)
        : input.kind === "workflow" ? await tx.createTask(this.workflow, input.workflow, options) : await tx.createTask(this.pipeline, input.pipeline, options);
      const admission = { taskId, fingerprint: fingerprint(input), input };
      await persistAdmission(tx, input.requestId, admission);
      return admission;
    }, context);
    this.harness.resume();
    this.admissions.set(input.requestId, JSON.parse(JSON.stringify(admission)));
    return admission;
    } catch (error) {
      let absent = false;
      try {
        const persisted = (await this.harness.snapshot(JobsDoc, context))?.requests[input.requestId];
        absent = !persisted;
        if (persisted) this.admissions.set(input.requestId, (await readAdmission(this.harness, input.requestId, context))!);
      } catch { /* A failed store cannot prove whether admission committed. */ }
      if (absent && claims) try { claims.rollback(); }
      catch (rollback) { throw new AggregateError([error, rollback], "Schedule admission failed and its new claims need reconciliation"); }
      throw error;
    }
    finally { await releaseClaimsLock?.(); }
  }
  async admission(requestId: string) {
    const admission = await readAdmission(this.harness, requestId, context);
    if (!admission) throw new Error("Unknown worker request");
    return admission;
  }
  private async unreviewedAdmissions(tx: import("@earendil-works/pi-durable").Tx, owner: string) {
    const decisions = (await tx.doc(Decisions)).decisions;
    let count = 0;
    for (const [id, stored] of Object.entries((await tx.doc(JobsDoc)).requests)) {
      const admission = await resolveAdmission(tx, id, stored);
      if (admission.input.owner !== owner) continue;
      const task = await tx.task(admission.taskId as TaskId);
      const revision = task?.state.status === "terminal" ? outcomeProjection(task.state.outcome, undefined, admission.cancellationError).revision : undefined;
      if (!revision || decisions[id]?.revision !== revision) count++;
    }
    return count;
  }
  /** Attach a disposable controller to independently owned remote work. Its
   * original submission is inspected, never submitted under a new owner.
   */
  async attach(value: unknown, target: RemoteWorker, owner: string) {
    if (this.cancellationOnly) throw new Error("Cancellation-only recovery cannot attach work");
    if (this.recoveryPending) throw new Error("Saved Jobs are suspended; explicitly resume or cancel them before attaching work");
    if (this.closed) throw new Error("Worker is closed");
    const original = submissionSchema.parse(value);
    if (original.lifetime !== "independent" || digest(original.workspace) !== digest(target.workspace) || original.placement) throw new Error("Attach requires the original independent remote submission");
    if (digest(retainedAssignment(this.options.workspace.cwd, target, original.requestId).submission) !== digest(original)) throw new Error("Attach differs from the original retained submission");
    const input: WorkerSubmission = { ...original, owner, workspace: this.options.workspace, placement: target };
    const root = await this.harness.root(context);
    const admission = await this.harness.commit(async tx => {
      const doc = await tx.doc(JobsDoc), prior = doc.requests[input.requestId];
      if (prior) {
        if (prior.fingerprint !== fingerprint(input)) throw new Error("Job is already attached with different inputs or assignment");
        return resolveAdmission(tx, input.requestId, prior);
      }
      if (await this.unreviewedAdmissions(tx, owner) >= (this.options.maxJobs ?? 1000)) throw new Error("Session job admission budget reached; inspect and acknowledge completed Jobs");
      const taskId = await tx.createTask(RemoteTask, { root: this.options.workspace.cwd, target, submission: original, observe: true },
        { ownership: { kind: "conversation" }, conversationId: root.id });
      const admission = { taskId, fingerprint: fingerprint(input), input, originOwner: original.owner };
      await persistAdmission(tx, input.requestId, admission); return JSON.parse(JSON.stringify(admission)) as Admission;
    }, context);
    this.admissions.set(input.requestId, JSON.parse(JSON.stringify(admission)));
    this.harness.resume(); return admission;
  }
  capabilities() {
    return { capacity: this.options.capacity ?? 8, tools: this.options.tools.map(tool => tool.name),
      nativeExtensionHooks: optionsPolicy(this.options.policy), compaction: "pi-durable", compactionPolicy: this.options.compaction,
      workerContract: 2, submissionFeatures: ["delegate-cwd", "job-origin", "pipeline-timeout", "admission-rejection-receipt"],
      storage: "single-owner", lifetimes: ["session", "independent"], resourceError: this.resourceError ? String(this.resourceError) : null, compactionError: this.compactionError ?? null };
  }
  async inspect(requestId: string) {
    const admission = await this.admission(requestId);
    return { ...admission, task: await this.harness.getTask(admission.taskId as TaskId, context) };
  }
  /** Wire projection excludes frozen prompts and model transcripts. */
  async status(requestId: string) {
    const { task, taskId, fingerprint } = await this.inspect(requestId);
    const records = (await this.harness.inspect(context)).tasks.map(item => item.record);
    const descendants = new Set<number>([taskId]);
    let added = true;
    while (added) { added = false; for (const child of records) if (child.owner && descendants.has(child.owner) && !descendants.has(child.id)) { descendants.add(child.id); added = true; } }
    const stages = records.filter(child => descendants.has(child.id) && child.kind === "piccolo.stage");
    const attention = Object.entries((await this.harness.snapshot(SupervisorDoc, context))?.requests ?? {}).flatMap(([id, question]) => {
      const stage = stages.find(child => "checkpoint" in child.state && (child.state.checkpoint as any)?.conversationId === question.conversationId);
      return stage && question.answer === null ? [{ id, question: question.question, stage: String(stage.id) }] : [];
    });
    const messages = [];
    for (const [id, message] of Object.entries((await this.harness.snapshot(MessagesDoc, context))?.messages ?? {})) {
      if (message.requestId !== requestId) continue;
      const receipt = message.submissionId ? await (await this.harness.submission(message.submissionId as any, context))?.status(context) : undefined;
      const decision = message.supervisorId ? await this.harness.getTask(Number(message.supervisorId) as any, context) : undefined;
      const queued = message.queuedStageId ? await this.harness.getTask(message.queuedStageId as any, context) : undefined;
        const delivered = receipt?.status === "done" || decision?.state.status === "terminal" || (queued?.state.status === "terminal" && queued.state.outcome.status === "completed");
      messages.push({ id, target: message.target ?? undefined, state: delivered ? "delivered" : receipt?.status === "unanswered" ? "rejected" : message.queuedStageId && !message.conversationId ? "queued" : "routed",
        ...(delivered ? { observation: "durable_input_answered; action_not_verified" } : {}) });
    }
    const assessments = (await this.harness.snapshot(Assessments, context))?.requests[requestId] ?? {};
    return { taskId, fingerprint, assessments, task: task ? { id: task.id, state: task.state.status === "terminal" ? task.state : { status: task.state.status }, abortRequested: task.abortRequested } : null,
      children: stages.map(child => ({ id: String(child.id), target: String(child.id), target_truncated: false, coordinator: true, attached: true,
        phase: stageActivity(child) })), attention, messages };
  }
  async wait(requestId: string, waitContext = context) {
    if (this.cancellationOnly && this.recoveryPending) throw new Error(this.savedCancellationError ? "Saved cancellation marks failed. Repair storage and retry cancel_saved before waiting." : "Start saved cancellation before waiting on its outcome");
    if (this.recoveryPending) throw new Error("Saved Jobs are suspended; waiting cannot resume them without a recovery decision");
    return this.harness.waitForTask((await this.admission(requestId)).taskId as TaskId, waitContext);
  }
  async message(requestId: string, messageId: string, text: string, target?: string): Promise<number> {
    if (this.cancellationOnly) throw new Error("Cancellation-only recovery cannot send instructions");
    if (!text.trim() || text.length > 16000) throw new Error("Instruction must contain 1..16000 characters");
    const assignment = (await this.admission(requestId)).input.placement;
    if (assignment) return workerRequest(assignment, { operation: "message", requestId, messageId, text, ...(target ? { target } : {}) });
    const prior = (await this.harness.snapshot(MessagesDoc, context))?.messages[messageId];
    if (prior) {
      if (prior.requestId !== requestId || prior.text !== text || prior.target !== (target ?? null)) throw new Error("Message ID reused with different input");
      if (prior.supervisorId) return Number(prior.supervisorId);
      if (prior.submissionId) return prior.submissionId;
      if (prior.queuedStageId) return prior.queuedStageId;
      const conversation = (await this.harness.conversation(prior.conversationId as ConversationId, context))!;
      const submitted = await conversation.submit({ type: "input", requestId: `message:${messageId}`, content: text, whenBusy: "steer" }, context);
      await this.harness.commit(async tx => { (await tx.doc(MessagesDoc)).messages[messageId].submissionId = submitted.id; }, context);
      return submitted.id;
    }
    const { task } = await this.inspect(requestId);
    if (!task || task.state.status === "terminal" || task.state.status === "completing") throw new Error("Stage has finished");
    const records = (await this.harness.inspect(context)).tasks.map(item => item.record);
    const descendants = new Set<number>([task.id]);
    let added = true;
    while (added) { added = false; for (const child of records) if (child.owner && descendants.has(child.owner) && !descendants.has(child.id)) { descendants.add(child.id); added = true; } }
    const stages = records.filter(record => record.kind === "piccolo.stage" && descendants.has(record.id) && record.state.status !== "terminal" && record.state.status !== "completing" && (!target || String(record.id) === target));
    if (stages.length !== 1) throw new Error("Select exactly one active stage from job status");
    const selected = stages[0];
    if (selected.state.status === "terminal" || selected.state.status === "completing") throw new Error("Stage is finishing");
    const checkpoint = selected.state.checkpoint as { conversationId?: ConversationId };
    if (!checkpoint.conversationId) {
      await this.harness.commit(async tx => {
        const current = await tx.task(selected.id);
        if (!current || current.state.status === "terminal" || ("checkpoint" in current.state && (current.state.checkpoint as any)?.conversationId)) throw new Error("Stage changed during routing; retry the same message ID");
        const messages = await tx.doc(MessagesDoc), prior = messages.messages[messageId];
        if (prior) {
          if (prior.requestId !== requestId || prior.text !== text || prior.target !== (target ?? null)) throw new Error("Message ID reused with different input");
          return;
        }
        if (Object.values(messages.messages).filter(message => message.requestId === requestId).length >= 1000) throw new Error("Job instruction budget reached");
        messages.messages[messageId] = { requestId, text, target: target ?? null, conversationId: 0, submissionId: null, queuedStageId: selected.id };
      }, context);
      return selected.id;
    }
    const questions = Object.entries((await this.harness.snapshot(SupervisorDoc, context))?.requests ?? {})
      .filter(([, request]) => request.conversationId === checkpoint.conversationId && request.answer === null);
    if (questions.length) {
      if (questions.length !== 1) throw new Error("Multiple parent questions require an explicit supervisor decision");
      await this.harness.commit(async tx => {
        const messages = await tx.doc(MessagesDoc), prior = messages.messages[messageId];
        if (prior) {
          if (prior.requestId !== requestId || prior.text !== text || prior.target !== (target ?? null)) throw new Error("Message ID reused with different input");
          return;
        }
        const request = (await tx.doc(SupervisorDoc)).requests[questions[0][0]];
        if (request.answer !== null && request.answer !== text) throw new Error("Parent decision already recorded");
        request.answer = text;
        messages.messages[messageId] = { requestId, text, target: target ?? null, conversationId: checkpoint.conversationId!, submissionId: null, supervisorId: questions[0][0] };
      }, context);
      return Number(questions[0][0]);
    }
    await this.harness.commit(async tx => {
      const doc = await tx.doc(MessagesDoc);
      const existing = doc.messages[messageId];
      if (existing) {
        if (existing.requestId !== requestId || existing.text !== text || existing.target !== (target ?? null)) throw new Error("Message ID reused with different input");
        return;
      }
      if (Object.values(doc.messages).filter(message => message.requestId === requestId).length >= 1000) throw new Error("Job instruction budget reached");
      doc.messages[messageId] = { requestId, text, target: target ?? null, conversationId: checkpoint.conversationId!, submissionId: null };
    }, context);
    return this.message(requestId, messageId, text, target);
  }
  async abort(requestId: string, waitContext = context) {
    const admission = this.admissions.get(requestId);
    if (!admission) throw new Error("Unknown worker request");
    let operation = this.aborts.get(requestId);
    if (!operation) {
      // Enqueue the durable mark before yielding. Its context is independent of
      // any caller's wait deadline; cached task IDs are immutable admission data.
      operation = this.harness.abortTask(admission.taskId as TaskId, context).then(async () => {
        let controlled = admission;
        const old = await this.harness.getTask(admission.taskId as TaskId, context);
        // Adoption needs native scheduling. An individual stop does not authorize
        // running the rest of a suspended generation; keep the saved receipt for
        // explicit resumeSaved/cancelSaved instead.
        if (!this.recoveryPending && admission.input.placement && await this.adoptVerifiedOutcome(requestId, old)) {
          controlled = this.admissions.get(requestId)!;
          this.harness.resume();
          return this.harness.waitForTask(controlled.taskId as TaskId, context);
        }
        if (admission.input.placement && await this.recoverableController(requestId, old, true)) {
          controlled = await this.replaceRemoteController(requestId, old, true);
          await this.harness.abortTask(controlled.taskId as TaskId, context);
        } else if (old?.state.status === "terminal") return old;
        if (this.recoveryPending) {
          if (controlled.input.placement) await workerRequest(controlled.input.placement, { operation: "abort", requestId });
          return this.harness.getTask(controlled.taskId as TaskId, context);
        }
        return this.harness.waitForTask(controlled.taskId as TaskId, context);
      }).then(async task => { if (task) await this.clearCancellationError(requestId, task.id); return task; }).catch(async error => {
        try { await this.recordCancellationError(requestId, error); }
        catch (recording) { throw new AggregateError([error, recording], "Cancellation failed and its error could not be recorded; reconcile the saved Job"); }
        throw error;
      });
      this.aborts.set(requestId, operation);
      operation.then(() => { this.aborts.delete(requestId); this.abortErrors.delete(requestId); }, error => { this.aborts.delete(requestId); this.abortErrors.set(requestId, String(error).slice(0, 1000)); });
    }
    return waitWithContext(operation, waitContext);
  }
  stopping(requestId: string) { return this.aborts.has(requestId); }
  abortError(requestId: string) { return this.abortErrors.get(requestId); }
  async cancellationInProgress() {
    if (this.cancellationRuns || this.aborts.size) return true;
    for (const admission of this.admissions.values()) {
      const task = await this.harness.getTask(admission.taskId as TaskId, context);
      if (task?.abortRequested && task.state.status !== "terminal") return true;
    }
    return false;
  }
  private async recordCancellationError(id: string, error: unknown) {
    const value = await this.harness.commit(async tx => {
      const admission = (await tx.doc(JobsDoc)).requests[id];
      admission.cancellationRequested = true; admission.cancellationError = String(error).slice(0, 1000);
      return resolveAdmission(tx, id, admission);
    }, context);
    this.admissions.set(id, value);
  }
  private async clearCancellationError(id: string, taskId: number) {
    const value = await this.harness.commit(async tx => {
      const admission = (await tx.doc(JobsDoc)).requests[id];
      if (!admission || admission.taskId !== taskId || !admission.cancellationError) return;
      const task = await tx.task(taskId as TaskId);
      if (!task || task.state.status !== "terminal" || (task.state.outcome as any).result?.status === "unresolved") return;
      delete admission.cancellationError;
      return resolveAdmission(tx, id, admission);
    }, context);
    if (value) this.admissions.set(id, value);
  }
  private async recoverableController(id: string, task: any, cancel = false) {
    if (task?.kind !== "piccolo.remote" || task.state.status !== "terminal") return false;
    const outcome = task.state.outcome;
    if (!["failed", "faulted"].includes(outcome.status) || outcome.result?.status === "rejected") return false;
    // Watch commits the verified remote snapshot before copying its outcome.
    // Cancellation must preserve that terminal result, including remote faults.
    const verified = (await this.harness.snapshot(RemoteSnapshots, context))?.requests[id]?.task?.state;
    if (verified?.status === "terminal" && (cancel || digest(verified.outcome) === digest(outcome))) return false;
    // Older dispatchers used a plain failed outcome even after possible remote
    // admission. An unclassified failure is not proof that the original Job ended.
    return true;
  }
  private async adoptVerifiedOutcome(id: string, old: any) {
    if (old?.kind !== "piccolo.remote" || old.state.status !== "terminal") return false;
    const root = await this.harness.root(context);
    const adopted = await this.harness.commit(async tx => {
      const doc = await tx.doc(JobsDoc), current = doc.requests[id];
      const verified = (await tx.doc(RemoteSnapshots)).requests[id]?.task?.state;
      if (!current || current.taskId !== old.id || verified?.status !== "terminal" || digest(verified.outcome) === digest(old.state.outcome)) return;
      const taskId = await tx.createTask(RemoteTask, { ...old.input, observe: true, verifiedOutcome: verified.outcome }, { ownership: { kind: "conversation" }, conversationId: root.id });
      const value = { ...current, taskId, previousControllers: [...(current.previousControllers ?? []), old.id] };
      delete value.cancellationError; doc.requests[id] = value;
      return resolveAdmission(tx, id, value);
    }, context);
    if (adopted) this.admissions.set(id, adopted);
    return !!adopted;
  }
  private async replaceRemoteController(id: string, old: any, cancel = false) {
    const input = old.input;
    const admission = this.admissions.get(id)!;
    if (digest(input.target) !== digest(admission.input.placement) || digest(retainedAssignment(this.options.workspace.cwd, input.target, id).submission) !== digest(input.submission)) {
      throw new Error("Original remote assignment changed; reconcile before controlling saved work");
    }
    const root = await this.harness.root(context);
    const repaired = await this.harness.commit(async tx => {
      const doc = await tx.doc(JobsDoc), current = doc.requests[id];
      if (cancel) current.cancellationRequested = true;
      delete current.cancellationError;
      if (current.taskId !== old.id) return resolveAdmission(tx, id, current);
      const mustCancel = !!current.cancellationRequested || !!input.cancel;
      const taskId = await tx.createTask(RemoteTask, { ...input, observe: true, cancel: mustCancel,
        priorFailure: input.priorFailure ?? String(old.state.outcome.error?.message ?? "Legacy controller failure").slice(0, 1000) }, { ownership: { kind: "conversation" }, conversationId: root.id });
      const value = { ...JSON.parse(JSON.stringify(current)), taskId, ...(mustCancel ? { cancellationRequested: true } : {}), previousControllers: [...(current.previousControllers ?? []), old.id] };
      doc.requests[id] = value; return resolveAdmission(tx, id, value);
    }, context);
    this.admissions.set(id, repaired);
    // A simultaneous restore may have won replacement. Cancellation belongs to
    // the logical Job and follows that winner, independent of the caller's wait.
    if (repaired.cancellationRequested) await this.harness.abortTask(repaired.taskId as TaskId, context);
    return repaired;
  }
  async resumeSaved() {
    if (this.options.cancellationOnly) throw new Error("Cancellation-only recovery cannot resume work; restore the original policy or start a new session");
    for (const [id, admission] of this.admissions) {
      if (!admission.input.placement) continue;
      const old = await this.harness.getTask(admission.taskId as TaskId, context);
      if (await this.adoptVerifiedOutcome(id, old)) continue;
      if (!old || !await this.recoverableController(id, old)) continue;
      const input = old.input as any;
      try {
        if (digest(input.target) !== digest(admission.input.placement) || digest(retainedAssignment(this.options.workspace.cwd, input.target, id).submission) !== digest(input.submission)) continue;
        const status = await workerRequest(input.target, { operation: "inspect", requestId: id }, undefined, 3000);
        if (!status.task || status.fingerprint !== digest(input.submission)) continue;
        if (old.abortRequested && status.task.state.status !== "terminal") await workerRequest(input.target, { operation: "abort", requestId: id }, undefined, 3000);
        await this.replaceRemoteController(id, old, !!old.abortRequested);
      } catch { /* An unavailable original worker stays unresolved; no new assignment or agent execution. */ }
    }
    this.recoveryPending = false; this.harness.resume();
  }
  async cancelSaved(owner: string, waitContext = context) {
    if (this.options.cancellationOnly && [...this.admissions.values()].some(admission => admission.input.owner !== owner)) throw new Error("Cancellation-only recovery requires a store belonging entirely to this parent session");
    const requests = [...this.admissions].filter(([, admission]) => admission.input.owner === owner);
    const failed = new Set<string>();
    this.cancellationRuns++;
    // Persist every root mark before enabling scheduling; no unselected saved
    // generation, workflow preparation or remote dispatch can start between them.
    const marks = requests.map(([id, admission]) => this.harness.abortTask(admission.taskId as TaskId, context).catch(async error => {
      try { await this.recordCancellationError(id, error); }
      catch (recording) { throw new AggregateError([error, recording], "Cancellation mark failed and its error could not be recorded; saved work remains suspended"); }
      throw error;
    }));
    const operation = Promise.all(marks).then(async () => {
      for (const [id, admission] of requests) {
        if (failed.has(id) || !admission.input.placement) continue;
        try {
          const old = await this.harness.getTask(admission.taskId as TaskId, context);
          if (await this.adoptVerifiedOutcome(id, old)) continue;
          if (await this.recoverableController(id, old, true)) {
            // One unavailable assignment must not stop other committed marks.
            await this.replaceRemoteController(id, old, true);
          }
        } catch (error) { failed.add(id); await this.recordCancellationError(id, error); }
      }
      this.recoveryPending = false; this.harness.resume();
      return Promise.all(requests.filter(([id]) => !failed.has(id)).map(async ([id]) => {
        const task = await this.harness.waitForTask(this.admissions.get(id)!.taskId as TaskId, context);
        await this.clearCancellationError(id, task.id); return task;
      }));
    });
    operation.then(() => { this.cancellationRuns--; this.savedCancellationFault = undefined; }, error => { this.cancellationRuns--; this.savedCancellationFault = String(error).slice(0, 1000); });
    return waitWithContext(operation, waitContext);
  }
  async close(mode: "suspend" | "cancel-session", owner?: string, shutdownMs = 15000) {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const wait = withCancel(context);
      const timer = setTimeout(() => wait.cancel(new Error("Session shutdown deadline exceeded; persisted aborts require reconciliation")), shutdownMs);
      try {
        if (mode === "cancel-session") {
          const outcomes = await Promise.allSettled([...this.admissions].filter(([, value]) => value.input.lifetime === "session" && value.input.owner === owner)
            .map(([id]) => this.abort(id, wait.context)));
          const failed = outcomes.find(outcome => outcome.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        }
      } finally { clearTimeout(timer); wait.cancel(); try { await this.harness.close(context); } finally { try { await this.options.policy?.close(); } finally { this.options.resources?.close(); } } }
    })();
    return this.closing;
  }
}

function optionsPolicy(policy?: NativePolicy) { return policy?.capabilities() ?? false; }
