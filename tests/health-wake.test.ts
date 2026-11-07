import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { hasParentWake, requestParentWake, WAKE_BRIDGE } from "../packages/health/src/wake.ts";

const root = resolve(import.meta.dirname, "..");
mkdirSync(join(root, ".cache"), { recursive: true });
const fixture = mkdtempSync(join(root, ".cache/health-wake-test-"));
const source = join(root, "node_modules/pi-sdk-wake-fixture");
const patch = join(root, "packages/health/scripts/patch-pi-wake.py");
cpSync(join(source, "dist"), join(fixture, "dist"), { recursive: true });
cpSync(join(source, "package.json"), join(fixture, "package.json"));
symlinkSync(join(source, "node_modules"), join(fixture, "node_modules"), "dir");
execFileSync("python3", [patch, fixture, "--apply"]);
const { AgentSession } = await import(pathToFileURL(join(fixture, "dist/core/agent-session.js")).href);
test.after(() => rmSync(fixture, { recursive: true, force: true }));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise<void>(r => setImmediate(r));
function harness(auth = deferred()) {
  const session = Object.create(AgentSession.prototype);
  const runs: any[] = []; const followUps: any[] = []; const finished = deferred();
  let identity = "session-a";
  Object.assign(session, {
    sessionManager: { getSessionId: () => identity },
    _modelRuntime: { hasConfiguredAuth: () => false, checkAuth: () => auth.promise.then(() => "test-auth-present") },
    agent: { state: { model: { provider: "test", id: "fake" } }, abort() {}, followUp: (m: any) => followUps.push(m) },
    _extensionRunner: { hasHandlers: () => false, emitBeforeAgentStart: async () => undefined },
    _resourceLoader: { getPrompts: () => ({ prompts: [] }) },
    _pendingNextTurnMessages: [], _baseSystemPrompt: "test", _baseSystemPromptOptions: {},
    abortRetry() {}, abortCompaction() {}, abortBranchSummary() {},
    _flushPendingBashMessages() {}, _flushPendingCustomMessages() {}, _findLastAssistantMessage: () => undefined,
    _queueFollowUp: async (text: string) => { followUps.push(text); },
    _runAgentPrompt: (messages: any) => { session._isAgentRunActive = true; runs.push(messages); return finished.promise.finally(() => { session._isAgentRunActive = false; }); },
  });
  return { session, auth, finished, runs, followUps, changeSession: () => { identity = "session-b"; } };
}
const wake = (s: any, id = "attention-1") => s._healthRequestWake({ sessionId: "session-a", id, content: "Inspect harness health incident attention-1." });

test("patch is idempotent and refuses unqualified bytes without modifying the other file", () => {
  const path = join(fixture, "dist/core/agent-session.js");
  const original = readFileSync(path);
  execFileSync("python3", [patch, fixture, "--apply"]);
  assert.deepEqual(readFileSync(path), original);
  const runner = join(fixture, "dist/core/extensions/runner.js");
  const bytes = readFileSync(runner);
  writeFileSync(runner, Buffer.concat([bytes, Buffer.from("\n// drift\n")]));
  assert.throws(() => execFileSync("python3", [patch, fixture, "--apply"], { stdio: "pipe" }), /Source drift/);
  assert.deepEqual(readFileSync(path), original);
  writeFileSync(runner, bytes);
  execFileSync("python3", [patch, fixture, "--restore"]);
  assert.deepEqual(readFileSync(path), readFileSync(join(source, "dist/core/agent-session.js")));
  execFileSync("python3", [patch, fixture, "--apply"]);
  assert.deepEqual(readFileSync(path), original);
});

test("wake during user authentication preflight is busy; original submitted prompt survives", async () => {
  const h = harness();
  const submitted = h.session.prompt("ORIGINAL USER PROMPT");
  assert.equal(wake(h.session).status, "busy");
  h.auth.resolve(); await tick();
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0][0].content[0].text, "ORIGINAL USER PROMPT");
  h.finished.resolve(); await submitted;
});

