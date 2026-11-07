import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { registerJobs } from "../src/job-interface.ts";
import { AgentSession } from "@earendil-works/pi-coding-agent";

test("submit exposes an object-root provider schema and rejects mismatched job arguments before launch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-interface-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const tools = new Map<string, any>(); let prepared = false;
  try {
    await registerJobs({ registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {}, registerCommand() {}, on() {} } as any,
      { delegate: Type.Object({ type: Type.String(), task: Type.String() }), workflow: Type.Object({ task: Type.String(), branch: Type.String() }), experiment: Type.Object({ spec: Type.String() }), schedule: Type.Object({ action: Type.Literal("run") }) },
      () => { prepared = true; throw new Error("unexpected preparation"); });
    const submit = tools.get("piccolo_submit");
    // Native provider adapters consume top-level object properties. An anyOf
    // root lost the argument definitions in the live Claude tool declaration.
    assert.equal(submit.parameters.type, "object"); assert.ok(submit.parameters.properties.arguments);
    await assert.rejects(submit.execute("test", { kind: "workflow", arguments: { action: "run" } }), /selected job kind/);
    await assert.rejects(submit.execute("test", { kind: "delegate", arguments: '{"type":"worker","task":"task"}' }), /selected job kind/);
    assert.equal(prepared, false);
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; fs.rmSync(root, { recursive: true }); }
});

