import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
// An explicit test-only SDK path exercises this same fixture against a newer SDK.
const { AgentSession, VERSION } = await import(process.env.PICCOLO_WAKE_TEST_SDK ?? "@earendil-works/pi-coding-agent");
import { installManagedWake, QUALIFIED_METHODS, CLEANUP_METHODS, type ManagedWakeProfile } from "../packages/health/src/managed-wake.ts";
import { hasParentWake, registerManagedWake, WAKE_BRIDGE } from "../packages/health/src/wake.ts";
import { registerHealth, INSPECT } from "../packages/health/index.ts";
import { resolveHealthConfig } from "../packages/health/src/config.ts";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function fixtureCheckAuth(this: any) { return this.authHook ? await this.authHook() : await this.auth.promise.then(() => "fixture-ready"); }
async function fixtureEmitInput(this: any) { return this.inputHook ? await this.inputHook() : { action: "continue" }; }
async function fixtureEmitBefore(this: any) { return (await this.beforeHook?.()) ?? { messages: [], systemPromptOptions: { selectedTools: [] } }; }
const fnHash = (fn: Function) => createHash("sha256").update(Function.prototype.toString.call(fn)).digest("hex");
// Test profile qualifies the real unbundled SDK used by the test runner only.
// Production uses the captured compiled-method profile, never dynamic trust.
const profile: ManagedWakeProfile = { id: "test-unbundled", version: VERSION, boundHashes: { checkAuth: fnHash(fixtureCheckAuth), emitInput: fnHash(fixtureEmitInput), emitBeforeAgentStart: fnHash(fixtureEmitBefore) }, hashes: Object.fromEntries([ ...QUALIFIED_METHODS, ...(VERSION === "1.4.0" ? CLEANUP_METHODS : []) ].map(name => {
  const d = Object.getOwnPropertyDescriptor(AgentSession.prototype, name)!;
  return [name, createHash("sha256").update(Function.prototype.toString.call(d.value ?? d.get)).digest("hex")];
})) as ManagedWakeProfile["hashes"] };
const originalPrompt = AgentSession.prototype.prompt;
assert.equal(installManagedWake(AgentSession, VERSION).status, "unsupported");
assert.equal(AgentSession.prototype.prompt, originalPrompt);
const adapter = installManagedWake(AgentSession, VERSION, profile);
assert.equal(adapter.status, "installed");
registerManagedWake(adapter);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise<void>(r => setImmediate(r));
function harness(bind = true) {
  const auth = deferred(); const finished = deferred(); const runs: any[] = []; const followUps: any[] = [];
  const session: any = Object.create(AgentSession.prototype); let identity = "session-a";
  Object.assign(session, {
    sessionManager: { getSessionId: () => identity },
    _modelRuntime: { hasConfiguredAuth: () => false, auth, checkAuth: fixtureCheckAuth },
    agent: { hasQueuedMessages: () => false, state: { model: { provider: "fixture", id: "fake" } }, abort() {}, prompt: (m: any) => { runs.push(m); return finished.promise; }, followUp: (m: any) => followUps.push(m) },
    _eventListeners: [], _deferredSettledActions: [],
    _extensionRunner: { emit: async () => {}, hasHandlers: () => false, emitBeforeAgentStart: fixtureEmitBefore, emitInput: fixtureEmitInput, bindCore() {} },
    _resourceLoader: { getPrompts: () => ({ prompts: [] }) },
    _bashAbortControllers: new Set(), _retryAttempt: 0,
    _pendingNextTurnMessages: [], _baseSystemPrompt: "fixture", _baseSystemPromptOptions: { selectedTools: [] },
    _preparePromptAndToolLoadout() {}, getActiveToolNames: () => [],
    _recordSelection() {}, _pendingToolNames: new Set(), _finishCancelledRetry() {},
    _flushPendingBashMessages() {}, _flushPendingCustomMessages() {}, _findLastAssistantMessage: () => undefined,
    abortRetry() {}, abortCompaction() {}, abortBranchSummary() {},
    _queueFollowUp: async (text: string, images: any) => { followUps.push({ text, images }); },
  });
  // Same native binding boundary used when the real session is constructed.
  if (bind) session._bindExtensionCore(session._extensionRunner);
  const ctx = { sessionManager: session.sessionManager };
  const wake = (id = "attention-1") => adapter.request(ctx, { sessionId: "session-a", id, content: "Inspect retained harness incident attention-1." });
  return { session, ctx, wake, auth, finished, runs, followUps, changeSession: () => { identity = "session-b"; } };
}

