import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { registerHealth, INSPECT, type HealthInspection } from "../packages/health/index.ts";
import { resolveHealthConfig } from "../packages/health/src/config.ts";
import type { Diagnosis } from "../packages/health/src/diagnostics.ts";
import type { WakeRequest, WakeReceipt } from "../packages/health/src/wake.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(options: {
  config?: unknown;
  wake?: (context: unknown, request: WakeRequest) => WakeReceipt;
  diagnose?: (...args: any[]) => Promise<Diagnosis>;
  appendEntry?: (type: string, value: unknown) => void;
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-health-package-"));
  let clock = 100_000;
  const handlers = new Map<string, Function[]>(), commands = new Map<string, any>(), tools = new Map<string, any>();
  const events = new EventEmitter(), wakes: WakeRequest[] = [], entries: unknown[] = [];
  const snapshot: HealthInspection = { sessionId: "test-session", observations: [], expectations: [] };
  events.on(INSPECT, request => Object.assign(request, structuredClone(snapshot)));
  const config = resolveHealthConfig([{ interval_ms: 1000, attention_ms: 1000, retry_ms: 1000,
    compaction_ms: 1000, tool_ms: 1000 }, options.config ?? {}]);
  const context: any = { cwd: directory, hasUI: false, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => snapshot.sessionId }, ui: {}, modelRegistry: {} };
  const pi: any = { events, on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerMessageRenderer() {}, registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool), appendEntry: (type: string, value: unknown) => {
      options.appendEntry?.(type, value); entries.push([type, value]);
    }, sendMessage: () => {} };
  const monitor = registerHealth(pi, { config: () => config, directory: () => directory, now: () => clock,
    wake: (ctx, request) => { wakes.push(request); return options.wake?.(ctx, request) ?? { id: request.id, status: "accepted" }; },
    diagnose: options.diagnose ?? (async () => { throw new Error("Unexpected diagnostic inference"); }) });
  const emit = async (name: string, payload: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(payload, context); };
  return { directory, snapshot, monitor, wakes, entries, context, emit, commands,
    advance: (ms: number) => { clock += ms; },
    execute: (args: unknown) => tools.get("harness_health").execute("test-tool", args),
    clean: () => { monitor.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test("scheduled snapshots discover a lost completion callback and require explicit parent disposition", async () => {
  const f = fixture();
  try {
    await f.emit("session_start");
    f.snapshot.observations = [{ source: "completed-job", component: "attention", code: "unacknowledged",
      reference: { kind: "job", id: "12345678-1234-1234-1234-123456789abc" } }];
    assert.equal(f.monitor.facts().incidents.length, 0);
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.equal(f.wakes.length, 1, "scheduled check needs no user prompt or callback");
    const [incident] = f.monitor.facts().incidents;
    assert.equal(incident.disposition, "open");
    assert.match(f.wakes[0].content, /Affected session job: 12345678/);
    assert.equal(incident.actions[0].result, "delivered");
    await f.execute({ action: "disposition", id: incident.id, disposition: "resolved", reason: "verified_recovery" });
    f.advance(10_000); await f.monitor.tick();
    assert.equal(f.wakes.length, 1);
    assert.equal(f.monitor.facts().incidents[0].count, 1, "snapshot replay is not another occurrence");
    assert.equal(f.monitor.facts().incidents[0].disposition, "resolved");
  } finally { f.clean(); }
});

test("native compaction, endpoint and tool signals remain categorical without leaking raw errors", async () => {
  const f = fixture();
  const secret = "secret.invalid/path?api_key=SUPER-SECRET-TOKEN";
  try {
    await f.emit("session_start");
    await f.emit("session_before_compact");
    f.advance(1000); await f.monitor.tick();
    await f.emit("session_compact_failed", { aborted: false, error: secret });
    for (const errorMessage of [`401 unauthorized ${secret}`, `429 rate limit ${secret}`, `ECONNRESET ${secret}`]) {
      await f.emit("message_end", { message: { role: "assistant", stopReason: "error", provider: secret, model: "model", errorMessage } });
    }
    await f.emit("tool_execution_start", { toolCallId: "safe-tool", toolName: "bash" });
    await f.emit("tool_execution_end", { toolCallId: "safe-tool", toolName: "bash", isError: true, result: secret });
    const codes = new Set(f.monitor.facts().incidents.map(i => i.code));
    for (const code of ["compaction_overdue", "compaction_failed", "authentication", "rate_limit", "transport", "worker_failed"])
      assert.ok(codes.has(code as any), `missing ${code}`);
    const persisted = fs.readdirSync(f.directory).filter(n => n.endsWith(".json")).map(n => fs.readFileSync(path.join(f.directory, n), "utf8")).join("");
    assert.equal(persisted.includes(secret), false);
    assert.equal(JSON.stringify(f.monitor.facts()).includes(secret), false);
    assert.equal(JSON.stringify(f.wakes).includes(secret), false);
  } finally { f.clean(); }
});

test("completed/cancelled native operations clear deadlines; health tool failures do not self-recurse", async () => {
  const f = fixture();
  try {
    await f.emit("session_start");
    await f.emit("session_before_compact"); await f.emit("session_compact");
    await f.emit("session_before_compact"); await f.emit("session_compact_failed", { aborted: true });
    await f.emit("tool_execution_start", { toolCallId: "ok", toolName: "read" });
    await f.emit("tool_execution_end", { toolCallId: "ok", toolName: "read", isError: false });
    await f.emit("tool_execution_start", { toolCallId: "own", toolName: "harness_health" });
    await f.emit("tool_execution_end", { toolCallId: "own", toolName: "harness_health", isError: true });
    f.advance(5000); await f.monitor.tick();
    assert.equal(f.monitor.facts().incidents.length, 0); assert.equal(f.wakes.length, 0);
  } finally { f.clean(); }
});

test("diagnostic inference failures retain deterministic findings and obey the independent call budget", async () => {
  let calls = 0;
  const f = fixture({ config: { diagnostic: { enabled: true, model: "test/cheap", interval_ms: 1000, max_calls: 2 } },
    diagnose: async () => { calls++; throw new Error("Bearer PRIVATE-DIAGNOSTIC-TOKEN"); } });
  try {
    await f.emit("session_start");
    f.snapshot.observations = [{ source: "provider", component: "endpoint", code: "unavailable" }];
    f.advance(1000); await f.monitor.tick(); await flush();
    assert.equal(calls, 1);
    assert.ok(f.monitor.facts().incidents.some(i => i.code === "unavailable"));
    assert.ok(f.monitor.facts().incidents.some(i => i.code === "diagnosis_failed"));
    await f.monitor.tick(); await flush(); assert.equal(calls, 1, "no recursive immediate inference retry");
    f.advance(1000); await f.monitor.tick(); await flush(); assert.equal(calls, 2);
    f.advance(10_000); await f.monitor.tick(); await f.monitor.diagnostic(); assert.equal(calls, 2);
    assert.equal(f.monitor.facts().diagnostic_running, false);
    assert.equal(JSON.stringify(f.monitor.facts()).includes("PRIVATE-DIAGNOSTIC-TOKEN"), false);
  } finally { f.clean(); }
});

test("disabled diagnostics never run, including explicit requests", async () => {
  let calls = 0;
  const f = fixture({ diagnose: async () => { calls++; return { assessment: "healthy", confidence: "low" }; } });
  try {
    await f.emit("session_start"); f.advance(2_000_000);
    await f.monitor.tick(); await f.monitor.diagnostic();
    await f.commands.get("harness-health").handler("diagnose", f.context);
    assert.equal(calls, 0); assert.equal(f.monitor.facts().diagnostic_calls, 0);
  } finally { f.clean(); }
});

for (const outcome of ["success", "failure"] as const) {
  test(`scheduled diagnostic ${outcome} recording failure is contained without recursive logging`, async () => {
    let calls = 0, appendFailures = 0;
    const privateError = "NATIVE-RECORDING-PRIVATE-DETAIL";
    const f = fixture({ config: { diagnostic: { enabled: true, model: "test/cheap", interval_ms: 1000 } },
      diagnose: async () => { calls++; if (outcome === "failure") throw new Error("PRIVATE-MODEL-ERROR");
        return { assessment: "healthy", confidence: "low" }; },
      appendEntry: type => {
        if (type === "harness-health-diagnosis" || type === "harness-health-diagnostic-failure") {
          appendFailures++; throw new Error(privateError);
        }
      } });
    try {
      await f.emit("session_start");
      // Also exercise secondary UI failures while the recording error is handled.
      f.context.hasUI = true;
      f.context.ui.notify = () => { throw new Error("UI unavailable"); };
      f.context.ui.setStatus = () => { throw new Error("UI unavailable"); };
      f.advance(1000);
      await new Promise(resolve => setTimeout(resolve, 1150));
      await flush();
      const status = f.monitor.facts();
      assert.equal(status.storage_failed, true); assert.equal(status.recording_failure, "native_session");
      assert.equal(status.diagnostic_disabled, true); assert.equal(status.diagnostic_running, false);
      assert.equal(status.last_diagnosis, undefined, "unrecorded success is not presented as retained evidence");
      assert.equal(calls, 1); assert.equal(appendFailures, 1, "the failing recorder is not used to log itself");
      assert.ok(status.incidents.some(i => i.component === "monitor" && i.code === "accounting_mismatch" && i.disposition === "development"));
      if (outcome === "failure") assert.ok(status.incidents.some(i => i.code === "diagnosis_failed"));
      f.advance(10000); await f.monitor.tick(); await f.monitor.diagnostic();
      assert.equal(calls, 1); assert.equal(appendFailures, 1); assert.equal(f.wakes.length, 0);
      const evidence = JSON.stringify(f.monitor.facts()) + fs.readdirSync(f.directory).filter(n => n.endsWith(".json"))
        .map(n => fs.readFileSync(path.join(f.directory, n), "utf8")).join("");
      assert.equal(evidence.includes(privateError), false); assert.equal(evidence.includes("PRIVATE-MODEL-ERROR"), false);
    } finally { f.clean(); }
  });
}

for (const entryType of ["harness-health-start", "harness-health-reference", "harness-health-parent-start", "harness-health-recovery-failure"]) {
  test(`${entryType} recording failure disables recovery without escaping the native callback`, async () => {
    let rejected = 0;
    const f = fixture({ appendEntry: type => { if (type === entryType) { rejected++; throw new Error("private write failure"); } } });
    try {
      await f.emit("session_start");
      f.snapshot.observations = [{ source: "owned-job", component: "attention", code: "unacknowledged",
        reference: { kind: "job", id: "12345678-1234-1234-1234-123456789abc" } }];
      if (entryType !== "harness-health-start") await f.monitor.tick();
      if (entryType === "harness-health-parent-start" || entryType === "harness-health-recovery-failure") {
        await f.emit("before_agent_start", { prompt: f.wakes[0].content }); await f.emit("agent_start");
        if (entryType === "harness-health-recovery-failure")
          await f.emit("tool_execution_end", { toolCallId: "failed-inspection", toolName: "piccolo_jobs", isError: true });
      }
      assert.equal(f.monitor.facts().storage_failed, true); assert.equal(rejected, 1);
      const sent = f.wakes.length; f.advance(10000); await f.monitor.tick();
      assert.equal(f.wakes.length, sent); assert.equal(rejected, 1);
      assert.ok(f.monitor.facts().incidents.some(i => i.code === "accounting_mismatch"));
    } finally { f.clean(); }
  });
}

test("a rejected old diagnostic after session replacement cannot disable the new recorder", async () => {
  let rejectOld: (reason: Error) => void = () => {};
  let failureWrites = 0;
  const f = fixture({ config: { diagnostic: { enabled: true, model: "test/cheap" } },
    diagnose: () => new Promise((_resolve, reject) => { rejectOld = reject; }),
    appendEntry: type => { if (type === "harness-health-diagnostic-failure") { failureWrites++; throw new Error("old recording error"); } } });
  try {
    await f.emit("session_start"); const old = f.monitor.diagnostic();
    f.snapshot.sessionId = "replacement-with-working-recorder"; await f.emit("session_start");
    rejectOld(new Error("late old failure")); await old; await flush();
    assert.equal(failureWrites, 0); assert.equal(f.monitor.facts().storage_failed, false);
    assert.equal(f.monitor.facts().diagnostic_disabled, false);
    assert.equal(f.monitor.facts().recording_failure, undefined);
    assert.equal(f.monitor.facts().diagnostic_calls, 0);
  } finally { f.clean(); }
});

test("shutdown aborts diagnostic work and prevents subsequent observations or wake actions", async () => {
  let abortSignal: AbortSignal | undefined;
  const f = fixture({ config: { diagnostic: { enabled: true, model: "test/cheap" } },
    diagnose: async (_ctx, _config, _facts, signal) => {
      abortSignal = signal;
      return await new Promise<Diagnosis>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
  try {
    await f.emit("session_start"); const running = f.monitor.diagnostic();
    assert.equal(f.monitor.facts().diagnostic_running, true);
    await f.emit("session_shutdown"); await running;
    assert.equal(abortSignal?.aborted, true);
    f.snapshot.observations = [{ source: "late", component: "attention", code: "wake_overdue" }];
    await f.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "network" } });
    await f.monitor.tick(); await f.monitor.diagnostic();
    assert.equal(f.wakes.length, 0); assert.equal(f.monitor.facts().active, false);
    assert.equal(f.entries.some(entry => Array.isArray(entry) && entry[0] === "harness-health-diagnosis"), false);
  } finally { f.clean(); }
});

test("unavailable safe wake becomes a development incident without an unsafe notification fallback", async () => {
  const f = fixture({ wake: (_ctx, request) => ({ id: request.id, status: "unsupported" }) });
  try {
    await f.emit("session_start");
    f.snapshot.observations = [{ source: "blocked-job", component: "attention", code: "wake_overdue" }];
    await f.monitor.tick();
    assert.equal(f.monitor.facts().incidents[0].disposition, "development");
    assert.equal(f.monitor.facts().incidents[0].reason, "unsupported_recovery");
    for (let n = 0; n < 20; n++) { f.advance(50_000); await f.monitor.tick(); }
    assert.equal(f.wakes.length, 1);
  } finally { f.clean(); }
});

test("observation-only mode records failures without dispatching or exhausting wake attempts", async () => {
  const f = fixture({ config: { recovery: "observe", max_attempts: 1 } });
  try {
    await f.emit("session_start");
    f.snapshot.observations = [{ source: "observed-only", component: "attention", code: "wake_overdue" }];
    for (let n = 0; n < 5; n++) { f.advance(10_000); await f.monitor.tick(); }
    assert.equal(f.wakes.length, 0);
    assert.equal(f.monitor.facts().incidents[0].disposition, "open");
    assert.equal(f.monitor.facts().incidents[0].actions.length, 0);
  } finally { f.clean(); }
});

test("a busy parent does not spend wake attempts and attention resumes at an idle boundary", async () => {
  const f = fixture({ config: { max_attempts: 1 } });
  try {
    await f.emit("session_start"); f.context.isIdle = () => false;
    f.snapshot.observations = [{ source: "while-busy", component: "attention", code: "wake_overdue" }];
    for (let n = 0; n < 4; n++) { f.advance(5000); await f.monitor.tick(); }
    assert.equal(f.wakes.length, 0); assert.equal(f.monitor.facts().incidents[0].actions.length, 0);
    f.context.isIdle = () => true; await f.monitor.tick();
    assert.equal(f.wakes.length, 1); assert.equal(f.monitor.facts().incidents[0].actions[0].attempt, 1);
  } finally { f.clean(); }
});

test("adapter preflight busy while Pi reports idle defers the same action until admission succeeds", async () => {
  let busy = true;
  const f = fixture({ config: { max_attempts: 1, max_wakes: 1 },
    wake: (_ctx, request) => ({ id: request.id, status: busy ? "busy" : "accepted" }) });
  try {
    await f.emit("session_start");
    f.snapshot.observations = [{ source: "preflight-job", component: "attention", code: "unacknowledged" }];
    for (let n = 0; n < 4; n++) { await f.monitor.tick(); f.advance(10_000); }
    assert.equal(f.wakes.length, 4);
    const pending = f.monitor.facts().incidents[0];
    assert.equal(pending.actions.length, 1); assert.equal(pending.actions[0].busy?.count, 4);
    assert.equal(pending.disposition, "open");
    assert.equal(new Set(f.wakes.map(w => w.id)).size, 1);
    busy = false; await f.monitor.tick();
    const admitted = f.monitor.facts().incidents[0].actions[0];
    assert.equal(admitted.id, pending.actions[0].id); assert.equal(admitted.result, "delivered");
    await f.emit("before_agent_start", { prompt: f.wakes.at(-1)!.content }); await f.emit("agent_start");
    assert.ok(f.entries.some(e => Array.isArray(e) && e[0] === "harness-health-parent-start" && e[1].action === admitted.id));
    await f.execute({ action: "disposition", id: pending.id, disposition: "resolved", reason: "verified_recovery" });
    f.snapshot.observations.push({ source: "another-after-cap", component: "attention", code: "unacknowledged" });
    await f.monitor.tick(); assert.equal(f.wakes.length, 5);
    assert.equal(f.monitor.facts().incidents[1].reason, "retry_exhausted");
  } finally { f.clean(); }
});

test("a late diagnostic result from a replaced session cannot affect the new monitor", async () => {
  let finish: (value: Diagnosis) => void = () => {};
  const f = fixture({ config: { diagnostic: { enabled: true, model: "test/cheap" } },
    diagnose: () => new Promise(resolve => { finish = resolve; }) });
  try {
    await f.emit("session_start"); const old = f.monitor.diagnostic();
    f.snapshot.sessionId = "replacement-session";
    await f.emit("session_start");
    finish({ assessment: "development_fix", confidence: "high" }); await old;
    assert.equal(f.monitor.facts().active, true);
    assert.equal(f.monitor.facts().diagnostic_calls, 0);
    assert.equal(f.monitor.facts().diagnostic_running, false);
    assert.equal(f.monitor.facts().last_diagnosis, undefined);
    assert.equal(f.entries.some(entry => Array.isArray(entry) && entry[0] === "harness-health-diagnosis"), false);
  } finally { f.clean(); }
});

 test("successful diagnostic advice does not manufacture failures or additional wakes", async () => {
  const f = fixture({ config: { diagnostic: { enabled: true, model: "test/cheap" } },
    diagnose: async () => ({ assessment: "needs_parent", confidence: "high" }) });
  try {
    await f.emit("session_start");
    f.snapshot.observations = [{ source: "existing-job", component: "attention", code: "unacknowledged" }];
    await f.monitor.tick(); await f.monitor.diagnostic(); await f.monitor.tick();
    assert.equal(f.monitor.facts().incidents.length, 1);
    assert.equal(f.monitor.facts().incidents[0].code, "unacknowledged");
    assert.equal(f.monitor.facts().last_diagnosis?.result.assessment, "needs_parent");
    assert.equal(f.wakes.length, 1);
  } finally { f.clean(); }
});

test("native user interruption is not an endpoint failure and does not wake the parent", async () => {
  const f = fixture();
  try {
    await f.emit("session_start");
    await f.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "The operation was aborted." } });
    await f.emit("tool_execution_start", { toolCallId: "cancelled", toolName: "bash" });
    await f.emit("tool_execution_end", { toolCallId: "cancelled", toolName: "bash", isError: true,
      result: { content: [{ type: "text", text: "some output\n\nCommand aborted" }] } });
    await f.monitor.tick();
    assert.equal(f.monitor.facts().incidents.length, 0);
    assert.equal(f.wakes.length, 0);
  } finally { f.clean(); }
});