test("completion cannot steal a parent prompt during input, auth, or before-start preflight", async () => {
  for (const phase of ["input", "auth", "before-start", "idle", "active"] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-notify-"));
    const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
    const tools = new Map<string, any>(); const handlers = new Map<string, Function>();
    const starts: string[] = []; const errors: string[] = []; const queued: any[] = [];
    let finishJob!: () => void; let release!: () => void; let entered!: () => void;
    let observedNotification!: () => void;
    const notification = new Promise<void>(resolve => { observedNotification = resolve; });
    const preflight = new Promise<void>(resolve => { entered = resolve; });
    const hold = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
    let busy = phase === "active";
    // Use the actual SDK prompt/custom-message admission code without network.
    const session: any = Object.create(AgentSession.prototype);
    Object.defineProperties(session, { model: { value: { provider: "fixture", id: "fixture" } }, isStreaming: { get: () => busy } });
    Object.assign(session, {
      _modelRuntime: { hasConfiguredAuth: () => phase !== "auth", async checkAuth() { await hold(); return "fixture"; } },
      _baseSystemPromptOptions: { selectedTools: [] }, _pendingToolNames: new Set(),
      _recordSelection() {}, getActiveToolNames: () => [], _preparePromptAndToolLoadout() {},
      _handlePostAgentRun: async () => false, _runBeforeSettleBoundary: async () => false, _emitAgentSettled: async () => {},
      _pendingNextTurnMessages: [], _baseSystemPrompt: "fixture",
      agent: { state: {}, followUp: (message: any) => queued.push(message) },
      _flushPendingBashMessages() {}, _flushPendingCustomMessages() {}, _findLastAssistantMessage() {},
      _extensionRunner: {
        hasHandlers: () => phase === "input",
        async emitInput() { await hold(); return { action: "continue" }; },
        async emitBeforeAgentStart() { if (phase === "before-start") await hold(); return { messages: [], systemPromptOptions: { selectedTools: [] } }; },
      },
      async modelPrompt(messages: any) {
        if (busy) throw new Error("Agent is already processing a prompt");
        starts.push(Array.isArray(messages) ? "user" : "notification");
      },
    });
    session.agent.prompt = session.modelPrompt;
    const pi: any = {
      events: { emit() {} }, registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {}, registerCommand() {},
      on: (event: string, handler: Function) => handlers.set(event, handler),
      sendMessage: (message: any, options: any) => { session.sendCustomMessage(message, options)
        .catch((error: Error) => errors.push(error.message)).finally(observedNotification); },
    };
    const ctx: any = { cwd: root, hasUI: false, isIdle: () => !busy, sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined } };
    try {
      const schema = Type.Object({});
      await registerJobs(pi, { delegate: schema, workflow: schema, experiment: schema, schedule: schema }, () => ({ snapshot: {}, settings: { executor: "native", notifications: "follow_up" }, execute: async () => { await new Promise<void>(resolve => { finishJob = resolve; }); return { status: "completed" }; } }));
      await tools.get("piccolo_submit").execute("submit", { kind: "delegate", arguments: {} }, undefined, undefined, ctx);
      if (phase === "active") handlers.get("agent_start")!({}, ctx);
      let original: Promise<unknown> | undefined;
      if (!["active", "idle"].includes(phase)) {
        original = session.prompt("ORIGINAL USER PROMPT", { expandPromptTemplates: false });
        await preflight;
      }
      finishJob();
      let notificationTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([notification, new Promise<never>((_, reject) => {
          notificationTimeout = setTimeout(() => reject(new Error(`Missing ${phase} completion notification`)), 5000);
        })]);
      } finally { clearTimeout(notificationTimeout); }
      assert.deepEqual(starts, [], phase);
      assert.deepEqual(errors, [], phase);
      if (phase === "active") {
        assert.equal(queued.length, 1); assert.equal(session._pendingNextTurnMessages.length, 0);
        handlers.get("agent_end")!({}, ctx); busy = false;
      } else {
        assert.equal(queued.length, 0); assert.equal(session._pendingNextTurnMessages.length, 1);
        assert.equal(session._pendingNextTurnMessages[0].details.delivery, "next_turn_compat");
        if (original) { release(); await original; assert.deepEqual(starts, ["user"]); }
      }
    } finally {
      await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("Result and Status hold the job menu until the native detail view is dismissed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-detail-menu-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const tools = new Map<string, any>(); const handlers = new Map<string, Function>(); const commands = new Map<string, any>();
  let view: any; let selections = 0; let action = "Result"; let id = "";
  const pi: any = { events: { emit() {} }, registerTool: (t: any) => tools.set(t.name, t), registerMessageRenderer() {}, registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, f: Function) => handlers.set(name, f), sendMessage() {} };
  const ctx: any = { cwd: root, hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => "detail-test", getSessionFile: () => undefined }, ui: {
    setStatus() {}, notify() {},
    async select() { selections++; return action; },
    custom(factory: any) { return new Promise<any>(resolve => {
      const component = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, resolve);
      if (component.constructor.name === "JobListView") {
        selections++; component.handleInput(selections === 1 ? "\r" : "\x1b");
      } else view = component;
    }); },
  } };
  try {
    const schema = Type.Object({});
    await registerJobs(pi, { delegate: schema, workflow: schema, experiment: schema, schedule: schema }, () => ({ snapshot: {}, settings: { executor: "native" }, execute: async () => ({ result: { kind: "text", text: "README summary\nRun npm test" }, status: "completed" }) }));
    const submitted = await tools.get("piccolo_submit").execute("submit", { kind: "delegate", arguments: {} }, undefined, undefined, ctx);
    id = submitted.details.id;
    await tools.get("piccolo_jobs").execute("wait", { action: "wait", id, wait_ms: 1000 });
    for (action of ["Result", "Status"]) {
      selections = 0; view = undefined;
      const menu = commands.get("piccolo-jobs").handler("", ctx);
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(view); assert.equal(selections, 2, "job list must not reopen over result");
      assert.match(view.render(100).join("\n"), action === "Result" ? /README summary/ : /completed/);
      view.handleInput(action === "Result" ? "\x1b" : "\r");
      await menu; assert.equal(selections, 3);
      const status = await tools.get("piccolo_jobs").execute("status", { action: "status", id });
      assert.equal(status.details.state, "completed"); assert.equal(status.details.stopping, false);
    }
  } finally {
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true });
  }
});