test("interactive native bash defers managed wake without cancelling user work", async () => {
  const h = harness(); const command = new AbortController();
  h.session._bashAbortControllers.add(command);
  assert.equal(h.session.isIdle, true, "native idle does not include interactive bash");
  assert.equal(h.wake().status, "busy");
  assert.equal(h.runs.length, 0); assert.equal(command.signal.aborted, false);
  h.session._bashAbortControllers.delete(command);
  assert.equal(h.wake().status, "accepted", "busy did not consume the request ID");
  h.auth.resolve(); await tick(); assert.equal(h.runs.length, 1);
  h.finished.resolve(); await tick();
});

test("unknown native bash ownership state refuses managed wake capability", () => {
  const h = harness(); delete h.session._bashAbortControllers;
  assert.equal(adapter.supports(h.ctx), false); assert.equal(h.wake().status, "unsupported");
});

test("native auth preflight reporting idle defers health admission without exhausting wake budgets", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "health-native-preflight-"));
  const h = harness();
  const context: any = { ...h.ctx, cwd: directory, hasUI: false, isIdle: () => h.session.isIdle,
    [WAKE_BRIDGE]: (request: any) => adapter.request(h.ctx, request),
    isProjectTrusted: () => true, modelRegistry: {} };
  const events = new EventEmitter(); const handlers = new Map<string, any>();
  const pi: any = { events, on: (name: string, handler: any) => handlers.set(name, handler), registerTool() {},
    registerMessageRenderer() {}, registerCommand() {}, appendEntry() {}, sendMessage() {} };
  events.on(INSPECT, request => {
    request.observations = [{ source: "auth-pending-job", component: "attention", code: "unacknowledged" }];
  });
  let clock = 100000;
  const health = registerHealth(pi, { config: () => resolveHealthConfig([{ interval_ms: 1000, attention_ms: 1000,
    retry_ms: 1000, max_attempts: 1, max_wakes: 1 }]), directory: () => directory, now: () => clock });
  const submitted = h.session.prompt("NATIVE USER PREFLIGHT");
  try {
    handlers.get("session_start")({}, context);
    assert.equal(context.isIdle(), true, "native idle flag excludes auth preflight");
    assert.equal(h.wake("check-admission").status, "busy", "adapter sees the admission gate");
    for (let n = 0; n < 4; n++) { await health.tick(); clock += 10000; }
    const pending = health.facts().incidents[0];
    assert.equal(pending.actions.length, 1); assert.equal(pending.actions[0].busy?.count, 4);
    assert.equal(pending.disposition, "open"); assert.equal(h.runs.length, 0);
    h.auth.resolve(); await tick(); h.finished.resolve(); await submitted;
    await health.tick(); await tick();
    const recovered = health.facts().incidents[0];
    assert.equal(recovered.actions[0].id, pending.actions[0].id);
    assert.equal(recovered.actions[0].result, "delivered");
    assert.equal(recovered.actions[0].busy?.count, 4);
    assert.equal(h.runs.length, 2, "native user run then health run; no extra model runs");
  } finally {
    h.auth.resolve(); h.finished.resolve(); await submitted; health.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("exact profiles are required; installation is idempotent", () => {
  assert.equal(installManagedWake(AgentSession, VERSION, profile), adapter);
  assert.equal(installManagedWake(AgentSession, "0.85.2", profile).status, "unsupported");
  assert.equal(installManagedWake(AgentSession, VERSION, { ...profile, id: "different" }).status, "unsupported");
});

test("late installation qualifies an existing native binding once on first prompt", async () => {
  const h = harness(false); assert.equal(hasParentWake(h.ctx), false);
  const submitted = h.session.prompt("FIRST AFTER INSTALL");
  assert.equal(hasParentWake(h.ctx), true); assert.equal(h.wake().status, "busy");
  h.auth.resolve(); await tick(); h.finished.resolve(); await submitted;
  h.session._extensionRunner.emitBeforeAgentStart = async () => ({ messages: [], systemPromptOptions: { selectedTools: [] } });
  assert.equal(hasParentWake(h.ctx), false);
  const next = h.session.prompt("DO NOT REQUALIFY DRIFT"); await next;
  assert.equal(hasParentWake(h.ctx), false);
});

test("managed adapter rejects wake during native user auth preflight", async () => {
  const h = harness(); const acks: string[] = [];
  const submitted = h.session.prompt("USER FIRST", { preflightResult: (a: string) => acks.push(a) });
  assert.equal(h.wake().status, "busy"); h.auth.resolve(); await tick();
  assert.equal(h.runs[0][0].content[0].text, "USER FIRST"); assert.deepEqual(acks, ["started"]);
  h.finished.resolve(); await submitted;
});

test("managed wake preserves racing user text/images and explicit steering choice", async () => {
  const h = harness(); assert.equal(h.wake().status, "accepted");
  assert.equal(h.wake().status, "duplicate"); assert.equal(h.wake("other").status, "busy");
  const image = [{ type: "image", data: "fixture", mimeType: "image/png" }];
  const submitted = h.session.prompt("USER WITH IMAGE", { images: image });
  h.auth.resolve(); await tick(); await submitted;
  assert.equal(h.runs.length, 1); assert.deepEqual(h.followUps, [{ text: "USER WITH IMAGE", images: image }]);
  const steering: string[] = []; h.session._queueSteer = async (s: string) => steering.push(s);
  await h.session.prompt("STEER", { streamingBehavior: "steer" }); assert.deepEqual(steering, ["STEER"]);
  h.finished.resolve(); await tick();
});

test("competing triggering custom message queues behind user preflight", async () => {
  const h = harness(); const submitted = h.session.prompt("USER");
  const custom = h.session.sendCustomMessage({ customType: "fixture", content: "callback" }, { triggerTurn: true, deliverAs: "followUp" });
  h.auth.resolve(); await tick(); await custom;
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0][0].content[0].text, "USER"); assert.equal(h.followUps.length, 1);
  h.finished.resolve(); await submitted;
});