test("user submission racing wake authentication queues once with exact text and images", async () => {
  const h = harness();
  assert.equal(wake(h.session).status, "accepted");
  assert.equal(wake(h.session).status, "duplicate");
  assert.equal(wake(h.session, "attention-2").status, "busy");
  const seen: any[] = [];
  h.session._queueFollowUp = async (text: string, images: any) => seen.push({ text, images });
  const images = [{ type: "image", mimeType: "image/png", data: "fixture" }];
  const submitted = h.session.prompt("USER WITH IMAGE", { images });
  h.auth.resolve(); await tick(); await submitted;
  assert.equal(h.runs.length, 1);
  assert.deepEqual(seen, [{ text: "USER WITH IMAGE", images }]);
  h.finished.resolve(); await tick();
});

test("a custom triggering message cannot steal a submitted prompt's preflight", async () => {
  const h = harness();
  const submitted = h.session.prompt("USER FIRST");
  const custom = h.session.sendCustomMessage({ customType: "other-package", content: "event" }, { triggerTurn: true, deliverAs: "followUp" });
  h.auth.resolve(); await tick(); await custom;
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0][0].content[0].text, "USER FIRST");
  assert.equal(h.followUps.length, 1);
  h.finished.resolve(); await submitted;
});

test("failed wake auth releases reservation and preserves subsequent user submission", async () => {
  const h = harness(); let calls = 0;
  h.session._modelRuntime.checkAuth = async () => { await h.auth.promise; if (++calls === 1) throw new Error("fixture auth unavailable"); return "ready"; };
  assert.equal(wake(h.session).status, "accepted");
  const submitted = h.session.prompt("RETAINED AFTER AUTH FAILURE");
  h.auth.resolve(); await tick();
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0][0].content[0].text, "RETAINED AFTER AUTH FAILURE");
  h.finished.resolve(); await submitted;
});

test("session replacement and cancellation during wake preflight prevent stale inference", async () => {
  for (const disposition of ["session", "dispose", "abort"]) {
    const h = harness();
    assert.equal(wake(h.session).status, "accepted");
    if (disposition === "session") h.changeSession();
    if (disposition === "dispose") h.session._healthDisposed = true;
    if (disposition === "abort") h.session._healthAbortEpoch = 1;
    h.auth.resolve(); await tick();
    assert.equal(h.runs.length, 0);
    assert.equal(h.session._healthPromptGate, undefined);
  }
});

test("queued user submissions cannot cross session replacement", async () => {
  const h = harness(); wake(h.session);
  const submitted = h.session.prompt("MUST NOT ENTER NEW SESSION");
  const rejected = assert.rejects(submitted, /Session changed/);
  h.changeSession(); h.auth.resolve(); await rejected; await tick();
  assert.equal(h.runs.length, 0);
});

test("SDK abort retains admission until suspended authentication settles", async () => {
  const h = harness(); let requests = 0;
  h.session._modelRuntime.checkAuth = async () => { if (++requests === 1) await h.auth.promise; return "ready"; };
  assert.equal(wake(h.session).status, "accepted");
  await h.session.abort();
  const submitted = h.session.prompt("USER AFTER ABORT");
  await tick();
  assert.equal(h.runs.length, 0);
  assert.equal(wake(h.session, "while-cancelled-auth-pending").status, "busy");
  h.auth.resolve(); await tick();
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0][0].content[0].text, "USER AFTER ABORT");
  h.finished.resolve(); await submitted;
});