test("health resolution acknowledges only an inspected terminal result and updates pending UI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-ack-health-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const tools = new Map<string, any>(), handlers = new Map<string, Function>();
  const diagnostics: unknown[] = []; let status = "";
  const pi: any = { events: { emit() {} }, registerTool: (t: any) => tools.set(t.name, t), registerMessageRenderer() {}, registerCommand() {}, on: (n: string, f: Function) => handlers.set(n, f), sendMessage() {}, appendEntry: (...args: unknown[]) => diagnostics.push(args) };
  const ctx: any = { cwd: root, hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => "ack", getSessionFile: () => undefined }, ui: { setStatus: (_name: string, text: string) => { status = text; }, notify() {} } };
  try {
    const schema = Type.Object({});
    const runtime = await registerJobs(pi, { delegate: schema, workflow: schema, experiment: schema, schedule: schema }, () => ({ snapshot: {}, settings: { executor: "native" }, execute: async () => ({ status: "completed", result: "verified fixture" }) }));
    const job = (await tools.get("piccolo_submit").execute("s", { kind: "delegate", arguments: {} }, undefined, undefined, ctx)).details.id;
    await new Promise(resolve => setImmediate(resolve));
    assert.match(status, /1 await review/);
    const event = { toolName: "harness_health", isError: false, input: { action: "disposition", disposition: "resolved", id: "incident" }, details: { scope: "harness-only", incidents: [{ id: "incident", disposition: "resolved", component: "attention", reason: "verified_recovery", reference: { kind: "job", id: job } }] } };
    handlers.get("tool_result")!(event, ctx);
    assert.equal(diagnostics.length, 1); assert.equal(runtime.health("ack")[0].acknowledged, false);
    await tools.get("piccolo_jobs").execute("r", { action: "result", id: job });
    handlers.get("tool_result")!(event, ctx);
    assert.equal(runtime.health("ack")[0].acknowledged, true); assert.match(status, /0 await review/);
    const result = (await tools.get("piccolo_jobs").execute("r", { action: "result", id: job })).details;
    assert.equal(result.state, "completed"); assert.match(result.parent_review.note, /Health incident incident/);
  } finally {
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true });
  }
});

test("pointer-only result and wait cannot authorize acknowledgment; complete revision-bound pages can", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-large-result-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const tools = new Map<string, any>(), handlers = new Map<string, Function>();
  const pi: any = { events: { emit() {} }, registerTool: (t: any) => tools.set(t.name, t), registerMessageRenderer() {}, registerCommand() {}, on: (n: string, f: Function) => handlers.set(n, f), sendMessage() {}, appendEntry() {} };
  const ctx: any = { cwd: root, hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => "large", getSessionFile: () => undefined } };
  try {
    const schema = Type.Object({});
    const runtime = await registerJobs(pi, { delegate: schema, workflow: schema, experiment: schema, schedule: schema }, () => ({ snapshot: {}, settings: { executor: "native" }, execute: async () => ({ status: "completed", result: "x".repeat(20000) }) }));
    const id = (await tools.get("piccolo_submit").execute("s", { kind: "delegate", arguments: {} }, undefined, undefined, ctx)).details.id;
    const call = async (params: any) => (await tools.get("piccolo_jobs").execute("check", { id, ...params })).details;
    assert.equal((await call({ action: "wait", wait_ms: 1000 })).truncated, true);
    assert.equal((await call({ action: "result" })).truncated, true);
    const revision = (await call({ action: "status" })).outcome_revision;
    await assert.rejects(call({ action: "ack", revision, note: "unseen" }), /Inspect/);
    const event = { toolName: "harness_health", isError: false, input: { action: "disposition", disposition: "resolved", id: "incident" }, details: { scope: "harness-only", incidents: [{ id: "incident", disposition: "resolved", component: "attention", reason: "verified_recovery", reference: { kind: "job", id } }] } };
    handlers.get("tool_result")!(event, ctx);
    assert.equal(runtime.health("large")[0].acknowledged, false);
    const last = await call({ action: "result_page", revision, offset: 20000 });
    assert.equal(last.inspected, false, "last page alone is not inspection");
    let offset: number | null = 0, page: any;
    do { page = await call({ action: "result_page", revision, offset }); assert.ok(!page.truncated); offset = page.next_offset; } while (offset !== null);
    assert.equal(page.inspected, true);
    handlers.get("tool_result")!(event, ctx);
    assert.equal(runtime.health("large")[0].acknowledged, true);
  } finally {
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true });
  }
});