test("auth failure releases admission and preserves following user submission", async () => {
  const h = harness(); let calls = 0;
  h.session._modelRuntime.authHook = async () => { await h.auth.promise; if (++calls === 1) throw new Error("fixture unavailable"); return "ready"; };
  assert.equal(h.wake().status, "accepted"); const submitted = h.session.prompt("AFTER FAILURE");
  h.auth.resolve(); await tick(); assert.equal(h.runs[0][0].content[0].text, "AFTER FAILURE");
  h.finished.resolve(); await submitted;
});

test("abort during suspended before-agent hook preserves unsubmitted nextTurn context", async () => {
  const h = harness(); h.auth.resolve(); const hook = deferred();
  h.session._pendingNextTurnMessages = [{ role: "custom", content: "RETAIN THIS" }];
  h.session._extensionRunner.beforeHook = async () => { await hook.promise; return { systemPrompt: "OLD SYSTEM PROMPT" }; };
  const acks: string[] = [];
  const submitted = h.session.prompt("CANCELLED", { preflightResult: (a: string) => acks.push(a) });
  const rejected = assert.rejects(submitted, /interrupted/); await tick();
  const aborted = h.session.abort(); assert.equal(h.wake().status, "busy"); hook.resolve(); await rejected; await aborted;
  assert.equal(h.runs.length, 0); assert.deepEqual(acks, []);
  assert.deepEqual(h.session._pendingNextTurnMessages, [{ role: "custom", content: "RETAIN THIS" }]);
});

