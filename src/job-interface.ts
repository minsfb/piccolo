import { DurableJobs } from "./durable/jobs.ts";
import { localJobs } from "./durable/local.ts";
import { prepareSubmission } from "./durable/prepare.ts";
import { workerRequest, retainedAssignment, type RemoteWorker } from "./durable/remote.ts";
import type { Workspace } from "./durable/contract.ts";
import { compactTool, jobNoticeRenderer } from "./display.ts";
import { showJobDetail, detailTruncated } from "./job-detail-view.ts";
import { showJobList } from "./job-list-view.ts";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { SessionJobs, type JobExecution, type JobKind } from "./session-jobs.ts";
import { projectRoot } from "./records.ts";
import { loadConfig, type Config } from "./config.ts";
import { discoverJobs, probeJobs, type RecoveryInventory } from "./durable/recovery.ts";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { WorkerWaitCancelled } from "./durable/wait.ts";
import { setRecoveryNotice } from "./durable/recovery-notices.ts";
import { subagentsPublicExport } from "./runtime.ts";
import { readAdmissions } from "./durable/admissions.ts";

type Prepared = { target?: RemoteWorker; snapshot: unknown; settings: Config["background"]; execute: (execution: JobExecution) => Promise<unknown> };
const response = (value: unknown) => {
  if (JSON.stringify(value).length > 16000) value = { truncated: true, id: (value as any)?.id ?? (value as any)?.job_id, job_id: (value as any)?.job_id,
    record: (value as any)?.record ?? ".piccolo/jobs", note: "Use status to obtain outcome_revision, then result_page with that revision and offset=0; follow next_offset until null before ack. Pointer-only output is not an inspection." };
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
};
const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 200);