test("SDK immediate post-abort prompt waits for nextTurn restoration and consumes it exactly once", async () => {
  const h = harness(); h.auth.resolve(); const hook = deferred(); let hooks = 0;
  const retained = { role: "custom", customType: "fixture", content: "RETAIN THIS CONTEXT" };
  h.session._pendingNextTurnMessages = [retained];
  h.session._extensionRunner.emitBeforeAgentStart = async () => { if (++hooks === 1) await hook.promise; };
  const cancelled = h.session.prompt("CANCELLED INPUT");
  const rejected = assert.rejects(cancelled, /interrupted/);
  await tick(); assert.deepEqual(h.session._pendingNextTurnMessages, []);
  await h.session.abort();
  const next = h.session.prompt("IMMEDIATE USER INPUT");
  await tick(); assert.equal(h.runs.length, 0);
  hook.resolve(); await rejected; await tick();
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0][0].content[0].text, "IMMEDIATE USER INPUT");
  assert.deepEqual(h.runs[0].slice(1), [retained]);
  assert.deepEqual(h.session._pendingNextTurnMessages, []);
  h.finished.resolve(); await next;
});

test("SDK disposal releases waiters only into stale-session rejection", async () => {
  const h = harness();
  h.session._extensionRunner.invalidate = () => {};
  h.session.abortBash = () => {};
  assert.equal(wake(h.session).status, "accepted");
  const queued = h.session.prompt("DO NOT RUN AFTER DISPOSAL");
  const rejected = assert.rejects(queued, /Session changed/);
  h.session.dispose(); await rejected;
  h.auth.resolve(); await tick();
  assert.equal(h.runs.length, 0);
  assert.equal(wake(h.session, "disposed-owner").status, "stale");
});

test("SDK abort during before-agent hook preserves pending nextTurn context", async () => {
  const h = harness(); h.auth.resolve(); const hook = deferred();
  h.session._pendingNextTurnMessages = [{ role: "custom", content: "RETAIN THIS" }];
  h.session._extensionRunner.emitBeforeAgentStart = async () => { await hook.promise; };
  const submitted = h.session.prompt("CANCELLED"); const rejected = assert.rejects(submitted, /interrupted/);
  await tick(); await h.session.abort(); hook.resolve(); await rejected;
  assert.equal(h.runs.length, 0);
  assert.deepEqual(h.session._pendingNextTurnMessages, [{ role: "custom", content: "RETAIN THIS" }]);
});

test("SDK nextTurn restoration does not cross session identity", async () => {
  const h = harness(); h.auth.resolve(); const hook = deferred();
  h.session._pendingNextTurnMessages = [{ role: "custom", content: "OLD ONLY" }];
  h.session._extensionRunner.emitBeforeAgentStart = async () => { await hook.promise; };
  const submitted = h.session.prompt("OLD"); const rejected = assert.rejects(submitted, /Session changed/);
  await tick(); await h.session.abort(); h.changeSession();
  h.session._pendingNextTurnMessages = [{ role: "custom", content: "NEW ONLY" }];
  hook.resolve(); await rejected;
  assert.deepEqual(h.session._pendingNextTurnMessages, [{ role: "custom", content: "NEW ONLY" }]);
});

test("SDK reentrant inference fails promptly rather than self-deadlocking", async () => {
  const h = harness(); h.auth.resolve();
  h.session._tryExecuteExtensionCommand = async () => {
    await assert.rejects(h.session.sendCustomMessage({ customType: "command", content: "nested" }, { triggerTurn: true }), /reentrantly/);
    return true;
  };
  await h.session.prompt("/command"); assert.equal(h.runs.length, 0);
});

test("SDK native registered command can await its custom-message run", async () => {
  const h = harness();
  h.session._extensionRunner.getCommand = () => ({ handler: async () => {
    await h.session.sendCustomMessage({ customType: "command", content: "NATIVE COMMAND" }, { triggerTurn: true });
  } });
  h.session._extensionRunner.createCommandContext = () => ({});
  h.session._extensionRunner.emitError = (error: any) => { throw new Error(error.error); };
  const submitted = h.session.prompt("/command"); await tick();
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].content, "NATIVE COMMAND");
  h.finished.resolve(); await submitted;
});

