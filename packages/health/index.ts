import { healthRenderers, healthMessageRenderer } from "./src/display.ts";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { AgentSession, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HealthMonitor, type HealthObservation } from "./src/monitor.ts";
import { loadHealthConfig, selectsManagedWake, type HealthConfig } from "./src/config.ts";
import { classifyFailure, diagnose, type Diagnosis } from "./src/diagnostics.ts";
import { requestParentWake, hasParentWake, registerManagedWake } from "./src/wake.ts";
import { installManagedWake } from "./src/managed-wake.ts";

export const INSPECT = "pi-harness-health:inspect:v1";
export const CLAIM = "pi-harness-health:attention-owner:v1";
export type HealthInspection = {
  sessionId: string; config?: unknown;
  phase?: "configuration" | "active";
  resolved?: Readonly<{ tool_ms: number }>;
  observations?: Array<HealthObservation & { reference?: { kind: "job"; id: string } }>;
  expectations?: Array<HealthObservation & { deadline: number; reference?: { kind: "job"; id: string } }>;
};
type Dependencies = {
  config?: (ctx: ExtensionContext, inspection: HealthInspection) => HealthConfig;
  directory?: (ctx: ExtensionContext) => string;
  wake?: typeof requestParentWake;
  diagnose?: typeof diagnose;
  now?: () => number;
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const handled = new Set(["resolved", "superseded"]);

/** Standalone package. Integrations publish categorical observations; never raw task/log content. */
export function registerHealth(pi: ExtensionAPI, dependencies: Dependencies = {}) {
  pi.registerMessageRenderer("harness-health-status", healthMessageRenderer);
  const now = dependencies.now ?? Date.now;
  let ctx: ExtensionContext | undefined, monitor: HealthMonitor | undefined, settings: HealthConfig | undefined;
  let timer: ReturnType<typeof setInterval> | undefined, diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = true, ticking = false, diagnosticRunning = false, diagnosticCalls = 0, nextDiagnostic = 0;
  let diagnosticAbort: AbortController | undefined, lastDiagnosis: { at: number; result: Diagnosis } | undefined;
  let storageFailed = false, sequence = 0, diagnosticDisabled = false;
  let recordingFailure: "local_health" | "native_session" | undefined;
  // Installation belongs to the process; permission to use it belongs to this
  // live monitor's configuration. Do not revoke another SDK session's adapter.
  const allowManagedWake = () => !closed && !storageFailed && settings?.enabled === true && selectsManagedWake(settings.compatibility, VERSION);
  let lastTickAt = 0;
  let pendingWake: string | undefined, recoveryTurn: string | undefined;
  let compaction: string | undefined;
  const observed = new Set<string>(), expected = new Set<string>();
  const references = new Map<string, { kind: "job"; id: string }>();
  const tools = new Map<string, string>();
  const warn = (message: string) => {
    // UI reporting must not throw while handling an independent recording fault.
    try { if (ctx?.hasUI) ctx.ui.notify(message, "warning"); } catch { /* Retain status/ledger evidence. */ }
  };
  const inspection = (phase: "configuration" | "active"): HealthInspection => {
    const request: HealthInspection = { sessionId: ctx!.sessionManager.getSessionId(), phase,
      ...(phase === "active" && settings ? { resolved: Object.freeze({ tool_ms: settings.tool_ms }) } : {}) };
    pi.events.emit(INSPECT, request);
    return request;
  };
  const facts = (history = false, id?: string) => {
    const all = monitor?.list({ includeHistory: history }) ?? [];
    const selected = id ? all.filter(incident => incident.id === id) : all;
    return ({
    scope: "harness-only", active: !closed, storage_failed: storageFailed, recording_failure: recordingFailure,
    parent_idle: !closed && !!ctx && ctx.isIdle(),
    recovery: settings?.recovery, diagnostic_enabled: settings?.diagnostic.enabled,
    wake_capability: !!ctx && hasParentWake(ctx, allowManagedWake()), compatibility: settings?.compatibility,
    diagnostic_calls: diagnosticCalls, diagnostic_running: diagnosticRunning, diagnostic_disabled: diagnosticDisabled, last_diagnosis: lastDiagnosis,
    incidents_total: all.length, incidents_truncated: selected.length > 100,
    incidents: selected.slice(0, 100).map(i => ({ ...i, reference: references.get(i.source) })),
  }); };
  const redraw = () => {
    try {
      if (!ctx?.hasUI) return;
      const all = monitor?.list() ?? [];
      const open = all.filter(i => !handled.has(i.disposition)).length;
      ctx.ui.setStatus("harness-health", closed ? undefined : `health ${storageFailed ? "recording failed" : `${open} unresolved`} | /harness-health`);
    } catch { /* UI availability does not change the retained monitor state. */ }
  };
  const failure = (category: "local_health" | "native_session" = "local_health") => {
    const first = !storageFailed;
    storageFailed = true; diagnosticDisabled = true; recordingFailure ??= category;
    if (first) warn("Harness health recording failed; automatic recovery is disabled. Inspect harness health and native session records.");
    redraw();
  };
  const appendEntry = (type: string, value: unknown, instance = monitor): boolean => {
    if (!instance || instance !== monitor || storageFailed) return false;
    try { pi.appendEntry(type, value); return instance === monitor && !storageFailed; }
    catch {
      if (instance !== monitor) return false;
      // The native session recorder is an independent sink. Do not ask that
      // failing sink to record its own failure or copy its possibly private error.
      try {
        const incident = instance.observe({ source: `native-session-recording:${type}`, component: "monitor", code: "accounting_mismatch" });
        instance.disposition(incident.id, "development", { reason: "development_fix" });
      } catch { /* Both sinks may be unavailable; in-memory degraded state remains. */ }
      failure("native_session");
      return false;
    }
  };
  const observe = (signal: HealthObservation) => {
    if (closed || !monitor || storageFailed) return;
    try { monitor.observe(signal); redraw(); } catch { failure(); }
  };
  const finishExpectation = (source: string) => { if (monitor && !storageFailed) try { monitor.complete(source); } catch { failure(); } };
  const healthDiagnostic = async () => {
    if (closed || !monitor || !settings || !ctx || !settings.diagnostic.enabled || diagnosticRunning || diagnosticDisabled || storageFailed || diagnosticCalls >= settings.diagnostic.max_calls) return;
    diagnosticRunning = true; diagnosticCalls++; nextDiagnostic = now() + settings.diagnostic.interval_ms;
    const instance = monitor, context = ctx, config = settings;
    const controller = new AbortController(); diagnosticAbort = controller;
    // One reserved diagnostic call, no tools, no extensions, no project history,
    // and no ordinary worker-pool acquisition. A saturated work pool cannot starve it.
    diagnosticTimer = setTimeout(() => controller.abort(), config.diagnostic.timeout_ms);
    try {
      const request = (dependencies.diagnose ?? diagnose)(context, config.diagnostic, {
        expected: { owner: "existing Pi process", recovery: config.recovery, attention_ms: config.attention_ms, compaction_ms: config.compaction_ms },
        observations: facts(),
      }, controller.signal);
      // An uncooperative provider cannot block deterministic checks or launch a
      // replacement diagnosis on top of a potentially still-running request.
      let abortListener!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(new Error("Diagnosis interrupted"));
        controller.signal.addEventListener("abort", abortListener, { once: true });
        if (controller.signal.aborted) abortListener();
      });
      const result = await Promise.race([request, aborted]).finally(() => controller.signal.removeEventListener("abort", abortListener));
      if (!closed && monitor === instance && !controller.signal.aborted) {
        // Diagnostics are advisory. They cannot mark observed failures recovered.
        const completed = { at: now(), result };
        if (appendEntry("harness-health-diagnosis", completed, instance)) lastDiagnosis = completed;
        // Advice describes existing facts; a non-healthy assessment is not a
        // diagnostic execution failure and must not manufacture another wake.
      }
    } catch (error) {
      if (!closed && monitor === instance) {
        if (controller.signal.aborted) diagnosticDisabled = true;
        observe({ source: "diagnostic-inference", component: "monitor", code: "diagnosis_failed" });
        appendEntry("harness-health-diagnostic-failure", { at: now(), category: controller.signal.aborted ? "timeout" : error instanceof TypeError ? "api_contract" : error instanceof SyntaxError ? "response_syntax" : "inference_or_response_contract" }, instance);
      }
    } finally {
      if (monitor === instance) {
        if (diagnosticTimer) clearTimeout(diagnosticTimer);
        diagnosticTimer = undefined; diagnosticAbort = undefined; diagnosticRunning = false;
      }
    }
  };
  const tick = async () => {
    if (closed || ticking || !ctx || !monitor || !settings || storageFailed) return;
    ticking = true;
    const instance = monitor, context = ctx;
    try {
      if (lastTickAt && now() - lastTickAt > Math.max(settings.interval_ms * 3, 60000))
        monitor.observe({ source: "monitor-schedule", component: "monitor", code: "monitor_overdue" });
      lastTickAt = now();
      const snapshot = inspection("active");
      const pending = new Set<string>();
      for (const item of snapshot.observations?.slice(0, 1000) ?? []) {
        const key = `${item.source}:${item.component}:${item.code}`;
        if (observed.has(key)) continue;
        monitor.observe(item); observed.add(key);
        if (item.reference?.kind === "job" && /^[a-f0-9-]{36}$/.test(item.reference.id)) {
          references.set(hash(item.source), item.reference);
          if (!appendEntry("harness-health-reference", { source: hash(item.source), reference: item.reference }, instance)) return;
        }
      }
      for (const item of snapshot.expectations?.slice(0, 1000) ?? []) {
        pending.add(item.source); if (!expected.has(item.source)) monitor.expect(item);
        if (item.reference?.kind === "job" && /^[a-f0-9-]{36}$/.test(item.reference.id)) references.set(hash(item.source), item.reference);
      }
      for (const source of expected) if (!pending.has(source)) monitor.complete(source);
      expected.clear(); for (const source of pending) expected.add(source);
      for (const action of monitor.tick({ dispatch: context.isIdle() && settings.recovery === "wake" })) {
        if (closed || monitor !== instance) break;
        if (settings.recovery === "observe") { monitor.recordAction(action.id, "unsupported"); continue; }
        const incident = monitor.list().find(i => i.id === action.incidentId)!;
        const reference = references.get(incident.source);
        const content = `[Harness health ${action.id}] Inspect harness_health status with id ${incident.id}. Observed ${incident.component}/${incident.code}.${reference ? ` Affected session job: ${reference.id}; inspect its status/result.` : ""} Decide how to handle it, then record a disposition with harness_health. Notification delivery is not resolution. Do not replay ambiguous project operations.`;
        const receipt = (dependencies.wake ?? requestParentWake)(context, { sessionId: context.sessionManager.getSessionId(), id: action.id, content }, allowManagedWake());
        monitor.recordAction(action.id, receipt.status === "accepted" ? "delivered" : receipt.status === "unsupported" ? "unsupported" : receipt.status === "busy" ? "busy" : "failed");
        if (receipt.status === "unsupported") warn("Harness health detected work requiring attention, but safe parent wake is unavailable. Inspect /harness-health; unattended recovery is degraded.");
      }
      redraw();
      if (now() >= nextDiagnostic) void healthDiagnostic().catch(() => {
        // Last-resort containment for scheduled work; never affect a replacement runtime.
        if (!closed && monitor === instance) failure();
      });
    } catch { failure(); }
    finally { ticking = false; }
  };
  const close = () => {
    closed = true; if (timer) clearInterval(timer); timer = undefined;
    if (diagnosticTimer) clearTimeout(diagnosticTimer); diagnosticTimer = undefined;
    diagnosticAbort?.abort(); diagnosticAbort = undefined; diagnosticRunning = false; pendingWake = undefined; recoveryTurn = undefined;
    monitor?.close(); monitor = undefined;
    observed.clear(); expected.clear(); tools.clear(); references.clear();
    compaction = undefined; redraw();
  };
  pi.on("session_start", (_event, context) => {
    close(); ctx = context; storageFailed = false; recordingFailure = undefined;
    try {
      const data = inspection("configuration");
      settings = dependencies.config?.(context, data) ?? loadHealthConfig(context.cwd, context.isProjectTrusted(), data.config);
      if (!settings.enabled) return;
      if (selectsManagedWake(settings.compatibility, VERSION)) registerManagedWake(installManagedWake(AgentSession, VERSION));
      monitor = new HealthMonitor({
        directory: dependencies.directory?.(context) ?? path.join(process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME) ? process.env.XDG_STATE_HOME : path.join(os.homedir(), ".local/state"), "pi-harness-health", hash(context.cwd)),
        session: context.sessionManager.getSessionId(), now,
        acknowledgementMs: settings.attention_ms, maxAttempts: settings.max_attempts, maxActionsPerRuntime: settings.max_wakes, baseRetryMs: settings.retry_ms,
      });
      diagnosticCalls = 0; diagnosticRunning = false; diagnosticDisabled = false; lastDiagnosis = undefined;
      lastTickAt = now();
      nextDiagnostic = now() + settings.diagnostic.interval_ms;
      if (!appendEntry("harness-health-start", { format: 1, package: "pi-harness-health", version: "0.1.3", pi: VERSION, config_digest: hash(JSON.stringify(settings)), runtime: monitor.runtime, diagnostic_api_available: typeof context.modelRegistry.complete === "function" })) return;
      closed = false; timer = setInterval(() => { void tick(); }, settings.interval_ms); timer.unref(); redraw();
    } catch { failure(); }
  });
  pi.on("session_shutdown", close);
  pi.on("session_before_compact", () => {
    if (closed || !monitor || !settings || storageFailed) return;
    compaction = `compaction:${randomUUID()}`;
    try { monitor.expect({ source: compaction, component: "compaction", code: "compaction_overdue", deadline: now() + settings.compaction_ms }); } catch { failure(); }
  });
  pi.on("session_compact", () => { if (compaction) finishExpectation(compaction); compaction = undefined; });
  pi.on("session_compact_failed", event => {
    if (compaction) finishExpectation(compaction);
    if (!event.aborted) observe({ source: "compaction-failure", component: "compaction", code: "compaction_failed" });
    compaction = undefined;
  });
  pi.on("message_end", event => {
    const message = event.message;
    if (message.role === "user" && recoveryTurn) {
      const text = typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (!text.startsWith(`[Harness health ${recoveryTurn}]`)) recoveryTurn = undefined;
    }
    if (message.role === "assistant" && message.stopReason === "error" &&
        !["The operation was aborted.", "This operation was aborted", "Request was aborted."].includes(message.errorMessage ?? "")) observe({ source: `parent-endpoint:${message.provider}/${message.model}`, component: "endpoint", code: classifyFailure(message.errorMessage) });
  });
  pi.on("tool_execution_start", event => {
    if (closed || !monitor || !settings || storageFailed || event.toolName === "harness_health") return;
    const source = `tool:${event.toolCallId}`; tools.set(event.toolCallId, source);
    try { monitor.expect({ source, component: "worker", code: "deadline_expired", deadline: now() + settings.tool_ms }); } catch { failure(); }
  });
  pi.on("tool_execution_end", event => {
    const source = tools.get(event.toolCallId); if (source) finishExpectation(source); tools.delete(event.toolCallId);
    const errorText = event.result?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";
    const interrupted = ["Operation aborted", "The operation was aborted.", "Command aborted"].includes(errorText)
      || (event.toolName === "bash" && errorText.endsWith("\n\nCommand aborted"));
    if (event.isError && !interrupted && recoveryTurn) {
      // A failed inspection belongs to the existing recovery attempt. Creating a
      // fresh incident per toolCallId would restart the budget indefinitely.
      appendEntry("harness-health-recovery-failure", { action: recoveryTurn, at: now(), code: "worker_failed" });
      return;
    }
    if (event.isError && !interrupted && event.toolName !== "harness_health") observe({ source: `tool:${event.toolCallId}`, component: "worker", code: "worker_failed" });
  });
  pi.on("before_agent_start", event => {
    const action = event.messageType === "custom" ? undefined : /^\[Harness health ([a-f0-9-]{36})\]/.exec(event.prompt)?.[1];
    pendingWake = action && monitor?.list().some(incident => incident.actions.some(receipt => receipt.id === action)) ? action : undefined;
  });
  pi.on("agent_start", () => {
    sequence++; recoveryTurn = pendingWake;
    if (pendingWake) { appendEntry("harness-health-parent-start", { action: pendingWake, at: now() }); pendingWake = undefined; }
  });
  pi.on("agent_end", () => { recoveryTurn = undefined; });
  pi.events.on(CLAIM, (request: any) => {
    // Do not suppress ordinary notices until the package can actually recover.
    if (!closed && !storageFailed && settings?.recovery === "wake" && ctx && request.sessionId === ctx.sessionManager.getSessionId())
      request.claimed = hasParentWake(ctx, allowManagedWake());
  });
  pi.registerTool({
    name: "harness_health", label: "Harness health", ...healthRenderers,
    description: "Inspect harness-only health incidents and explicitly record handling, deferral, verified resolution, or a development finding. This does not run project tasks or restart Pi. A wake receipt is not resolution.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("status"), Type.Literal("check"), Type.Literal("disposition")]),
      id: Type.Optional(Type.String()),
      disposition: Type.Optional(Type.Union([Type.Literal("handling"), Type.Literal("deferred"), Type.Literal("resolved"), Type.Literal("development"), Type.Literal("superseded")])),
      reason: Type.Optional(Type.Union([Type.Literal("parent_inspecting"), Type.Literal("retry_later"), Type.Literal("verified_recovery"), Type.Literal("user_action"), Type.Literal("development_fix"), Type.Literal("superseded")])),
      until: Type.Optional(Type.Number()), history: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, args) {
      if (args.action === "check") await tick();
      if (args.action === "disposition") {
        if (!monitor || !args.id || !args.disposition || !args.reason) throw new Error("Supply a current incident id, disposition, and reason");
        monitor.disposition(args.id, args.disposition, { reason: args.reason, until: args.until }); redraw();
      }
      const result = facts(args.history, args.action === "status" ? args.id : undefined);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerCommand("harness-health", {
    description: "Inspect harness health; check reconciles, diagnose runs the configured bounded diagnostic agent",
    handler: async (args, context) => {
      if (args.trim() === "check") await tick();
      else if (args.trim() === "diagnose") await healthDiagnostic();
      else if (args.trim() && args.trim() !== "status") throw new Error("Use /harness-health [status|check|diagnose]");
      if (!context.hasUI) { pi.sendMessage({ customType: "harness-health-status", content: JSON.stringify(facts()), display: true }, { triggerTurn: false }); return; }
      const entries = monitor?.list() ?? [];
      const selection = await context.ui.select(`Harness health — ${closed ? "inactive" : "active"}; Esc closes`, entries.map(i => `${i.id.slice(0, 12)} ${i.component}/${i.code} ${i.disposition}`));
      const selected = entries.find(i => selection?.startsWith(i.id.slice(0, 12)));
      if (selected) pi.sendMessage({ customType: "harness-health-status", content: JSON.stringify({ ...selected, reference: references.get(selected.source) }, null, 2), display: true }, { triggerTurn: false });
    },
  });
  return { tick, close, facts, diagnostic: healthDiagnostic, parentTurns: () => sequence };
}

export default function health(pi: ExtensionAPI) { registerHealth(pi); }