test("invalidated preflight does not restore old nextTurn entries into a replacement session", async () => {
  const h = harness(); h.auth.resolve(); const hook = deferred();
  h.session._pendingNextTurnMessages = [{ role: "custom", content: "OLD SESSION ONLY" }];
  h.session._extensionRunner.beforeHook = async () => { await hook.promise; return { systemPrompt: "OLD SYSTEM PROMPT" }; };
  const submitted = h.session.prompt("OLD INPUT"); const rejected = assert.rejects(submitted, /Session changed/);
  await tick(); h.changeSession(); h.session._pendingNextTurnMessages = [{ role: "custom", content: "NEW SESSION ONLY" }];
  h.session.agent.state.systemPrompt = "NEW SYSTEM PROMPT";
  hook.resolve(); await rejected;
  assert.deepEqual(h.session._pendingNextTurnMessages, [{ role: "custom", content: "NEW SESSION ONLY" }]);
  assert.equal(h.session.agent.state.systemPrompt, "NEW SYSTEM PROMPT");
});

test("stale auth and input results cannot resume mutation of a replacement session", async () => {
  for (const boundary of ["auth", "input"]) {
    const h = harness(); const hook = deferred();
    if (boundary === "input") {
      h.auth.resolve(); h.session._extensionRunner.hasHandlers = () => true;
      h.session._extensionRunner.inputHook = async () => { await hook.promise; return { action: "continue" }; };
    }
    const submitted = h.session.prompt("OLD INPUT"); const rejected = assert.rejects(submitted, /Session changed/);
    await tick(); h.changeSession(); h.session._pendingNextTurnMessages = [{ role: "custom", content: "NEW ONLY" }];
    h.session.agent.state.systemPrompt = "NEW SYSTEM PROMPT";
    h.auth.resolve(); hook.resolve(); await rejected;
    assert.equal(h.runs.length, 0);
    assert.deepEqual(h.session._pendingNextTurnMessages, [{ role: "custom", content: "NEW ONLY" }]);
    assert.equal(h.session.agent.state.systemPrompt, "NEW SYSTEM PROMPT");
  }
});

test("stale compaction completion cannot resume replacement-session preflight", async () => {
  const h = harness(); h.auth.resolve(); const compaction = deferred(); let entered = false;
  h.session.settingsManager = { getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 50 }) };
  h.session.sessionManager.getBranch = () => [];
  h.session.sessionManager.buildSessionProjection = () => ({ entries: [], messages: [] });
  h.session._findPersistedMessageEntryId = () => undefined;
  h.session._modelForMessage = () => h.session.model;
  h.session.agent.state.model.contextWindow = 1000;
  h.session._findLastAssistantMessage = () => ({ role: "assistant", provider: "fixture", model: "fake", stopReason: "stop", timestamp: Date.now(), usage: { input: 10000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 10001 } });
  h.session._runAutoCompaction = async () => { entered = true; await compaction.promise; return false; };
  const submitted = h.session.prompt("OLD INPUT"); const rejected = assert.rejects(submitted, /Session changed/);
  await tick(); assert.equal(entered, true); h.changeSession();
  h.session._pendingNextTurnMessages = [{ role: "custom", content: "NEW ONLY" }];
  h.session.agent.state.systemPrompt = "NEW SYSTEM PROMPT";
  compaction.resolve(); await rejected;
  assert.equal(h.runs.length, 0); assert.deepEqual(h.session._pendingNextTurnMessages, [{ role: "custom", content: "NEW ONLY" }]);
  assert.equal(h.session.agent.state.systemPrompt, "NEW SYSTEM PROMPT");
});

test("aborting an admitted model run does not duplicate already-consumed nextTurn context", async () => {
  const h = harness(); h.auth.resolve(); const running = deferred();
  h.session._pendingNextTurnMessages = [{ role: "custom", content: "ALREADY CONSUMED" }];
  h.session.agent.prompt = async () => { await running.promise; throw new Error("fixture cancelled"); };
  const submitted = h.session.prompt("RUN"); const rejected = assert.rejects(submitted, /fixture cancelled/);
  await tick(); const aborted = h.session.abort(); running.resolve(); await rejected; await aborted;
  assert.deepEqual(h.session._pendingNextTurnMessages, []);
});