test("recovery tool failures retain the original obligation without multiplying wake budgets", async () => {
  const f = fixture({ config: { max_attempts: 1 } });
  try {
    await f.emit("session_start");
    f.snapshot.observations = [{ source: "failed-job", component: "attention", code: "unacknowledged" }];
    await f.monitor.tick();
    await f.emit("before_agent_start", { prompt: f.wakes[0].content });
    await f.emit("agent_start");
    for (let n = 0; n < 5; n++) {
      await f.emit("tool_execution_end", { toolCallId: `failure-${n}`, toolName: "piccolo_jobs", isError: true });
    }
    await f.emit("agent_end"); f.advance(5000); await f.monitor.tick();
    assert.equal(f.wakes.length, 1);
    assert.equal(f.monitor.facts().incidents.length, 1);
    assert.equal(f.monitor.facts().incidents[0].disposition, "development");
    assert.equal(f.entries.filter(e => Array.isArray(e) && e[0] === "harness-health-recovery-failure").length, 5);
  } finally { f.clean(); }
});

test("a queued user instruction leaves recovery correlation and retains its own failures", async () => {
  const f = fixture();
  try {
    await f.emit("session_start");
    f.snapshot.observations = [{ source: "failed-job", component: "attention", code: "unacknowledged" }];
    await f.monitor.tick();
    await f.emit("before_agent_start", { prompt: f.wakes[0].content }); await f.emit("agent_start");
    await f.emit("message_end", { message: { role: "user", content: [{ type: "text", text: "A new user request" }] } });
    await f.emit("tool_execution_end", { toolCallId: "new-user-tool", toolName: "bash", isError: true });
    assert.equal(f.monitor.facts().incidents.length, 2);
    assert.equal(f.monitor.facts().incidents[1].code, "worker_failed");
  } finally { f.clean(); }
});

test("status can retrieve the exact incident even when the summary is truncated", async () => {
  const f = fixture();
  try {
    await f.emit("session_start"); f.context.isIdle = () => false;
    f.snapshot.observations = Array.from({ length: 101 }, (_, n) => ({ source: `failure-${n}`, component: "worker", code: "worker_failed" }));
    await f.monitor.tick();
    const summary = f.monitor.facts();
    assert.equal(summary.incidents_total, 101); assert.equal(summary.incidents_truncated, true);
    const stored = fs.readdirSync(f.directory).find(name => name.endsWith(".json"))!;
    const last = JSON.parse(fs.readFileSync(path.join(f.directory, stored), "utf8")).incidents.at(-1);
    const result = await f.execute({ action: "status", id: last.id });
    assert.equal(result.details.incidents.length, 1);
    assert.equal(result.details.incidents[0].id, last.id);
    assert.equal(result.details.incidents_truncated, false);
    f.context.isIdle = () => true; await f.monitor.tick();
    assert.ok(f.wakes[0].content.includes(summary.incidents[0].id));
  } finally { f.clean(); }
});