test("SDK unknown command cannot flush replacement-session messages after suspended dispatch", async () => {
  for (const invalidation of ["replace", "abort", "dispose"]) {
    const h = harness(); const command = deferred(); let flushes = 0; let authCalls = 0;
    h.session._tryExecuteExtensionCommand = async () => { await command.promise; return false; };
    h.session._flushPendingBashMessages = () => { flushes++; };
    h.session._flushPendingCustomMessages = () => { flushes++; h.session._pendingCustomMessages = []; };
    h.session._modelRuntime.checkAuth = async () => { authCalls++; return "fixture-ready"; };
    const acknowledgments: boolean[] = [];
    const submitted = h.session.prompt("/unknown", { preflightResult: (accepted: boolean) => acknowledgments.push(accepted) });
    const rejected = assert.rejects(submitted, /Session changed or prompt interrupted/);
    await tick();
    if (invalidation === "replace") h.changeSession();
    if (invalidation === "abort") await h.session.abort();
    if (invalidation === "dispose") h.session._healthDisposed = true;
    h.session._pendingCustomMessages = [{ role: "custom", content: "REPLACEMENT CUSTOM" }];
    h.session._pendingNextTurnMessages = [{ role: "custom", content: "REPLACEMENT NEXT TURN" }];
    h.session.agent.state.systemPrompt = "REPLACEMENT SYSTEM PROMPT";
    command.resolve(); await rejected;
    assert.equal(flushes, 0); assert.equal(authCalls, 0); assert.equal(h.runs.length, 0);
    assert.deepEqual(acknowledgments, [false]);
    assert.deepEqual(h.session._pendingCustomMessages, [{ role: "custom", content: "REPLACEMENT CUSTOM" }]);
    assert.deepEqual(h.session._pendingNextTurnMessages, [{ role: "custom", content: "REPLACEMENT NEXT TURN" }]);
    assert.equal(h.session.agent.state.systemPrompt, "REPLACEMENT SYSTEM PROMPT");
  }
});

test("SDK handled command may intentionally replace its session", async () => {
  const h = harness(); let flushes = 0;
  h.session._tryExecuteExtensionCommand = async () => { h.changeSession(); return true; };
  h.session._flushPendingCustomMessages = () => { flushes++; };
  const acknowledgments: boolean[] = [];
  await h.session.prompt("/switch-session", { preflightResult: (accepted: boolean) => acknowledgments.push(accepted) });
  assert.deepEqual(acknowledgments, [true]); assert.equal(flushes, 0); assert.equal(h.runs.length, 0);
});

test("input hooks and before-agent hooks reserve the same preflight boundary", async () => {
  for (const boundary of ["input", "before_agent_start"]) {
    const h = harness(); h.auth.resolve(); const gate = deferred();
    if (boundary === "input") {
      h.session._extensionRunner.hasHandlers = () => true;
      h.session._extensionRunner.emitInput = async () => { await gate.promise; return { action: "continue" }; };
    } else h.session._extensionRunner.emitBeforeAgentStart = async () => { await gate.promise; };
    const submitted = h.session.prompt("USER THROUGH EXTENSION HOOK");
    await tick(); assert.equal(wake(h.session).status, "busy");
    gate.resolve(); await tick();
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0][0].content[0].text, "USER THROUGH EXTENSION HOOK");
    h.finished.resolve(); await submitted;
  }
});

test("wake preserves handled commands and defers during compaction", async () => {
  const h = harness();
  h.session._tryExecuteExtensionCommand = async () => true;
  await h.session.prompt("/a-native-command");
  assert.equal(h.runs.length, 0);
  assert.equal(h.session._healthPromptGate, undefined);
  h.session._compactionAbortController = new AbortController();
  assert.equal(wake(h.session).status, "busy");
});

test("bridge reports unsupported or stale explicitly and never uses unsafe sendMessage fallback", () => {
  const req = { sessionId: "session-a", id: "attention-1", content: "health" };
  assert.equal(hasParentWake({}), false);
  assert.equal(requestParentWake({}, req).status, "unsupported");
  const stale = { [WAKE_BRIDGE]() { throw new Error("stale context"); } };
  assert.equal(requestParentWake(stale, req).status, "stale");
  const h = harness(); h.session._bashAbortControllers = new Set([{}]);
  assert.equal(wake(h.session).status, "busy");
});