test("native registered command can await its own custom-message run", async () => {
  const h = harness();
  h.session._extensionRunner.getCommand = () => ({ handler: async () => {
    await h.session.sendCustomMessage({ customType: "command", content: "NATIVE COMMAND" }, { triggerTurn: true });
  } });
  h.session._extensionRunner.createCommandContext = () => ({});
  h.session._extensionRunner.emitError = (error: any) => { throw new Error(error.error); };
  const submitted = h.session.prompt("/command"); await tick();
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0][0].content, "NATIVE COMMAND");
  h.finished.resolve(); await submitted;
});

test("reentrant inference request fails promptly instead of waiting for its own preflight", async () => {
  const h = harness(); h.auth.resolve();
  h.session._tryExecuteExtensionCommand = async () => {
    await assert.rejects(h.session.sendCustomMessage({ customType: "command", content: "nested" }, { triggerTurn: true }), /reentrantly/);
    return true;
  };
  await h.session.prompt("/command"); assert.equal(h.runs.length, 0);
});

test("session replacement invalidates wake and queued user input", async () => {
  const h = harness(); h.wake(); const submitted = h.session.prompt("OLD SESSION INPUT");
  const rejected = assert.rejects(submitted, /Session changed/); h.changeSession(); h.auth.resolve();
  await rejected; await tick(); assert.equal(h.runs.length, 0); assert.equal(h.wake("new").status, "stale");
});

test("input hooks, commands, and compaction retain native behavior", async () => {
  const h = harness(); const hook = deferred(); h.auth.resolve();
  h.session._extensionRunner.hasHandlers = () => true;
  h.session._extensionRunner.inputHook = async () => { await hook.promise; return { action: "handled" }; };
  const acks: string[] = []; const submitted = h.session.prompt("HANDLED", { preflightResult: (a: string) => acks.push(a) });
  assert.equal(h.wake().status, "busy"); hook.resolve(); await submitted;
  assert.deepEqual(acks, ["handled"]); assert.equal(h.runs.length, 0);
  h.session._compactionAbortController = new AbortController(); assert.equal(h.wake().status, "busy");
});

test("foreign contexts cannot select a session just by copying its id", () => {
  const h = harness();
  assert.equal(hasParentWake(h.ctx), true);
  assert.equal(hasParentWake({ sessionManager: { getSessionId: () => "session-a" } }), false);
  assert.equal(hasParentWake({ get sessionManager() { throw new Error("stale native context"); } }), false);
  assert.equal(adapter.request({ sessionManager: { getSessionId: () => "session-a" } }, { sessionId: "session-a", id: "foreign", content: "wake" }).status, "unsupported");
  assert.equal(h.wake().status, "accepted"); h.auth.resolve(); h.finished.resolve();
});

test("runtime method overrides after installation make wake unsupported", () => {
  const h = harness();
  h.session._startRun = async () => { throw new Error("must not invoke unqualified implementation"); };
  assert.equal(h.wake().status, "unsupported");
  assert.equal(hasParentWake(h.ctx), false);
  assert.equal(h.runs.length, 0);
});

test("dispose during preflight prevents stale inference", async () => {
  const h = harness();
  h.session._extensionRunner.invalidate = () => {};
  h.session.abortBash = () => {};
  assert.equal(h.wake().status, "accepted");
  h.session.dispose(); h.auth.resolve(); await tick();
  assert.equal(hasParentWake(h.ctx), false);
  assert.equal(h.runs.length, 0); assert.equal(h.wake("after-dispose").status, "stale");
});


