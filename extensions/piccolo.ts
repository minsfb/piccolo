import { preflightBaseIgnores } from "../src/worktree-preflight.ts";
import { readExperiment, experimentTrialArguments, experimentMetrics, runExperiment, type Plan } from "../src/experiments.ts";
import { compactTool } from "../src/display.ts";
import path from "node:path";
import fs from "node:fs";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import { parse } from "smol-toml";
import { VERSION, keyHint, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { agentSchema, configSchema, bootstrapWorkflowEngine, captureConfig, loadConfig, resolveAgent, resolveLayers, readLayer, packageRoot, digest, type Layer } from "../src/config.ts";
import { initializeRecords, projectRoot, startRun } from "../src/records.ts";
import { delegate, validateAgentRuntime } from "../src/delegation.ts";
import { applyProfile, assertProfile, policy, profileChildExtensions } from "../src/profiles.ts";
import { git, parseReport, runWorkflow, validateRecipe } from "../src/workflow.ts";
import { boundNative, evidence } from "../src/evidence.ts";
import { runSchedule, inspectSchedule, type ExecutionResult } from "../src/scheduler.ts";
import { readRoadmap } from "../src/roadmap.ts";
import { runtimeSnapshot } from "../src/runtime.ts";
import { inspectConfig } from "../src/inspection.ts";
import { workerRequest, retainedAssignment } from "../src/durable/remote.ts";
import { remoteClient } from "../src/remote.ts";
import { registerJobs } from "../src/job-interface.ts";
import { background, captureMessages, withBackground } from "../src/job-context.ts";
import { readSchedule } from "../src/scheduler.ts";
import { planProject, assertNoPending, safePath } from "../src/onboarding.ts";
import { availableModels } from "../src/models.ts";
import { appendJobHealthSnapshot } from "../src/health-integration.ts";

import { reconcileWorkflows, acknowledgeWorkflow, verifyWorkflowCandidate, workflowNotice, workflowHome } from "../src/workflow-inbox.ts";
import { assertUpstream } from "../src/extensible.ts";

export default async function piccolo(pi: ExtensionAPI) {
  const register = <T extends TSchema>(tool: ToolDefinition<T>) => {
    const kinds = { piccolo_delegate: "delegate", piccolo_workflow: "workflow", piccolo_schedule: "schedule", piccolo_experiment: "experiment" } as const;
    const kind = kinds[tool.name as keyof typeof kinds];
    if (kind) {
      const execute = tool.execute;
      tool.execute = async (id, params, signal, update, ctx) => {
        const inspect = kind === "schedule" && (params as any).action !== "run";
        if (!inspect && !background(ctx)) return jobInterface.foreground(kind, params, ctx, signal, update, () => execute(id, params, signal, update, ctx));
        return execute(id, params, signal, update, ctx);
      };
    }
    pi.registerTool(compactTool(tool)); return tool;
  };
  // Optional standalone health package integration; no runtime dependency on it.
  pi.events.on("pi-harness-health:inspect:v1", (request: any) => {
    if (!request || typeof request.sessionId !== "string") return;
    const config = loadConfig(projectRoot(process.cwd()), { contributions }).config;
    request.config = config.extensions?.["pi-harness-health"] ?? {};
    if (request.phase === "active") appendJobHealthSnapshot(request, jobInterface.health(request.sessionId));
  });
  const resolvedFor = (ctx: import("@earendil-works/pi-coding-agent").ExtensionContext, options: Parameters<typeof loadConfig>[1] = {}) =>
    background(ctx)?.resolve(options) ?? loadConfig(projectRoot(ctx.cwd), options);
  const thinking = (ctx: import("@earendil-works/pi-coding-agent").ExtensionContext) => background(ctx)?.effort ?? pi.getThinkingLevel();
  const runDelegate: typeof delegate = async (api, ctx, agent, task, owner, extensions, signal, pool) => {
    const bg = background(ctx);
    if (!bg) return delegate(api, ctx, agent, task, owner, extensions, signal, pool);
    const target = (ctx as any).piccoloChildTarget ?? "delegate";
    const control = bg.execution.child(target, agent.tools, (ctx as any).piccoloCoordinator ?? true);
    if (agent.context === "fork") control.sharedContext = bg.shared;
    const worker = { ...agent, context: "fresh" as const, effort: agent.effort ?? bg.effort,
      prompt: `${agent.prompt ?? "Follow the task and project instructions."}\n<piccolo-worker-control:${control.id}>` };
    try {
      const result = await delegate(api, ctx, worker, task, owner, [...extensions, path.join(packageRoot, "integrations/session-worker.ts")], signal, pool, event => {
        control.phase = event.kind === "pool_wait" ? "waiting" : "starting";
        control.update(event);
      });
      if (result.status === "interrupted") { bg.execution.event({ kind: "cancellation_unacknowledged", run: owner }); (ctx as any).piccoloExperimentUncertain?.(); }
      return result;
    }
    finally { bg.execution.releaseChild(control); }
  };
  const workflowEngine = bootstrapWorkflowEngine(projectRoot(process.cwd()));
  if (workflowEngine === "extensible") {
    // Use the pinned package's public native extension. Companion subagent and
    // trajectory extensions are intentionally not loaded by this integration.
    assertUpstream();
    const upstream = await import("pi-extensible-workflows");
    upstream.default(pi, workflowHome(projectRoot(process.cwd())));
    for (const name of ["workflow:run-completed", "workflow:run-failed", "workflow:run-state-changed"]) {
      pi.events.on(name, (event: any) => {
        try { if (event?.cwd === projectRoot(process.cwd())) reconcileWorkflows(event.cwd); }
        catch (error) { pi.appendEntry("piccolo-workflow-reconciliation-error", { error: String(error) }); }
      });
    }
    pi.on("before_agent_start", (_event, ctx) => {
      const content = workflowNotice(projectRoot(ctx.cwd));
      if (content) return { message: { customType: "piccolo-workflow-inbox", content, display: false } };
    });
  }
  // Use Pi's configured binding rather than assuming Esc has not been remapped.
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("piccolo-cancel", keyHint("app.interrupt", "cancel active work"));
  });
  pi.on("agent_end", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("piccolo-cancel", undefined);
  });
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("piccolo-cancel", undefined);
  });
  const contributions: Layer[] = [];
  const identities = new Set<string>();
  pi.registerCommand("piccolo-configure", {
    description: "Materialize this project's selected compaction profile, including package contributions, then close this Pi session. Stop other Pi sessions for this cwd first.",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) throw new Error("Wait for active work to finish before configuring the profile.");
      if (jobInterface.active()) throw new Error("Stop session jobs before configuring the profile");
      const resolved = loadConfig(projectRoot(ctx.cwd), { contributions });
      applyProfile(ctx.cwd, resolved);
      if (ctx.hasUI) ctx.ui.notify(`Configured ${resolved.profile}; restart Pi to activate it.`, "info");
      ctx.shutdown();
    },
  });
  pi.registerCommand("piccolo-onboard", {
    description: "Complete piccolo init without model inference; normally invoked by the onboarding CLI.",
    handler: async (token, ctx) => {
      if (!/^[0-9a-f-]{36}$/.test(token) || !ctx.isIdle() || jobInterface.active()) throw new Error("Invalid or busy onboarding request");
      const root = projectRoot(ctx.cwd);
      planProject(root); assertNoPending(root);
      const resolved = loadConfig(root, { contributions });
      const state: any = applyProfile(root, resolved);
      const receipt = { format: 1, token, cwd: root, piccolo: JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version,
        pi: VERSION, profile: state.profile, policy_digest: state.policy_digest, contributions: [...identities], inference: false };
      fs.writeFileSync(safePath(root, ".pi/piccolo-onboarding.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
      ctx.shutdown();
    },
  });
  const sessionPolicies = new Map<string, string>();
  const checkProfile = (ctx: import("@earendil-works/pi-coding-agent").ExtensionContext) => {
    const resolved = loadConfig(projectRoot(ctx.cwd), { contributions });
    assertProfile(ctx.cwd, resolved);
    if ((resolved.config.workflow?.engine ?? "subagents") !== workflowEngine) throw new Error("Workflow engine changed; restart Pi to activate the selected runtime.");
    const current = digest(policy(resolved));
    const session = ctx.sessionManager.getSessionId();
    const previous = sessionPolicies.get(session);
    if (previous && previous !== current) throw new Error("This session's compaction policy changed. Restart Pi after configuring the new profile.");
    sessionPolicies.set(session, current);
    return resolved;
  };
  pi.on("input", (_event, ctx) => {
    try { checkProfile(ctx); }
    catch (error) {
      pi.appendEntry("piccolo-profile-error", { error: String(error), input_blocked: true });
      if (ctx.hasUI) ctx.ui.notify(String(error), "error");
      else console.error(`Piccolo blocked input: ${String(error)}`);
      return { action: "handled" as const };
    }
  });
  pi.on("before_agent_start", (_event, ctx) => {
    try {
      const resolved = checkProfile(ctx);
      pi.appendEntry("piccolo-profile", { profile: resolved.profile, policy_digest: digest(policy(resolved)), policy: policy(resolved) });
    } catch (error) { ctx.abort(); throw error; }
  });
  pi.on("session_before_compact", (event, ctx) => {
    try {
      const resolved = checkProfile(ctx);
      if (resolved.config.compaction?.owner === "pi" && event.customInstructions === "__pi_vcc__") throw new Error("Select the Blackhole profile before invoking its manual compaction command.");
    } catch (error) {
      pi.appendEntry("piccolo-profile-error", { error: String(error) });
      if (ctx.hasUI) ctx.ui.notify(String(error), "error");
      return { cancel: true };
    }
  });
  pi.events.on("piccolo:contribute:v1", (request: any) => {
    try {
      const parsed = z.strictObject({ id: z.string().min(1), version: z.string().min(1), config: configSchema, override: z.boolean().optional() }).parse(request.contribution);
      if (identities.has(parsed.id)) throw new Error(`Duplicate contribution: ${parsed.id}`);
      for (const section of ["agents", "models", "jobs", "profiles"] as const) for (const name of Object.keys(parsed.config[section] ?? {})) {
        const existing = resolveLayers(readLayer(path.join(packageRoot, "config/defaults.toml"))!, contributions).config[section];
        if (existing?.[name] && !parsed.override) throw new Error(`Contribution collision: ${section}.${name}; declare override=true`);
      }
      contributions.push({ source: `package:${parsed.id}@${parsed.version}`, value: parsed.config }); identities.add(parsed.id);
      request.result = { ok: true };
    } catch (error) { request.result = { ok: false, error: String(error) }; }
  });
  const response = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
  register({ name: "piccolo_workflow_inbox", label: "Reconcile workflow outcomes",
    description: "Reconcile retained upstream workflow state into immutable project receipts. Inspect bounded pages; acknowledge an exact observed revision with a note. Stale acknowledgments reject; no work is replayed and recorded running does not prove a live worker.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("inspect"), Type.Literal("ack"), Type.Literal("verify")]), receipt: Type.Optional(Type.String()), note: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = projectRoot(ctx.cwd);
      if (params.action === "verify") return response(verifyWorkflowCandidate(root, params.receipt ?? ""));
      if (params.action === "ack") return response(acknowledgeWorkflow(root, params.receipt ?? "", params.note ?? ""));
      const inbox = reconcileWorkflows(root); const offset = params.offset ?? 0; const limit = params.limit ?? 20;
      const page = [];
      for (const item of inbox.observations.slice(offset, offset + limit)) {
        const summary = { id: item.id, run: item.run, state: item.state, models: item.models.slice(0, 4), agent_states: item.agent_states, acknowledged: item.acknowledged, needs_attention: item.needs_attention };
        if (JSON.stringify([...page, summary]).length > 10000) break;
        page.push(summary);
      }
      return response({ total: inbox.observations.length, pending: inbox.pending.length, unresolved: inbox.unresolved.length, missing_sources: inbox.missing_sources.slice(offset, offset + 10), missing_state: inbox.missing_state.slice(offset, offset + 10), observations: page, missing_sources_total: inbox.missing_sources.length, missing_state_total: inbox.missing_state.length, next_missing_offset: offset + 10 < Math.max(inbox.missing_sources.length, inbox.missing_state.length) ? offset + 10 : null, next_offset: offset + page.length < inbox.observations.length ? offset + page.length : null, note: inbox.note });
    },
  });
  register({ name: "piccolo_models", label: "Discover native model capabilities", description: "Inspect available models in this Pi session, optionally filtering provider, input kind or effort. Uses native provider packages and managed registration; does not replace authentication, probe inference, change selection or choose a fallback.",
    parameters: Type.Object({ provider: Type.Optional(Type.String()), input: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("image")])), effort: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) { return response(availableModels(ctx, params)); },
  });
  register({ name: "piccolo_inspect", label: "Explain Piccolo configuration", description: "Show effective configuration and origins, including packages contributed in this Pi session. Optional JSON Pointer or agent type resolves a focused view. Does not change selection or materialize configuration.",
    parameters: Type.Object({ pointer: Type.Optional(Type.String()), type: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = inspectConfig(loadConfig(projectRoot(ctx.cwd), { contributions }), params.pointer, params.type);
      return response({ ...result, scope: "Current Pi session contributions plus files; runtime model availability remains a launch check." });
    },
  });
  register({ name: "piccolo_remote", label: "Explicit remote job", description: "Reconnect to an explicitly assigned Durable worker by ID to inspect, message or stop it; messages require a stable UUID message_id. Start typed Durable work with piccolo_submit. Legacy hosts support native start/status. Never selects a host automatically. Status does not replay work; unresolved means no terminal receipt, not proof the worker is alive. Remote cwd/packages must already be provisioned. Native completion is not a task correctness verdict.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("message"), Type.Literal("stop")]), text: Type.Optional(Type.String()), target: Type.Optional(Type.String()), message_id: Type.Optional(Type.String()), host: Type.String(), id: Type.Optional(Type.String()), task: Type.Optional(Type.String()), model: Type.Optional(Type.String()), effort: Type.Optional(Type.String()), timeout_ms: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === "status" && [params.task, params.model, params.effort, params.timeout_ms].some(v => v !== undefined)) throw new Error("Status cannot change or replay job inputs");
      const root = projectRoot(ctx.cwd), resolved = loadConfig(root, { contributions });
      const host = resolved.config.hosts?.[params.host];
      if (host?.worker_identity && host.worker_transport) {
        if (params.action === "start") throw new Error("Use piccolo_submit with this host and lifetime=independent to start a typed Durable job");
        if ([params.task, params.model, params.effort, params.timeout_ms].some(value => value !== undefined)) throw new Error("Reconnection cannot change frozen inputs");
        const target = { workspace: { host: host.hostname, cwd: host.cwd, identity: host.worker_identity }, transport: host.worker_transport };
        const id = params.id ?? "";
        retainedAssignment(root, target, id);
        const request = params.action === "status" ? { operation: "inspect", requestId: id } : params.action === "stop" ? { operation: "abort", requestId: id } :
          { operation: "message", requestId: id, messageId: params.message_id, text: params.text, target: params.target };
        return response(await workerRequest(target, request));
      }
      if (params.action !== "start" && params.action !== "status") throw new Error("This operation requires a Durable worker host");
      return response(await remoteClient(root, resolved, params.host, params.action, params));
    },
  });
  register({ name: "piccolo_readiness", label: "Evaluate roadmap dependencies", description: "Read tracked .piccolo/roadmap.json, evaluate commit/merge prerequisites and detect stale dependency bindings. Reports readiness; the parent decides and launches work. No automatic scheduler or tracker sync.", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) { return response(readRoadmap(projectRoot(ctx.cwd))); },
  });
  register({
    name: "piccolo_evidence", label: "Record artifact evidence",
    description: "Record a concise summary and a file/workspace reference with hash, candidate and Code navigation. Does not open applications or copy raw artifacts into Git. Browser preview URLs must be reachable from the viewer; remote localhost needs explicit forwarding. Use local=true only for an agent running on the viewer's computer.",
    parameters: Type.Object({ file: Type.String(), summary: Type.String(), preview: Type.Optional(Type.String()), local: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, ctx) { return response(await evidence(projectRoot(ctx.cwd), { ...params, preview: params.preview || undefined })); },
  });
  const workflowInvocation = (params: any) => {
    const invocation: any = params.overrides_toml ? parse(params.overrides_toml) : {};
    if (params.validation_checks !== undefined) {
      const job = params.job || "implementation";
      const prior = Object.hasOwn(invocation.jobs ?? {}, job) ? invocation.jobs[job] : {};
      return { ...invocation, jobs: { ...invocation.jobs, [job]: { ...prior, validation: { ...prior.validation, checks: { ...prior.validation?.checks, ...params.validation_checks } } } } };
    }
    return invocation;
  };
  const validationChecks = Type.Optional(Type.Record(Type.String(), Type.Object({
    command: Type.String(), scope: Type.String(), boundary: Type.Union([Type.Literal("isolated"), Type.Literal("integration"), Type.Literal("live")]),
    cwd: Type.Optional(Type.String()), timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400000 })), required: Type.Optional(Type.Boolean()),
  }), { description: "Named commands selected from project instructions with explicit scope and isolation boundary. Required by default; executed once after QA with receipts tied to the exact candidate." }));
  const workflowTool = register({
    name: "piccolo_workflow", label: "Run implementation workflow",
    description: "Run implement -> independent review panel -> QA with bounded revisions using the configured worker executor (Durable by default). Creates and retains a new branch/worktree, or with candidate plus base continues review/QA of that exact clean existing worktree without replaying implementation. Returns candidate and durable stage records; parent handles PR publication and roadmap dependencies. Blockers and challenges are valid results. Requires .pi/ ignored and project configuration committed. Does not push, merge, or replay interrupted work.",
    parameters: Type.Object({ task: Type.String(), validation_checks: validationChecks, worktree: Type.Optional(Type.String({ description: "Omit for the owning primary Git checkout's .worktrees/<branch-name> (slashes become hyphens). Its ignored parent is prepared automatically. Explicit absolute destinations are preserved and need an accessible existing parent; candidate continuation requires this field." })), branch: Type.String(), job: Type.Optional(Type.String()), base: Type.Optional(Type.String()), candidate: Type.Optional(Type.String({ description: "Full existing candidate SHA: verify this worktree/branch and start at review. Requires explicit base." })), max_revisions: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })), overrides_toml: Type.Optional(Type.String({ description: 'Configuration patch, e.g. [jobs.implementation.stages.review]\nagents = ["reviewer", "architect"]. Omit unwanted fields.' })) }),
    async execute(_id, params, signal, update, ctx) {
      const root = projectRoot(ctx.cwd);
      const resolved = resolvedFor(ctx, { contributions, invocation: workflowInvocation(params) });
      assertProfile(ctx.cwd, resolved);
      if (workflowEngine === "extensible") throw new Error("The extensible experiment uses the native workflow and workflow_catalog tools with a text workflow script. See docs/extensible-workflows.md; the subagents recipe is inactive until workflow.engine is subagents and Pi restarts.");
      const job = params.job || "implementation";
      const stages = validateRecipe(resolved, job);
      for (const stage of Object.values(stages)) for (const type of stage.agents ?? []) validateAgentRuntime(resolveAgent(resolved, type), ctx);
      if (git(root, "status", "--porcelain", "--", ".piccolo/config.toml")) throw new Error("Commit project configuration before branching a workflow.");
      const extensions = profileChildExtensions(ctx.cwd, resolved);
      const runtime = runtimeSnapshot(ctx.cwd, VERSION);
      const result = await runWorkflow({ root, worktree: params.worktree, branch: params.branch, task: params.task, job, resolved, runtime, maxRevisions: params.max_revisions ?? 3, base: params.base || undefined, candidate: params.candidate }, async input => {
        const childContext = Object.create(ctx, { cwd: { value: input.cwd, enumerable: true }, piccoloChildTarget: { value: `${params.branch}/${input.stage}/${input.type}` }, piccoloCoordinator: { value: input.stage === "implement" } });
        const agent = validateAgentRuntime({ ...input.agent, ...(background(ctx) && !input.agent.effort ? { effort: thinking(ctx) } : {}) }, childContext);
        const run = startRun(root, { type: input.type, task: input.task, cwd: input.cwd, parent_run_id: input.workflow, resolved, agent, runtime, parent: { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, effort: thinking(ctx) } });
        update?.(response({ workflow: input.workflow, stage: input.stage, round: input.round, type: input.type, run: run.id }));
        try {
          const native = await runDelegate(pi, childContext, agent, input.task, run.id, extensions, signal, resolved.config.pool);
          run.finish({ status: native.status, native: boundNative(root, run.id, native, resolved.config.evidence?.max_return_chars) });
          if (native.status !== "completed") return { status: "blocked", summary: `Native worker ${native.status}: ${native.error ?? "inspect run " + run.id}`, evidence: [] };
          try { return parseReport(native.result?.text ?? ""); }
          catch {
            // One explicit report-only correction; never evaluate model output or
            // replay implementation side effects to repair a serialization error.
            const before = git(input.cwd, "rev-parse", "HEAD") + git(input.cwd, "status", "--porcelain");
            const correctionTask = `Repair only the JSON report from your completed ${input.stage} stage. Do not modify files, commit, rerun implementation, or change branches. Inspect git rev-parse HEAD to obtain the exact full SHA. Return strict JSON only with status, summary, commit, evidence. No JavaScript expressions or computed strings. Preserve the actual verdict and uncertainty. Original report:\n${(native.result?.text ?? "").slice(0, 12000)}`;
            const correction = startRun(root, { type: input.type, task: correctionTask, cwd: input.cwd, parent_run_id: run.id, resolved, agent, runtime, parent: { workflow: input.workflow, purpose: "report-correction" } });
            try {
              const reportContext = Object.create(childContext, { piccoloCoordinator: { value: false }, piccoloChildTarget: { value: `${params.branch}/${input.stage}/${input.type}/report` } });
              const fixed = await runDelegate(pi, reportContext, { ...agent, tools: ["read", "bash"] }, correctionTask, correction.id, extensions, signal, resolved.config.pool);
              correction.finish({ status: fixed.status, native: boundNative(root, correction.id, fixed, resolved.config.evidence?.max_return_chars) });
              if (before !== git(input.cwd, "rev-parse", "HEAD") + git(input.cwd, "status", "--porcelain")) throw new Error("Report correction changed the candidate; reconcile manually.");
              if (fixed.status !== "completed") throw new Error("Report correction did not complete; inspect its run record.");
              return parseReport(fixed.result?.text ?? "");
            } catch (error) {
              if (!fs.existsSync(path.join(correction.directory, "outcome.json"))) correction.finish({ status: "execution_error", error: String(error) });
              throw error;
            }
          }
        } catch (error) {
          if (!fs.existsSync(path.join(run.directory, "outcome.json"))) run.finish({ status: "execution_error", error: String(error) });
          throw error;
        }
      }, (cwd, continuation) => {
        if (continuation) { assertProfile(cwd, resolved); return; }
        git(cwd, "check-ignore", "-q", ".pi/piccolo-profile.json");
        // Only project runtime settings are copied, never auth, sessions or home state.
        fs.mkdirSync(path.join(cwd, ".pi"));
        const settingsFile = path.join(ctx.cwd, ".pi/settings.json");
        const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {};
        const key = resolved.config.integration?.server_compaction_key;
        fs.writeFileSync(path.join(cwd, ".pi/settings.json"), JSON.stringify({ compaction: settings.compaction, ...(key && settings[key]?.enabled !== undefined ? { [key]: { enabled: settings[key].enabled } } : {}) }), { mode: 0o600 });
        const materialized = structuredClone(resolved);
        if (resolved.config.compaction?.owner === "blackhole") {
          const blackhole = extensions.find(file => path.basename(path.dirname(file)) === "pi-blackhole");
          materialized.config.integration = { ...materialized.config.integration, blackhole_extension: blackhole };
        }
        applyProfile(cwd, materialized);
      }, signal);
      return response(result);
    },
  });
  const scheduleReadiness = (value: ReturnType<typeof readRoadmap> | Awaited<ReturnType<typeof runSchedule>>["readiness"]) => ({
    ready: value.ready.slice(0, 50), ready_total: value.ready.length,
    waiting: Object.fromEntries(Object.entries(value.waiting).slice(0, 20).map(([id, reasons]) => [id, reasons.slice(0, 2).map(r => r.slice(0, 240))])),
    waiting_total: Object.keys(value.waiting).length,
    stale: Object.fromEntries(Object.entries(value.stale).slice(0, 20).map(([id, reasons]) => [id, reasons.slice(0, 2).map(r => r.slice(0, 240))])),
    stale_total: Object.keys(value.stale).length,
    task_status_counts: value.tasks.reduce((counts, task) => { counts[task.status] = (counts[task.status] ?? 0) + 1; return counts; }, {} as Record<string, number>),
    records: ".piccolo/roadmap.json and .piccolo/schedules/ retain full details",
  });
  const scheduleTool = register({ name: "piccolo_schedule", label: "Coordinate a dependency roadmap",
    description: "Inspect or run the project's .piccolo/schedule.toml and roadmap.json. Run admits ready tasks through the configured implementation/review/QA recipe, with persisted claims, bounded parallelism and automatic dependency joins. Durable results require piccolo_jobs export_schedule for roadmap updates; native execution updates the roadmap during the invocation. Do not concurrently edit execution documents. Never replays retained attempts or publishes PRs. Requires workflow.engine=subagents; upstream extensible remains a separate experiment.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("inspect"), Type.Literal("run")]) }),
    async execute(id, params, signal, update, ctx) {
      const root = projectRoot(ctx.cwd);
      if (params.action === "inspect") {
        const result = inspectSchedule(root);
        return response({ plan_digest: result.plan_digest, readiness: scheduleReadiness(result.readiness), claims: result.claims.slice(-50), claims_total: result.claims.length, note: result.note });
      }
      if (workflowEngine !== "subagents") throw new Error("Automatic scheduling currently requires the qualified subagents recipe; select subagents and restart Pi");
      const resolved = background(ctx) ? resolvedFor(ctx) : checkProfile(ctx);
      const result = await runSchedule(root, resolved.digest, async (task, childSignal) => {
        const result = await workflowTool.execute(id, task, childSignal, update, ctx);
        return result.details as ExecutionResult;
      }, signal, () => background(ctx) ? resolvedFor(ctx).digest : loadConfig(root, { contributions }).digest);
      return response({ ...result, outcomes: result.outcomes.slice(-50), outcomes_total: result.outcomes.length,
        error: result.error?.slice(0, 1000), readiness: scheduleReadiness(result.readiness) });
    },
  });
  register({
    name: "piccolo_catalog", label: "Piccolo catalog", description: "List configured agent types, jobs and profiles. Use piccolo_delegate for a task or piccolo_workflow for the implementation/review/QA recipe.",
    parameters: Type.Object({ profile: Type.Optional(Type.String({ description: "Existing profile name, or empty/omitted for inherited configuration." })), overrides_toml: Type.Optional(Type.String({ description: "TOML configuration patch for this catalog invocation. Empty/omitted means no overrides." })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const resolved = loadConfig(projectRoot(ctx.cwd), { profile: params.profile || undefined, contributions, invocation: params.overrides_toml ? parse(params.overrides_toml) : {} });
      return response({ agents: Object.fromEntries(Object.entries(resolved.config.agents ?? {}).map(([name, a]) => [name, { description: a.description, model: a.model, effort: a.effort }])), jobs: resolved.config.jobs, profiles: Object.keys(resolved.config.profiles ?? {}), digest: resolved.digest });
    },
  });
  register({
    name: "piccolo_init", label: "Initialize execution documents", description: "Create missing tracked .piccolo execution templates in this project without replacing existing documents.", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) { return response({ created: initializeRecords(projectRoot(ctx.cwd)) }); },
  });
  const delegateTool = register({
    name: "piccolo_delegate", label: "Delegate a Piccolo task",
    description: "Run a configured agent type using the selected worker executor (Durable by default), with optional invocation overrides. Omit profile unless selecting an existing profile from piccolo_catalog; there is no implicit named default profile. Return concise evidence; the model can report blockers, challenges, or partial work. Preserves native parent selection. For independent implementation, create its worktree first. No automatic remote placement.",
    parameters: Type.Object({ type: Type.String(), task: Type.String(), profile: Type.Optional(Type.String({ description: "Existing profile name; empty/omitted inherits configuration." })), overrides_toml: Type.Optional(Type.String({ description: 'Agent field overrides as TOML, e.g. model = "anthropic/claude-sonnet-5"\neffort = "medium". Only supply intentional overrides. Empty/omitted inherits every field.' })), task_id: Type.Optional(Type.String()), parent_run_id: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _update, ctx) {
      const root = projectRoot(ctx.cwd);
      const overrides = agentSchema.parse(params.overrides_toml ? parse(params.overrides_toml) : {});
      const base = resolvedFor(ctx, { profile: params.profile || undefined, contributions });
      resolveAgent(base, params.type, overrides); // Reject unknown types before applying overrides.
      const resolved = resolvedFor(ctx, { profile: params.profile || undefined, contributions, invocation: { agents: { [params.type]: overrides } } });
      assertProfile(ctx.cwd, resolved);
      const selected = resolveAgent(resolved, params.type);
      const agent = validateAgentRuntime({ ...selected, ...(background(ctx) && !selected.effort ? { effort: thinking(ctx) } : {}) }, ctx);
      const run = startRun(root, { type: params.type, task: params.task, cwd: ctx.cwd, task_id: params.task_id || undefined, parent_run_id: params.parent_run_id || undefined, resolved, agent, runtime: runtimeSnapshot(ctx.cwd, VERSION), parent: { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, effort: thinking(ctx) } });
      try {
        const extensions = ((ctx as any).piccoloExperimentExtensions ?? profileChildExtensions(ctx.cwd, resolved)).map((file: string) => {
          if (!path.isAbsolute(file)) throw new Error("integration.child_extensions requires absolute paths");
          return file;
        });
        const result = boundNative(root, run.id, await runDelegate(pi, ctx, agent, params.task, run.id, extensions, signal, resolved.config.pool), resolved.config.evidence?.max_return_chars);
        const record = run.finish({ status: result.status, native: result });
        return response({ run_id: run.id, status: result.status, record, result: result.result, artifact: result.raw_artifact, error: result.error, model: result.model, effort: result.thinking });
      } catch (error) {
        const record = run.finish({ status: "execution_error", error: String(error) });
        return { ...response({ run_id: run.id, status: "execution_error", record, error: String(error) }), isError: true };
      }
    },
  });
  const experimentTool = register({
    name: "piccolo_experiment", label: "Run reproducible experiment",
    description: "Execute a bounded TOML experiment through the configured worker executor with fresh retained worktrees. Prefer piccolo_submit kind=experiment for nonblocking session-owned execution. Every invocation creates a new request; saved Durable requests use Jobs recovery. Completed means measurement finished, not quality passed. CLI experiment report/assess/compare inspects retained records.",
    parameters: Type.Object({ spec: Type.String({ description: "Path to experiment TOML; captured at submission." }) }),
    async execute(_id, params, signal, update, ctx) {
      const root = projectRoot(ctx.cwd);
      if (!background(ctx)) throw new Error("Use piccolo_submit kind=experiment so trials have session ownership and submission-time snapshots");
      if (workflowEngine !== "subagents") throw new Error("Experiments currently require the subagents engine");
      const plan: Plan = (ctx as any).piccoloExperimentPlan ?? readExperiment(path.resolve(root, params.spec));
      const provenance = { runtime: runtimeSnapshot(ctx.cwd, VERSION), parent: { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, effort: thinking(ctx) }, resolved: resolvedFor(ctx) };
      const result = await runExperiment(root, plan, provenance, async (trial, workspace, branch, base, trialSignal) => {
        const args = experimentTrialArguments(plan, trial, workspace, branch, base);
        update?.(response({ trial, status: "starting" }));
        let config;
        let trialExtensions: string[] | undefined;
        if (trial.kind === "delegate") {
          const a = args as any;
          const overrides = agentSchema.parse(a.overrides_toml ? parse(a.overrides_toml) : {});
          config = resolvedFor(ctx, { profile: a.profile, invocation: { agents: { [a.type]: overrides } } });
          const selected = resolveAgent(config, a.type);
          if (selected.context === "fork") throw new Error("Experiments require fresh context; fork would contaminate repeated trials");
          assertProfile(ctx.cwd, config);
          preflightBaseIgnores(root, base);
          git(root, "worktree", "add", "--detach", workspace, base);
          trialExtensions = profileChildExtensions(ctx.cwd, config);
          const materialized = structuredClone(config);
          if (config.config.compaction?.owner === "blackhole") {
            const blackhole = trialExtensions.find(file => path.basename(path.dirname(file)) === "pi-blackhole");
            materialized.config.integration = { ...materialized.config.integration, blackhole_extension: blackhole };
          }
          applyProfile(workspace, materialized);
        } else config = resolvedFor(ctx, { invocation: workflowInvocation(args) });
        let uncertain = false;
        const trialContext = Object.create(ctx, { piccoloExperimentUncertain: { value: () => { uncertain = true; } } });
        const child = trial.kind === "delegate" ? Object.create(trialContext, { cwd: { value: workspace }, piccoloChildTarget: { value: `experiment/${trial.id}` }, piccoloExperimentExtensions: { value: trialExtensions }, piccoloCoordinator: { value: false } }) : trialContext;
        const tool = trial.kind === "delegate" ? delegateTool : workflowTool;
        const out = await (tool as ToolDefinition<any>).execute(_id, args, trialSignal, update, child);
        const data = out.details as any;
        const sourceChanged = trial.kind === "delegate" && (git(workspace, "rev-parse", "HEAD") !== base || !!git(workspace, "status", "--porcelain", "--", ":(exclude).piccolo"));
        let metrics;
        let metricError: string | null = null;
        try { metrics = experimentMetrics(root, data, trial.kind); } catch (error) { metricError = String(error); }
        return { status: uncertain ? "unresolved" : sourceChanged ? "source_changed" : data?.status ?? "execution_error", result: data, metrics,
          provenance: { resolved: config, observed_model: data?.model ?? null, observed_effort: data?.effort ?? null, run_record: data?.record ?? null, source_changed: sourceChanged, metric_error: metricError } };
      }, signal, (ctx as any).piccoloExperimentBase);
      return response({ status: result.status, id: result.id, record: result.record, groups: result.report.groups, qualification: "comparison_only" });
    },
  });
  const tools = { delegate: delegateTool, workflow: workflowTool, schedule: scheduleTool, experiment: experimentTool };
  const jobInterface = await registerJobs(pi, { delegate: delegateTool.parameters, workflow: workflowTool.parameters, schedule: scheduleTool.parameters, experiment: experimentTool.parameters }, (kind, params, ctx, host) => {
    const root = projectRoot(ctx.cwd);
    const resolve = captureConfig(root, { contributions });
    const resolved = resolve();
    let submittedResolved = resolved;
    const target = host ? resolved.config.hosts?.[host] : undefined;
    if (host && (!target?.worker_identity || !target.worker_transport)) throw new Error("Named host requires worker_identity and worker_transport for Durable Jobs");
    assertProfile(ctx.cwd, resolved);
    if (kind !== "delegate" && workflowEngine !== "subagents" && !host && resolved.config.background?.executor !== "durable") throw new Error("Background workflows and schedules currently require workflow.engine=subagents");
    if (kind === "schedule" && params.action !== "run") throw new Error("Use piccolo_schedule inspect directly; only execution is submitted");
    const effort = pi.getThinkingLevel();
    const model = ctx.model;
    const inputs = structuredClone(params);
    const agents: Record<string, unknown> = {};
    const configs: Record<string, ReturnType<typeof resolve>> = {};
    const checkAgent = (config: ReturnType<typeof resolve>, type: string, key: string) => {
      const agent = resolveAgent(config, type);
      agents[key] = host ? { ...agent, model: agent.model ?? (model ? `${model.provider}/${model.id}` : undefined), effort: agent.effort ?? effort } : validateAgentRuntime({ ...agent, effort: agent.effort ?? effort }, ctx);
    };
    const checkWorkflow = (parameters: any, prefix: string) => {
      const config = resolve({ invocation: workflowInvocation(parameters) });
      configs[prefix] = config;
      for (const [stage, value] of Object.entries(validateRecipe(config, parameters.job || "implementation")))
        for (const type of value.agents ?? []) checkAgent(config, type, `${prefix}/${stage}/${type}`);
      return config;
    };
    let schedule: ReturnType<typeof readSchedule> | undefined;
    let experiment: Plan | undefined;
    const experimentBase = kind === "experiment" ? git(root, "rev-parse", "HEAD") : undefined;
    if (kind === "delegate") {
      const override = agentSchema.parse(inputs.overrides_toml ? parse(inputs.overrides_toml) : {});
      resolveAgent(resolve({ profile: inputs.profile || undefined }), inputs.type, override);
      const config = resolve({ profile: inputs.profile || undefined, invocation: { agents: { [inputs.type]: override } } });
      checkAgent(config, inputs.type, "delegate");
      submittedResolved = config;
    } else if (kind === "experiment") {
      experiment = readExperiment(path.resolve(root, inputs.spec));
      for (const trial of experiment.trials) {
        const parameters: any = experimentTrialArguments(experiment, trial, "/preflight", "experiment/preflight", "HEAD");
        if (trial.kind === "workflow") {
          if (experiment.manifest.variants[trial.variant].profile) throw new Error("Workflow experiment profile is selected by the owning session, not per trial");
          const cfg = checkWorkflow(parameters, trial.id); assertProfile(ctx.cwd, cfg);
          for (const stage of Object.values(validateRecipe(cfg, parameters.job || "implementation")))
            for (const type of stage.agents ?? []) if (resolveAgent(cfg, type).context === "fork") throw new Error("Experiments require fresh context");
        } else {
          const override = agentSchema.parse(parameters.overrides_toml ? parse(parameters.overrides_toml) : {});
          const cfg = resolve({ profile: parameters.profile, invocation: { agents: { [parameters.type]: override } } });
          if (resolveAgent(cfg, parameters.type).context === "fork") throw new Error("Experiments require fresh context");
          configs[trial.id] = cfg;
          checkAgent(cfg, parameters.type, trial.id); assertProfile(ctx.cwd, cfg);
        }
      }
    } else if (kind === "workflow") submittedResolved = checkWorkflow(inputs, "workflow");
    else { schedule = readSchedule(root); for (const [id, task] of Object.entries(schedule.tasks)) checkWorkflow(task, id); }
    assertProfile(ctx.cwd, submittedResolved);
    const shared = Object.values(agents).some((agent: any) => agent.context === "fork") ? captureMessages(ctx) : [];
    const capturedContext = Object.create(ctx, { model: { value: model } });
    return {
      settings: host ? { ...submittedResolved.config.background, executor: "durable" } : submittedResolved.config.background,
      ...(target ? { target: { workspace: { host: target.hostname, cwd: target.cwd, identity: target.worker_identity! }, transport: target.worker_transport! } } : {}),
      snapshot: { kind, arguments: inputs, resolved: submittedResolved, agents, configs, parent: { model: model ? `${model.provider}/${model.id}` : undefined, effort, cwd: fs.realpathSync(ctx.cwd) }, context_digest: digest(shared), context_messages: shared.length,
        ...((host || submittedResolved.config.background?.executor === "durable") ? { context: shared.map(message => message.role === "system" ? { role: message.role, content: message.content, timestamp: message.timestamp } : message) } : {}),
        schedule, experiment, experimentBase },
      execute: async execution => {
        if (schedule && digest(readSchedule(root)) !== digest(schedule)) throw new Error("Schedule changed after submission");
        const frozen = withBackground(capturedContext, { resolve, effort, shared, execution });
        if (experiment) Object.defineProperties(frozen, { piccoloExperimentPlan: { value: experiment }, piccoloExperimentBase: { value: experimentBase } });
        const tool = tools[kind] as ToolDefinition<any>;
        const result = await tool.execute(execution.id, inputs, execution.signal, value => execution.event({ kind: "progress", value: value.details }), frozen);
        return result.details;
      },
    };
  }, ctx => loadConfig(projectRoot(ctx.cwd), { contributions }).config);

}