export async function registerJobs(pi: ExtensionAPI, schemas: Record<JobKind, TSchema>, prepare: (kind: JobKind, params: any, ctx: ExtensionToolContext, host?: string) => Prepared, settingsFor = (ctx: ExtensionContext) => loadConfig(projectRoot(ctx.cwd)).config) {
  pi.registerMessageRenderer("piccolo-jobs", jobNoticeRenderer);
  const register = <T extends TSchema>(tool: import("@earendil-works/pi-coding-agent").ToolDefinition<T>) => pi.registerTool(compactTool(tool));
  let owner: SessionJobs | DurableJobs | undefined;
  let workspace: Workspace | undefined;
  let creating: Promise<void> | undefined;
  let unregister: (() => void) | undefined;
  const entry = subagentsPublicExport(process.cwd(), "background-work");
  const native = entry ? await import(pathToFileURL(entry).href) : undefined;
  const notifications = new Map<string, "follow_up" | "notify_only">();
  const foregroundIds = new Set<string>();
  let uiContext: ExtensionContext | undefined;
  let recovery: RecoveryInventory | undefined;
  let suspendOnShutdown = false;
  let rpcRestorePrompt = false;
  // Pi 0.85.1 considers prompt preflight idle. A triggering custom message can
  // steal that prompt's run. Only the native run boundary establishes that
  // followUp will queue; idle/preflight completions must wait for a user turn.
  let parentRunActive = false;
  const redraw = () => {
    pi.events.emit("piccolo:jobs:changed:v1", {});
    if (!uiContext?.hasUI) return;
    const jobs = owner?.list(0, 10000) ?? [];
    const running = jobs.filter(j => j.state === "running").length;
    const queued = jobs.filter(j => j.state === "queued").length;
    const attention = jobs.filter(j => ((j as { attention_total?: number }).attention_total ?? 0) > 0 || (["needs_parent", "unresolved", "cancelled"].includes(j.state) && j.parent_review.disposition === "pending")).length;
    const review = jobs.filter(j => j.state === "completed" && j.parent_review.disposition === "pending").length;
    uiContext.ui.setStatus("piccolo-jobs", jobs.length ? `jobs ${running} active · ${queued} queued · ${review} await review · ${attention} need parent | /piccolo-jobs` : undefined);
  };
  const manager = async (ctx: ExtensionToolContext, settings?: Config["background"], pool?: Config["pool"], restore = false, dispatchOnly = false, integration?: Config["integration"], cancellationOnly = false) => {
    if (creating) await creating;
    if (owner instanceof DurableJobs && owner.worker.cancellationOnly && !cancellationOnly) {
      const control = owner;
      if (control.worker.savedCancellationError) throw new Error(`Saved cancellation failed: ${control.worker.savedCancellationError}. Repair the saved inputs/storage and retry cancel_saved before starting or restoring work.`);
      if (await control.worker.cancellationInProgress()) throw new Error("Saved cancellation is still in progress. Use piccolo_jobs wait or status before starting or restoring work.");
      creating = (async () => { await control.close("suspend"); unregister?.(); unregister = undefined;
        if (owner === control) { owner = undefined; workspace = undefined; } })();
      try { await creating; } finally { creating = undefined; }
    }
    if (creating) await creating;
    uiContext = ctx;
    if (owner && owner.session !== ctx.sessionManager.getSessionId()) throw new Error("Session lifecycle has not released the previous job owner");
    if (owner && owner.root !== projectRoot(ctx.cwd)) throw new Error("Start a new session before submitting jobs from another project root");
    if (owner && (owner instanceof DurableJobs) !== ((settings?.executor ?? "durable") === "durable")) throw new Error("Start a new session before changing the worker executor");
    if (!owner) {
      if (!restore && (settings?.executor ?? "durable") === "durable" && (recovery?.jobs.some(job => !job.terminal) || recovery?.error)) throw new Error(recovery?.error ? `Cannot verify saved Durable work: ${recovery.error}. Inspect piccolo_jobs recovery and retry discovery after repairing storage.` : "Saved Jobs are suspended. Inspect piccolo_jobs recovery and use resume before submitting new work.");
      const identity = ctx.sessionManager.getSessionId();
      const callbacks = {
        pool, capacity: pool?.capacity, maxJobs: settings?.max_jobs_per_session, shutdownMs: settings?.shutdown_timeout_ms, changed: redraw,
        notify: (ids: string[]) => {
          ids = ids.filter(id => !foregroundIds.has(id));
          if (!ids.length) return;
          if (!owner || ctx.sessionManager.getSessionId() !== identity) return;
          const attentionOwner = { sessionId: identity, claimed: false };
          if (ids.some(id => (notifications.get(id) ?? "follow_up") === "follow_up"))
            pi.events.emit("pi-harness-health:attention-owner:v1", attentionOwner);
          for (const mode of ["follow_up", "notify_only"] as const) {
            // Health owns only automatic follow-up delivery. Passive notices
            // retain their captured per-job behavior even in a mixed batch.
            if (mode === "follow_up" && attentionOwner.claimed) continue;
            const batch = ids.filter(id => (notifications.get(id) ?? "follow_up") === mode);
            if (!batch.length) continue;
            const content = `Piccolo jobs finished or need attention: ${batch.join(", ")}. Inspect piccolo_jobs status/result and parent_review before deciding what to do next. Record ack with outcome_revision and a decision note after handling it; superseded outcomes need no repeated action.`;
            if (mode === "notify_only") {
              if (uiContext?.hasUI) uiContext.ui.notify(`${batch.length} job outcome(s) ready for review · /piccolo-jobs`, "info");
              pi.sendMessage({ customType: "piccolo-jobs", content, display: true, details: { jobs: batch } }, { triggerTurn: false, deliverAs: "nextTurn" });
            } else if (parentRunActive && !ctx.isIdle()) {
              pi.sendMessage({ customType: "piccolo-jobs", content, display: true, details: { jobs: batch } }, { triggerTurn: true, deliverAs: "followUp" });
            } else {
              const deferred = `${content} Automatic idle wake is unavailable in this runtime configuration; this notice will accompany your next prompt.`;
              if (uiContext?.hasUI) uiContext.ui.notify(`${batch.length} job outcome(s) ready · automatic wake unavailable; send a prompt to review · /piccolo-jobs`, "info");
              pi.sendMessage({ customType: "piccolo-jobs", content: deferred, display: true, details: { delivery: "next_turn_compat", jobs: batch } }, { triggerTurn: false, deliverAs: "nextTurn" });
            }
          }
        },
      };
      creating = (async () => {
        recovery ??= await discoverJobs(projectRoot(ctx.cwd), identity, ctx, settingsFor(ctx));
        if (!restore && (settings?.executor ?? "durable") === "durable" && (recovery.jobs.some(job => !job.terminal) || recovery.error)) throw new Error(recovery.error ? `Cannot verify saved Durable work: ${recovery.error}. Inspect piccolo_jobs recovery and retry discovery after repairing storage.` : "Saved Jobs are suspended. Inspect piccolo_jobs recovery and choose resume first.");
        if ((settings?.executor ?? "durable") === "durable") {
          const local = await localJobs(projectRoot(ctx.cwd), ctx, { ...callbacks, resume: false, dispatchOnly, cancellationOnly, workerPolicy: integration?.worker_policy, managedPolicy: integration?.require_worker_policy === true, nativeSettings: { ...pi.getSettings() } });
          owner = local.jobs; workspace = local.workspace;
          for (const [id, mode] of Object.entries(await local.jobs.notificationModes())) notifications.set(id, mode);
        } else owner = new SessionJobs(projectRoot(ctx.cwd), identity, callbacks);
      })();
      try { await creating; } finally { creating = undefined; }
      const sessionFile = ctx.sessionManager.getSessionFile() ?? identity;
      const instance = owner!;
      // pi-subagents 0.68 automatically drains this registry at every headless
      // agent_end. Register only in the TUI; RPC uses piccolo_jobs wait so its
      // parent remains responsive while jobs run.
      unregister = ctx.hasUI ? native?.registerBackgroundWorkProvider({ name: `piccolo-${instance.runtime}`,
        listActiveWork: () => instance.list(0, 10000).filter(job => !job.outcome_revision).map(job => ({ id: job.id, sessionId: sessionFile })),
        wakeChannels: ["piccolo:jobs:changed:v1"],
      }) : undefined;
    }
    return owner!;
  };
  const restoreJobs = async (ctx: ExtensionContext) => {
    const config = settingsFor(ctx);
    const jobs = await manager(ctx as ExtensionToolContext, { ...config.background, executor: "durable" }, config.pool, true, !!recovery?.jobs.length && recovery.jobs.every(job => !!job.remote), config.integration);
    if (!(jobs instanceof DurableJobs)) throw new Error("Saved Jobs require Durable execution");
    await jobs.worker.resumeSaved(); recovery = undefined; suspendOnShutdown = false; await jobs.refresh(); return jobs.list(0, 1000);
  };
  const cancelSaved = async (ctx: ExtensionContext, includeIndependent = false) => {
    if (owner instanceof DurableJobs && !owner.worker.savedSuspended && !owner.worker.cancellationOnly)
      throw new Error("cancel_saved is limited to a suspended saved generation. Use stop for an active Job.");
    const config = settingsFor(ctx);
    const jobs = await manager(ctx as ExtensionToolContext, { ...config.background, executor: "durable" }, config.pool, true,
      !!recovery?.jobs.length && recovery.jobs.every(job => !!job.remote), config.integration, true);
    if (!(jobs instanceof DurableJobs)) throw new Error("Saved cancellation requires Durable Jobs");
    const admissions = Object.values(await readAdmissions(jobs.worker.harness, BACKGROUND_CONTEXT));
    if (!includeIndependent && admissions.some(admission => admission.input.owner === jobs.session && admission.input.lifetime === "independent"))
      throw new Error("Saved generation includes attached independent Jobs. Set include_independent=true to cancel this whole saved generation, or keep it suspended and stop a detached Job on its original worker.");
    const wait = withCancel(BACKGROUND_CONTEXT), timer = setTimeout(() => wait.cancel(), 1000);
    try { await jobs.worker.cancelSaved(jobs.session, wait.context); }
    catch (error) { if (!(error instanceof WorkerWaitCancelled)) throw error; }
    finally { clearTimeout(timer); wait.cancel(); }
    recovery = undefined; suspendOnShutdown = false; await jobs.refresh(); const result = jobs.list(0, 1000);
    return result;
  };
  const recoveryPage = (inventory: RecoveryInventory, offset = 0, limit = 20) => {
    const entries = [...inventory.jobs.map(job => ({ scope: "session", job })), ...inventory.independent.map(job => ({ scope: "independent", job }))];
    const summary = (job: typeof inventory.jobs[number]) => {
      const safe = (value: string | undefined, limit = 500) => value?.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, limit);
      return { id: job.id, kind: job.kind, owner: safe(job.owner, 200), lifetime: job.lifetime, host: safe(job.host, 200),
        state: safe(job.state, 200), terminal: job.terminal, availability: job.availability, parentReview: job.parentReview,
        outcomeRevision: job.outcomeRevision, dismissed: job.dismissed, unresolvedRemote: job.unresolvedRemote, hostName: safe(job.hostName, 200),
        reason: safe(job.reason), attention: job.attention?.slice(0, 4).map(item => ({ id: safe(item.id, 200), stage: safe(item.stage, 200), question: safe(item.question) })), has_result: job.hasResult ?? (job.result !== undefined) };
    };
    const page: Array<{ scope: string; job: ReturnType<typeof summary> }> = [];
    for (const entry of entries.slice(offset, offset + limit)) {
      const value = { scope: entry.scope, job: summary(entry.job) };
      if (page.length && JSON.stringify([...page, value]).length > 12000) break;
      page.push(value);
    }
    return { session: inventory.session, jobs: page.filter(item => item.scope === "session").map(item => item.job),
      independent: page.filter(item => item.scope === "independent").map(item => item.job), total: entries.length,
      session_total: inventory.jobs.length, independent_total: inventory.independent.length,
      next_offset: offset + page.length < entries.length ? offset + page.length : null, error: inventory.error,
      note: "This is recovery status. Resume or attach explicitly to inspect full outcomes; terminal work is not rerun." };
  };
  const changeNotice = async (id: string, dismissed: boolean, ctx: ExtensionContext) => {
    const root = projectRoot(ctx.cwd), session = ctx.sessionManager.getSessionId();
    if (owner && (owner.root !== root || owner.session !== session)) throw new Error("Use the Job owner's original project and session");
    const inventory = owner instanceof DurableJobs ? undefined : await discoverJobs(root, session, ctx, settingsFor(ctx));
    if (inventory?.error) throw new Error(`Cannot verify detached notice ownership: ${inventory.error}`);
    if (owner?.jobs.has(id) || inventory?.jobs.some(job => job.id === id)) throw new Error("Session Jobs require explicit management; only detached independent notices can be dismissed");
    setRecoveryNotice(projectRoot(ctx.cwd), id, dismissed);
    recovery = await discoverJobs(projectRoot(ctx.cwd), ctx.sessionManager.getSessionId(), ctx, settingsFor(ctx), false, owner instanceof DurableJobs);
    return { id, dismissed, note: "Only the recovery notice changed. The original worker, records and ownership are retained." };
  };
  const attachJob = async (id: string, hostName: string, ctx: ExtensionContext, signal?: AbortSignal) => {
    const config = settingsFor(ctx), host = config.hosts?.[hostName];
    if (!host?.worker_identity || !host.worker_transport) throw new Error("Select the original configured Durable host");
    const target = { workspace: { host: host.hostname, cwd: host.cwd, identity: host.worker_identity }, transport: host.worker_transport };
    const original = retainedAssignment(projectRoot(ctx.cwd), target, id).submission;
    if (original.lifetime !== "independent") throw new Error("Only independent remote work can attach to another parent session");
    await workerRequest(target, { operation: "inspect", requestId: original.requestId }, signal, 5000);
    const jobs = await manager(ctx as ExtensionToolContext, { ...config.background, executor: "durable" }, config.pool, false, true, config.integration);
    if (!(jobs instanceof DurableJobs)) throw new Error("Attach requires Durable Jobs");
    const attachedId = await jobs.attach(original, target);
    return response(jobs.status(attachedId));
  };
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "harness_health" || event.isError || event.input.action !== "disposition" || event.input.disposition !== "resolved"
        || !owner || owner.session !== ctx.sessionManager.getSessionId()) return;
    const result = event.details as any;
    const incident = result?.scope === "harness-only" && result.incidents?.find((item: any) => item.id === event.input.id);
    if (!incident || incident.disposition !== "resolved" || incident.component !== "attention" || incident.reference?.kind !== "job") return;
    try {
      const job = owner.status(incident.reference.id);
      if (job.parent_review.disposition !== "pending") return;
      await owner.acknowledge(job.id, job.outcome_revision ?? "", `Health incident ${incident.id}: ${incident.reason}`);
    } catch (error) {
      // A health resolution cannot imply a job was inspected. Keep its pending
      // review visible if no matching terminal result was read or recording failed.
      pi.appendEntry("piccolo-job-acknowledgment-pending", { job: incident.reference.id, reason: String(error) });
    }
  });
  pi.on("agent_start", () => { parentRunActive = true; });
  pi.on("agent_end", () => { parentRunActive = false; });
  const promptRestore = async (ctx: ExtensionContext) => {
    const inventory = recovery;
    if (!inventory || owner || !ctx.hasUI || !ctx.ui.select) return;
    if (!inventory.jobs.some(job => !job.terminal) && !inventory.independent.some(job => !job.terminal)) return;
    const rows = [...inventory.jobs, ...inventory.independent].slice(0, 20).map(job => `${job.id}: ${job.kind}, ${job.state}, ${job.host}, ${job.availability}`).join("\n");
    const unfinished = inventory.jobs.some(job => !job.terminal);
    const choice = await ctx.ui.select(`Restore saved Jobs?\n${rows}`, [...(unfinished ? ["Resume saved Jobs", "Cancel saved Jobs"] : []), ...(!unfinished && inventory.independent.some(job => job.hostName && !job.terminal) ? ["Attach an independent Job"] : []), ...(inventory.independent.length ? ["Dismiss an independent notice"] : []), "Inspect saved Jobs", "Keep suspended"], { timeout: 30000 });
    if (choice === "Resume saved Jobs") await restoreJobs(ctx);
    else if (choice === "Cancel saved Jobs") {
      if (await ctx.ui.confirm("Cancel this session's saved Jobs?", "This includes independent remote Jobs already attached to this session. Detached Jobs from other parents require attach, then stop. Worktrees and recorded outcomes are retained.", { timeout: 30000 })) await cancelSaved(ctx, true);
    }
    else if (choice === "Attach an independent Job") {
      const candidates = inventory.independent.filter(job => job.hostName);
      const selected = await ctx.ui.select("Independent Jobs", candidates.map(job => `${job.id} · ${job.hostName} · ${job.state} · ${job.availability}`), { timeout: 30000 });
      const job = candidates.find(job => selected?.startsWith(job.id));
      if (job) await attachJob(job.id, job.hostName!, ctx);
    }
    else if (choice === "Inspect saved Jobs") await showJobDetail(ctx, "Saved Jobs", inventory);
    else if (choice === "Dismiss an independent notice") {
      const selected = await ctx.ui.select("Dismiss recovery notice", inventory.independent.map(job => `${job.id} · ${job.host} · ${job.state}`), { timeout: 30000 });
      const job = inventory.independent.find(job => selected?.startsWith(job.id));
      if (job && await ctx.ui.confirm("Dismiss this notice?", "This does not stop or delete the Job. Use recovery with include_dismissed to show it again.", { timeout: 30000 })) await changeNotice(job.id, true, ctx);
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    parentRunActive = false; uiContext = ctx; suspendOnShutdown = false; rpcRestorePrompt = false;
    if (owner) { redraw(); return; }
    recovery = undefined;
    try {
      recovery = await probeJobs(await discoverJobs(projectRoot(ctx.cwd), ctx.sessionManager.getSessionId(), ctx, settingsFor(ctx)), projectRoot(ctx.cwd), 4, 1500);
      if (!recovery.jobs.some(job => !job.terminal || job.parentReview === "pending") && !recovery.independent.length && !recovery.error) { return; }
      const summary = recoveryPage(recovery);
      const notice = `Saved Piccolo Jobs for this session: ${JSON.stringify(summary)}. Unfinished local work stays suspended. Ask the user before resume, cancel_saved, attach or dismiss unless they already authorized that recovery action. Do not resume merely because this notice exists. Independent remote work may already be running. Inspect unavailable resources before deciding.`;
      pi.sendMessage({ customType: "piccolo-jobs", content: notice, display: true, details: { recovery: true } }, { triggerTurn: false, deliverAs: "nextTurn" });
      if (ctx.mode === "rpc") {
        rpcRestorePrompt = true;
        ctx.ui.notify("Saved Jobs are suspended. Your next prompt will ask whether to restore them; piccolo_jobs recovery/resume is also available.", "info");
      } else await promptRestore(ctx);
    } catch (error) {
      recovery ??= { session: ctx.sessionManager.getSessionId(), jobs: [], independent: [] };
      recovery.error = String(error).slice(0, 1000);
      ctx.ui?.notify?.(`Saved Jobs could not be restored: ${recovery.error}. Use piccolo_jobs recovery to inspect and retry.`, "warning");
    } finally { redraw(); }
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    // RPC attaches its input reader after initial session_start. A modal dialog
    // is safe here, before inference, once that reader can accept its response.
    if (rpcRestorePrompt) { rpcRestorePrompt = false; await promptRestore(ctx); }
  });
  // These events fire only for a confirmed transition. Parent turn interruption
  // and compaction deliberately have no job-cancellation hook.
  pi.on("session_shutdown", async event => { parentRunActive = false; if (creating) await creating; const previous = owner; try { if (previous) await previous.close(suspendOnShutdown ? "suspend" : event.reason); } finally { unregister?.(); unregister = undefined; owner = undefined; workspace = undefined; recovery = undefined; notifications.clear(); foregroundIds.clear(); rpcRestorePrompt = false; redraw(); } });
  register({ name: "piccolo_submit", label: "Submit background work",
    description: "Start a typed delegate, implementation workflow, dependency schedule, or reproducible experiment without waiting. Inputs and parent selection are captured now. Jobs stop with this Pi session unless an explicit remote host and independent lifetime are selected. Use piccolo_jobs to observe, message, stop or wait.",
    parameters: Type.Object({ kind: Type.Union([Type.Literal("delegate"), Type.Literal("workflow"), Type.Literal("schedule"), Type.Literal("experiment")]), host: Type.Optional(Type.String({ description: "Explicit named Durable worker host; its workspace must already be provisioned." })), lifetime: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("independent")])), arguments: Type.Union(Object.values(schemas), { description: "A JSON object containing the corresponding foreground tool arguments; do not serialize it as a string." }) }),
    async execute(_id, params: any, _signal, _update, ctx) {
      if (!Object.hasOwn(schemas, params.kind) || !Check(schemas[params.kind as JobKind], params.arguments)) throw new Error("Arguments do not match the selected job kind; use the corresponding foreground tool schema");
      if (params.lifetime === "independent" && !params.host) throw new Error("Independent lifetime requires an explicit remote worker");
      const prepared = prepare(params.kind, params.arguments, ctx, params.host);
      const remote = prepared.target ? await workerRequest(prepared.target, { operation: "info" }) : undefined;
      const jobs = await manager(ctx, prepared.settings, (prepared.snapshot as any).resolved?.config?.pool, false, !!prepared.target, (prepared.snapshot as any).resolved?.config?.integration);
      const id = jobs instanceof DurableJobs
        ? await jobs.submit(prepareSubmission(prepared.snapshot, workspace!, ctx.sessionManager.getSessionId(), prepared.target ? { target: prepared.target, base: remote.head, worktreeOwner: remote.worktreeOwner, lifetime: params.lifetime ?? "session" } : undefined))
        : jobs.submit(params.kind, prepared.snapshot, prepared.execute);
      const mode = prepared.settings?.notifications ?? "follow_up";
      notifications.set(id, mode);
      if (jobs instanceof DurableJobs) await jobs.setNotification(id, mode);
      return response(jobs.status(id));
    },
  });
  register({ name: "piccolo_jobs", label: "Observe and manage session jobs",
    description: "List/status/result/result_page/ack/stop/message/wait for this session's jobs. Recovery lists suspended session work and detached independent notices with pagination; resume/cancel_saved are explicit decisions. cancel_saved is limited to suspended saved work; include_independent=true explicitly includes already attached independent Jobs. Use stop for an active Job. Dismiss hides only a detached independent recovery notice, show_notice restores it, and recovery include_dismissed lists hidden notices. Returning from submission or pressing Esc does not stop a job. Messages default to the current or next implementation coordinator; schedules require an explicit target shown in status. Delivery receipts show observed input delivery or a Durable answer; they do not prove the model acted on the instruction. Durable experiment_report supports paginated comparison JSON, assess records immutable rubric assessments, and export_schedule projects settled candidates into the roadmap. For truncated results use result_page with revision and offset, reading every page. Inspect result, then ack its outcome_revision with a decision note; optional replacement links a later same-kind job without deleting history. Ended jobs never restart. Saved Durable work is discovered for its parent session; records from unrelated native sessions require manual reconciliation.",
    parameters: Type.Object({ action: Type.Union(["list", "recovery", "dismiss", "show_notice", "resume", "cancel_saved", "suspend", "attach", "status", "result", "result_page", "ack", "stop", "message", "wait", "export_schedule", "experiment_report", "assess"].map(action => Type.Literal(action))), include_dismissed: Type.Optional(Type.Boolean()), include_independent: Type.Optional(Type.Boolean()), id: Type.Optional(Type.String()), host: Type.Optional(Type.String()), revision: Type.Optional(Type.String()), note: Type.Optional(Type.String()), assessment: Type.Optional(Type.Object({ trial: Type.String(), outcomeDigest: Type.String(), verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("uncertain")]), assessor: Type.String(), provenance: Type.Union([Type.Literal("human_reported"), Type.Literal("agent_reported")]), evidence: Type.Array(Type.String()), note: Type.String() })), replacement: Type.Optional(Type.String()), text: Type.Optional(Type.String()), target: Type.Optional(Type.String()), message_id: Type.Optional(Type.String({ format: "uuid" })), wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === "dismiss" || params.action === "show_notice") return response(await changeNotice(params.id ?? "", params.action === "dismiss", ctx));
      if (params.action === "recovery") {
        if (owner) {
          if (owner instanceof DurableJobs) await owner.refresh();
          const inventory = await discoverJobs(projectRoot(ctx.cwd), owner.session, ctx, settingsFor(ctx), params.include_dismissed, owner instanceof DurableJobs);
          inventory.independent = inventory.independent.filter(job => !owner!.jobs.has(job.id));
          const active = owner.list(0, 10000).map(job => ({ id: job.id, kind: job.kind, owner: owner!.session, lifetime: job.lifetime,
            host: job.host ?? "local", state: job.state, terminal: !!job.outcome_revision, availability: "unchecked" as const, parentReview: job.parent_review.disposition,
            outcomeRevision: job.outcome_revision, attention: (job as any).attention, reason: job.error, hasResult: job.has_result }));
          inventory.jobs = owner instanceof DurableJobs ? active : [...active, ...inventory.jobs.filter(job => !owner!.jobs.has(job.id))];
          return response({ ...recoveryPage(inventory, params.offset, params.limit), active: true });
        }
        recovery = await probeJobs(await discoverJobs(projectRoot(ctx.cwd), ctx.sessionManager.getSessionId(), ctx, settingsFor(ctx), params.include_dismissed), projectRoot(ctx.cwd)); return response(recoveryPage(recovery, params.offset, params.limit));
      }
      if (params.action === "resume") return response({ jobs: await restoreJobs(ctx) });
      if (params.action === "cancel_saved") return response({ jobs: await cancelSaved(ctx, params.include_independent), cancellation_requested: true });
      if (params.action === "attach") return attachJob(params.id ?? "", params.host ?? "", ctx, _signal);
      if (params.action === "suspend") {
        if (!(owner instanceof DurableJobs)) throw new Error("Suspend requires active Durable Jobs");
        await owner.close("suspend"); suspendOnShutdown = false; unregister?.(); unregister = undefined; owner = undefined; workspace = undefined;
        recovery = await discoverJobs(projectRoot(ctx.cwd), ctx.sessionManager.getSessionId(), ctx, settingsFor(ctx)); redraw(); return response({ suspended: true, recovery: recoveryPage(recovery) });
      }
      if (params.action === "list") {
        if (!owner && recovery) return response({ ...recoveryPage(recovery, params.offset, params.limit), suspended: true });
        const page = [];
        for (const job of owner?.list(params.offset, params.limit) ?? []) { if (JSON.stringify([...page, job]).length > 12000) break; page.push(job); }
        const next = (params.offset ?? 0) + page.length;
        return response({ jobs: page, total: owner?.jobs.size ?? 0, next_offset: next < (owner?.jobs.size ?? 0) ? next : null });
      }
      if (!owner) throw new Error("No jobs owned by this session");
      const id = params.id ?? "";
      if (params.action === "assess" || params.action === "experiment_report") {
        if (!(owner instanceof DurableJobs)) throw new Error("Use the existing CLI for native experiments");
        return response(params.action === "assess" ? await owner.assess(id, params.assessment) : await owner.experimentReport(id, params.offset, params.revision));
      }
      if (params.action === "export_schedule") { if (!(owner instanceof DurableJobs)) throw new Error("Schedule export requires Durable Jobs"); return response(await owner.exportSchedule(id)); }
      if (params.action === "result_page") return response(owner.resultPage(id, params.revision ?? "", params.offset));
      if (params.action === "ack") return response(await owner.acknowledge(id, params.revision ?? "", params.note ?? "", params.replacement));
      if (params.action === "message") return response(await (owner instanceof DurableJobs ? owner.message(id, params.text ?? "", params.target, params.message_id) : owner.message(id, params.text ?? "", params.target)));
      if (params.action === "wait") return response(await owner.wait(id, params.wait_ms));
      if (params.action === "stop") return response(await owner.stop(id));
      return response(params.action === "result" ? owner.result(id) : owner.status(id));
    },
  });
  pi.registerCommand("piccolo-jobs", {
    description: "Observe or manage jobs. Escape closes the menu and leaves jobs running.",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error("Use piccolo_jobs in noninteractive mode");
      uiContext = ctx;
      if (!owner && recovery) {
        const action = await ctx.ui.select("Saved Jobs", ["Resume saved Jobs", "Inspect saved Jobs", "Keep suspended"], { timeout: 30000 });
        if (action === "Resume saved Jobs") await restoreJobs(ctx);
        else if (action === "Inspect saved Jobs") { await showJobDetail(ctx, "Saved Jobs", recovery); return; }
        else return;
      }
      while (owner) {
        const current = owner;
        const id = await showJobList(ctx, () => owner === current ? current.list(0, 1000) : []);
        if (!id || owner !== current) return;
        const action = await ctx.ui.select(plain(`${id}: ${owner.status(id).state}`), ["Status", "Result", "Acknowledge result", "Send instruction", "Stop job", "Back"], { timeout: 30000 });
        if (!action) return;
        if (action === "Stop job") { if (await ctx.ui.confirm("Stop this job?", id, { timeout: 30000 })) await owner.stop(id); }
        else if (action === "Acknowledge result") {
          const note = await ctx.ui.input("Decision after inspecting Result", undefined, { timeout: 30000 });
          if (note) {
            try { await owner.acknowledge(id, owner.status(id).outcome_revision ?? "", note); }
            catch (error) { ctx.ui.notify(String(error), "error"); }
          }
        }
        else if (action === "Send instruction") {
          const text = await ctx.ui.input("Instruction", undefined, { timeout: 30000 });
          if (text) {
            const targets = owner.status(id).children.map(child => child.id);
            const target = targets.length > 1 || ["schedule", "experiment"].includes(owner.status(id).kind) ? await ctx.ui.select("Target coordinator", [...new Set(targets)], { timeout: 30000 }) : undefined;
            if ((targets.length > 1 || ["schedule", "experiment"].includes(owner.status(id).kind)) && !target) return;
            if (!["schedule", "experiment"].includes(owner.status(id).kind) || target) await owner.message(id, text, target);
          }
        } else if (action !== "Back") {
          const value = action === "Result" ? owner.result(id, false) : owner.status(id);
          await showJobDetail(ctx, `${action} — ${id}`, value);
          if (action === "Result" && value.outcome_revision && !detailTruncated(value)) owner.inspect(id, value.outcome_revision);
        }
      }
      if (!owner) ctx.ui.notify("No session-owned jobs yet", "info");
    },
  });
  return {
    async foreground(kind: JobKind, params: any, ctx: ExtensionToolContext, signal?: AbortSignal, update?: (value: any) => void, nativeFallback?: () => Promise<any>) {
      const prepared = prepare(kind, params, ctx);
      if (prepared.settings?.executor === "native") { if (!nativeFallback) throw new Error("Native foreground fallback is unavailable"); return nativeFallback(); }
      const jobs = await manager(ctx, prepared.settings, (prepared.snapshot as any).resolved?.config?.pool, false, false, (prepared.snapshot as any).resolved?.config?.integration);
      if (!(jobs instanceof DurableJobs)) throw new Error("Foreground Durable execution requires the Durable executor");
      const request = prepareSubmission(prepared.snapshot, workspace!, ctx.sessionManager.getSessionId());
      foregroundIds.add(request.requestId);
      const id = await jobs.submit(request);
      const mode = prepared.settings?.notifications ?? "follow_up"; notifications.set(id, mode); await jobs.setNotification(id, mode);
      const abort = () => { void jobs.stop(id).catch(() => {}); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          if (signal?.aborted) { await jobs.stop(id); throw new Error("Foreground job cancelled; inspect its retained outcome before retrying"); }
          const status = jobs.status(id);
          if (status.outcome_revision || status.attention_total) {
            if (!status.outcome_revision) foregroundIds.delete(id);
            const outcome = jobs.result(id), result: any = outcome.result;
            const value = kind === "delegate" ? { status: result?.status === "complete" ? "completed" : "needs_parent",
              result: result ? { kind: "text", text: result.text } : undefined, provenance: result?.provenance } : result ?? { status: "needs_parent" };
            return { ...response({ ...value, execution_contract: 2, job_id: id, run_id: id, record: status.record, cwd: status.cwd,
              origin: status.origin, model: result?.provenance?.observed?.length === 1 ? result.provenance.observed[0] : undefined,
              effort: result?.provenance?.effort, attention: status.attention, error: outcome.error }), isError: !!outcome.error };
          }
          update?.(response(status)); await jobs.wait(id, 500);
        }
      } finally { signal?.removeEventListener("abort", abort); }
    },
    active: () => owner?.list(0, 10000).some(job => !job.outcome_revision) ?? false,
    health: (sessionId: string) => owner?.session === sessionId ? owner.list(0, 1000).map(job => ({ id: job.id, state: job.state,
      updatedAt: job.updated_at, acknowledged: ["acknowledged", "superseded"].includes(job.parent_review.disposition), notifications: notifications.get(job.id) ?? "follow_up" })) : [],
  };
}