test("current managed selection claims attention only through the installed exact adapter and respects later opt-out", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "health-managed-current-"));
  const h = harness(); h.auth.resolve(); h.finished.resolve();
  const context: any = { ...h.ctx, cwd: directory, hasUI: false, isIdle: () => h.session.isIdle,
    isProjectTrusted: () => true, modelRegistry: {} };
  const events = new EventEmitter(), handlers = new Map<string, any>();
  const pi: any = { events, on: (name: string, handler: any) => handlers.set(name, handler), registerTool() {},
    registerMessageRenderer() {}, registerCommand() {}, appendEntry() {} };
  let compatibility = "managed";
  const health = registerHealth(pi, { config: () => resolveHealthConfig([{ compatibility }]), directory: () => directory });
  const claim = () => { const value = { sessionId: "session-a", claimed: false }; events.emit("pi-harness-health:attention-owner:v1", value); return value.claimed; };
  try {
    registerManagedWake(adapter);
    handlers.get("session_start")({}, context);
    // This process already installed another (test-only) profile, which the
    // production installer rejects before comparing method hashes. Restore
    // only that explicit test adapter for this unit fixture.
    registerManagedWake(adapter);
    assert.equal(health.facts().wake_capability, true);
    assert.equal(claim(), true);
    compatibility = "off"; handlers.get("session_start")({}, context);
    assert.equal(health.facts().wake_capability, false); assert.equal(claim(), false);
    compatibility = "managed-0.86.1"; handlers.get("session_start")({}, context);
    assert.equal(health.facts().wake_capability, false); assert.equal(claim(), false);
  } finally { health.close(); registerManagedWake(adapter); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Pi 1.4 subscriber abort after preparation rejects inference, settles native idle and preserves next-turn context", { skip: VERSION !== "1.4.0" }, async () => {
  const h = harness(); h.auth.resolve(); h.finished.resolve();
  h.session._pendingCustomMessages = [{ role: "custom", customType: "cancel-canary", content: "synthetic" }];
  delete h.session._flushPendingCustomMessages;
  h.session.sessionManager.appendCustomMessageEntry = () => {};
  h.session._refreshFinalizedContext = () => {};
  const retained = { role: "custom", customType: "nextTurn", content: "KEEP THIS" };
  h.session._pendingNextTurnMessages = [retained];
  let aborted: Promise<void> | undefined;
  const unsubscribe = h.session.subscribe((event: any) => {
    if (event.type === "message_end") aborted = h.session.abort();
  });
  await assert.rejects(h.session.prompt("UNSUBMITTED"), /Session changed or input interrupted/);
  assert.ok(aborted); await aborted;
  assert.equal(h.runs.length, 0);
  assert.equal(h.session.isIdle, true);
  assert.equal(h.session._runSystemPromptOptions, undefined);
  assert.deepEqual(h.session._pendingNextTurnMessages, [retained]);
  unsubscribe();
  await h.session.prompt("NEXT USER INPUT");
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0][0].content[0].text, "NEXT USER INPUT");
  assert.deepEqual(h.runs[0].slice(1), [retained]);
  assert.equal(h.wake("AFTER CANCELLATION").status, "accepted");
  await tick(); assert.equal(h.runs.length, 2);
});

test("Pi 1.4 interrupted-start cleanup preserves observer errors without leaving abort waiters stuck", { skip: VERSION !== "1.4.0" }, async () => {
  const h = harness(); h.auth.resolve();
  h.session._pendingCustomMessages = [{ role: "custom", customType: "cancel-canary", content: "synthetic" }];
  delete h.session._flushPendingCustomMessages;
  h.session.sessionManager.appendCustomMessageEntry = () => {};
  h.session._refreshFinalizedContext = () => {};
  let aborted: Promise<void> | undefined;
  h.session.subscribe((event: any) => { if (event.type === "message_end") aborted = h.session.abort(); });
  h.session._cacheWarmer = { onAgentSettled: () => { throw new Error("fixture observer failure"); } };
  await assert.rejects(h.session.prompt("UNSUBMITTED"), (error: any) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /Session changed or input interrupted/);
    assert.equal(error.errors[1].message, "fixture observer failure");
    return true;
  });
  assert.ok(aborted); await aborted;
  assert.equal(h.runs.length, 0);
  assert.equal(h.session.isIdle, true);
});

test("Pi 1.4 interrupted start flushes newly queued passive bash and custom messages", { skip: VERSION !== "1.4.0" }, async () => {
  const h = harness(); h.auth.resolve(); h.finished.resolve();
  const custom: any[] = [], bash: any[] = [];
  h.session._pendingCustomMessages = [{ role: "custom", customType: "cancel-canary", content: "synthetic" }];
  h.session._pendingBashMessages = [];
  delete h.session._flushPendingCustomMessages; delete h.session._flushPendingBashMessages;
  h.session.sessionManager.appendCustomMessageEntry = (type: string) => { custom.push(type); };
  h.session.sessionManager.appendMessage = (message: any) => { bash.push(message); };
  h.session._refreshFinalizedContext = () => {};
  let aborted: Promise<void> | undefined;
  h.session.subscribe((event: any) => {
    if (event.type === "message_end" && event.message.customType === "cancel-canary") {
      aborted = h.session.abort();
      void h.session.sendCustomMessage({ customType: "queued-passive", content: "Persist this passive notice", display: false }, { triggerTurn: false });
      h.session._pendingBashMessages.push({ role: "bashExecution", command: "owned", output: "owned", timestamp: 1 });
    }
  });
  await assert.rejects(h.session.prompt("UNSUBMITTED"), /interrupted/); await aborted;
  assert.equal(h.runs.length, 0); assert.equal(h.session.isIdle, true);
  assert.deepEqual(custom, ["cancel-canary", "queued-passive"]);
  assert.equal(bash.length, 1); assert.deepEqual(h.session._pendingBashMessages, []); assert.deepEqual(h.session._pendingCustomMessages, []);
});

test("modern custom-message cancellation restores unsubmitted next-turn context", async () => {
  const h = harness(); h.auth.resolve(); const gate = deferred();
  const retained = { role: "custom", customType: "nextTurn", content: "KEEP CONTEXT" };
  h.session._pendingNextTurnMessages = [retained];
  h.session._extensionRunner.beforeHook = async () => { await gate.promise; };
  const sending = h.session.sendCustomMessage({ customType: "trigger", content: "Cancelled trigger" }, { triggerTurn: true });
  const rejected = assert.rejects(sending, /interrupted/);
  await tick(); const aborted = h.session.abort(); gate.resolve(); await rejected; await aborted;
  assert.equal(h.runs.length, 0); assert.deepEqual(h.session._pendingNextTurnMessages, [retained]);
});

for (const subscriber of ["extension", "public"] as const) test(`Pi 1.4 cancellation defers ${subscriber} settlement requests until context is restored`, { skip: VERSION !== "1.4.0" }, async () => {
  const h = harness(); h.auth.resolve(); h.finished.resolve();
  h.session._pendingCustomMessages = [{ role: "custom", customType: "cancel-canary", content: "synthetic" }];
  delete h.session._flushPendingCustomMessages;
  h.session.sessionManager.appendCustomMessageEntry = () => {};
  h.session._refreshFinalizedContext = () => {};
  const retained = { role: "custom", customType: "nextTurn", content: "KEEP CONTEXT" };
  h.session._pendingNextTurnMessages = [retained];
  let aborted: Promise<void> | undefined, requested = false;
  const request = () => { requested = true; return h.session.sendCustomMessage({ customType: "settled-request", content: "Inspect completion" }, { triggerTurn: true }); };
  const unsubscribe = h.session.subscribe((event: any) => {
    if (event.type === "message_end") aborted = h.session.abort();
    if (subscriber === "public" && event.type === "agent_settled" && !requested) void request();
  });
  h.session._extensionRunner.emit = async (event: any) => {
    if (subscriber === "extension" && event.type === "agent_settled" && !requested) await request();
  };
  await assert.rejects(h.session.prompt("UNSUBMITTED"), /interrupted/);
  assert.ok(aborted); await aborted; await tick(); unsubscribe();
  assert.equal(requested, true); assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0][0].customType, "settled-request");
  assert.deepEqual(h.runs[0].slice(1), [retained]);
  assert.equal(h.session.isIdle, true);
});

test("Pi 1.4 cleanup helper drift revokes wake capability", { skip: VERSION !== "1.4.0" }, () => {
  for (const method of CLEANUP_METHODS) {
    const h = harness();
    assert.equal(adapter.supports(h.ctx), true);
    h.session[method] = async () => {};
    assert.equal(adapter.supports(h.ctx), false);
    assert.equal(h.wake().status, "unsupported");
  }
});
