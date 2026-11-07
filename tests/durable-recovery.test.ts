import piccolo from "../extensions/piccolo.ts";
import { applyProfile } from "../src/profiles.ts";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createStageTask } from "../src/durable/stage.ts";
import { Decisions } from "../src/durable/jobs.ts";
import { RemoteSnapshots } from "../src/durable/remote-task.ts";
import { setRecoveryNotice } from "../src/durable/recovery-notices.ts";
import { JobsDoc } from "../src/durable/worker.ts";
import { digest } from "../src/config.ts";
import { DurableWorker } from "../src/durable/worker.ts";
import { managedModels } from "../src/durable/models.ts";
import { askParent } from "../src/durable/supervisor.ts";
import { serveWorker } from "../src/durable/service.ts";
import { dispatchRemote, workerRequest } from "../src/durable/remote.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerJobs } from "../src/job-interface.ts";
import { localJobs } from "../src/durable/local.ts";
import { loadConfig, resolveAgent } from "../src/config.ts";
import { discoverJobs, probeJobs } from "../src/durable/recovery.ts";

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error("Recovery condition timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-recovery-ui-"))), session = randomUUID();
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n/.pi/\n");
  const policy = path.join(root, "policy.ts"), policyConfig = path.join(root, "policy.json");
  fs.writeFileSync(policy, 'export default function(pi) { pi.on("tool_result", () => undefined); }\n');
  fs.writeFileSync(policyConfig, JSON.stringify({ version: 1, revision: "fixture", extensions: [policy] }));
  const prior = { policy: process.env.PICCOLO_WORKER_POLICY, agent: process.env.PI_CODING_AGENT_DIR, state: process.env.XDG_STATE_HOME, config: process.env.XDG_CONFIG_HOME };
  process.env.PICCOLO_WORKER_POLICY = policyConfig; process.env.PI_CODING_AGENT_DIR = path.join(root, ".pi"); process.env.XDG_STATE_HOME = path.join(root, ".cache", "state"); process.env.XDG_CONFIG_HOME = path.join(root, ".config");
  let requests = 0;
  const model: any = { id: "fixture", provider: "fixture", api: "openai-completions", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const registry: any = { find: () => model, getAvailable: () => [model], getAll: () => [model], getModelsOfType: () => [model], streamSimple: (_model: any, transcript: any) => {
    requests++; const stream = createAssistantMessageEventStream();
    const answered = JSON.stringify(transcript.messages).includes("Proceed");
    const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: answered ? [{ type: "text", text: "done" }] : [{ type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Choose next step" } }],
      stopReason: answered ? "stop" : "toolUse", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "done", reason: message.stopReason, message }); return stream;
  } };
  const notices: any[] = [], selections: string[] = [], prompts: string[] = [], handlers = new Map<string, Function>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  const ctx: any = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true, modelRegistry: registry, model,
    sessionManager: { getSessionId: () => session, getSessionFile: () => undefined }, ui: { setStatus() {}, notify() {}, async select(title: string) { prompts.push(title); return selections.shift() ?? "Keep suspended"; } } };
  const pi: any = { events: { emit() {} }, getSettings: () => ({ compaction: { enabled: false } }),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {}, registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, callback: Function) => handlers.set(name, callback), sendMessage: (message: any, options: any) => notices.push({ message, options }) };
  const prepare = (_kind: any, args: any) => { const resolved = loadConfig(root, { userFile: path.join(root, "missing.toml") });
    return { settings: resolved.config.background, snapshot: { kind: "delegate", arguments: args, resolved,
      agents: { delegate: resolveAgent(resolved, "implementer") }, parent: { model: "fixture/fixture", effort: "off" } }, execute: async () => { throw new Error("Native must be explicitly selected"); } }; };
  return { root, session, ctx, pi, notices, selections, prompts, handlers, tools, commands, prepare, count: () => requests,
    async register() { const schema = Type.Object({ task: Type.String() }); await registerJobs(pi, { delegate: schema, workflow: schema, schedule: schema, experiment: schema }, prepare); },
    async call(params: any) { return (await tools.get("piccolo_jobs").execute("control", params, undefined, undefined, ctx)).details; },
    cleanup() { for (const [key, value] of [["PICCOLO_WORKER_POLICY", prior.policy], ["PI_CODING_AGENT_DIR", prior.agent], ["XDG_STATE_HOME", prior.state], ["XDG_CONFIG_HOME", prior.config]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } fs.rmSync(root, { recursive: true, force: true }); } };
}

for (const reason of ["startup", "resume"] as const) test(`${reason} discovers saved Jobs before inference and explicit resume restores questions/results`, { timeout: 20000 }, async () => {
  const f = fixture(); let local: Awaited<ReturnType<typeof localJobs>> | undefined;
  try {
    local = await localJobs(f.root, f.ctx, { nativeSettings: f.pi.getSettings(), changed() {}, notify() {} });
    const id = randomUUID(), request: any = { version: 1, registry: "piccolo-1", requestId: id, workspace: local.workspace, owner: f.session, lifetime: "session", configDigest: "0".repeat(64), kind: "delegate",
      stage: { name: "delegate", task: "Answer", model: { provider: "fixture", modelId: "fixture" }, instructions: "Fixture", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 } };
    await local.jobs.submit(request); await eventually(async () => { await local!.jobs.refresh(); return local!.jobs.status(id).attention_total === 1; });
    await local.jobs.close("suspend"); local = undefined;
    const before = f.count(); await f.register(); await f.handlers.get("session_start")!({ reason }, f.ctx);
    assert.equal(f.count(), before); assert.equal(f.prompts.length, 1); assert.match(f.prompts[0], new RegExp(id));
    const inventory = await f.call({ action: "recovery" }); assert.equal(inventory.jobs.length, 1); assert.equal(inventory.jobs[0].attention.length, 1);
    assert.ok(f.notices.every(notice => notice.options.triggerTurn === false));
    await assert.rejects(f.tools.get("piccolo_submit").execute("new", { kind: "delegate", arguments: { task: "new" } }, undefined, undefined, f.ctx), /Saved Jobs are suspended/);
    await f.call({ action: "resume" }); await f.call({ action: "message", id, text: "Proceed", message_id: randomUUID() });
    await eventually(async () => (await f.call({ action: "status", id })).state === "completed");
    assert.equal((await f.call({ action: "result", id })).result.text, "done");
    await f.handlers.get("session_shutdown")!({ reason: "quit" }, f.ctx);
  } finally { if (local) await local.jobs.close("suspend"); await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); f.cleanup(); }
});

test("production suspend and resume retain session identity and notify_only preference", { timeout: 20000 }, async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, ".piccolo"));
    fs.writeFileSync(path.join(f.root, ".piccolo", "config.toml"), '[background]\nnotifications = "notify_only"\n');
    await f.register(); await f.handlers.get("session_start")!({ reason: "startup" }, f.ctx);
    const id = (await f.tools.get("piccolo_submit").execute("submit", { kind: "delegate", arguments: { task: "Answer" } }, undefined, undefined, f.ctx)).details.id;
    await eventually(async () => (await f.call({ action: "status", id })).attention_total === 1);
    const before = f.count(), suspended = await f.call({ action: "suspend" }); assert.equal(suspended.suspended, true);
    const listed = await f.call({ action: "list" }); assert.equal(listed.jobs[0].id, id); assert.equal(f.count(), before);
    await f.call({ action: "resume" });
    await f.call({ action: "message", id, text: "Proceed", message_id: randomUUID() });
    await eventually(async () => (await f.call({ action: "status", id })).state === "completed");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(f.notices.every(notice => notice.options.triggerTurn === false));
    assert.ok(f.notices.some(notice => notice.message.details?.jobs?.includes(id) && !notice.message.details.delivery));
  } finally { await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); f.cleanup(); }
});

test("discovery reports an unavailable original remote and does not submit or change its assignment", { timeout: 15000 }, async () => {
  const f = fixture(); let local: Awaited<ReturnType<typeof localJobs>> | undefined;
  try {
    local = await localJobs(f.root, f.ctx, { nativeSettings: f.pi.getSettings(), changed() {}, notify() {} });
    const request: any = { version: 1, registry: "piccolo-1", requestId: randomUUID(), workspace: local.workspace, owner: f.session, lifetime: "session", configDigest: "0".repeat(64), kind: "delegate",
      stage: { name: "delegate", task: "Answer", model: { provider: "fixture", modelId: "fixture" }, instructions: "Fixture", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 },
      placement: { workspace: { ...local.workspace, identity: randomUUID() }, transport: ["python3", "-c", "import sys; sys.exit(1)"] } };
    await local.jobs.submit(request); await local.jobs.close("suspend"); local = undefined;
    const before = f.count(), inventory = await probeJobs(await discoverJobs(f.root, f.session, f.ctx));
    assert.equal(inventory.jobs[0].availability, "unavailable"); assert.match(inventory.jobs[0].reason!, /may still exist/); assert.equal(f.count(), before);
  } finally { if (local) await local.jobs.close("suspend"); f.cleanup(); }
});

test("new parent discovers and attaches independent remote progress without a client worker policy", { timeout: 20000 }, async () => {
  const f = fixture(), identity = { host: os.hostname(), cwd: f.root, identity: randomUUID() };
  const worker = await DurableWorker.open({ workspace: identity, storage: new MemoryStorage(), models: managedModels(f.ctx.modelRegistry), tools: [askParent], env: () => undefined });
  const socket = path.join(f.root, "worker.sock"), server = await serveWorker(worker, identity, socket, async () => {});
  const target = { workspace: identity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] };
  const original: any = { version: 1, registry: "piccolo-1", requestId: randomUUID(), workspace: identity, owner: f.session, lifetime: "independent", configDigest: "0".repeat(64), kind: "delegate",
    stage: { name: "delegate", task: "Answer", model: { provider: "fixture", modelId: "fixture" }, instructions: "Fixture", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 } };
  try {
    await dispatchRemote(f.root, target, original); await eventually(async () => (await worker.status(original.requestId)).attention.length === 1);
    const next = randomUUID(); f.ctx.sessionManager.getSessionId = () => next;
    fs.mkdirSync(path.join(f.root, ".piccolo")); fs.writeFileSync(path.join(f.root, ".piccolo", "config.toml"), `[hosts.test]\nhostname = ${JSON.stringify(identity.host)}\ncwd = ${JSON.stringify(identity.cwd)}\nworker_identity = ${JSON.stringify(identity.identity)}\nworker_transport = ${JSON.stringify(target.transport)}\n`);
    delete process.env.PICCOLO_WORKER_POLICY;
    await f.register(); await f.handlers.get("session_start")!({ reason: "startup" }, f.ctx);
    const inventory = await f.call({ action: "recovery" }); assert.equal(inventory.independent[0].id, original.requestId); assert.equal(inventory.independent[0].availability, "available");
    await f.call({ action: "attach", id: original.requestId, host: "test" });
    await eventually(async () => (await f.call({ action: "status", id: original.requestId })).attention_total === 1);
    assert.equal((await f.call({ action: "list" })).jobs[0].lifetime, "independent"); assert.equal(f.count(), 1);
    await f.handlers.get("session_shutdown")!({ reason: "quit" }, f.ctx);
    assert.notEqual((await worker.inspect(original.requestId)).task!.state.status, "terminal");
    await workerRequest(target, { operation: "message", requestId: original.requestId, messageId: randomUUID(), text: "Proceed" }); await worker.wait(original.requestId);
    assert.equal(f.count(), 2);
  } finally { await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); await new Promise<void>(resolve => server.close(() => resolve())); await worker.close("suspend"); f.cleanup(); }
});

test("production foreground delegate uses Durable and returns parent questions without blocking the parent", { timeout: 20000 }, async () => {
  const f = fixture(); let nativeRequests = 0;
  try {
    applyProfile(f.root, loadConfig(f.root, { userFile: path.join(f.root, "missing.toml") }));
    f.pi.getThinkingLevel = () => "off";
    f.pi.events.on = () => () => {};
    f.pi.events.emit = (name: string) => { if (name === "prompt-template:subagent:request") nativeRequests++; };
    await piccolo(f.pi);
    await f.handlers.get("session_start")!({ reason: "startup" }, f.ctx);
    const first = await f.tools.get("piccolo_delegate").execute("foreground", { type: "implementer", task: "Answer" }, undefined, undefined, f.ctx);
    assert.equal(first.details.status, "needs_parent"); assert.equal(first.details.attention.length, 1); assert.equal(nativeRequests, 0);
    await f.call({ action: "message", id: first.details.job_id, text: "Proceed", message_id: randomUUID() });
    await eventually(async () => (await f.call({ action: "status", id: first.details.job_id })).state === "completed");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(f.notices.some(notice => notice.message.details?.jobs?.includes(first.details.job_id)), "yielded foreground Job completion remains visible");
    const second = await f.tools.get("piccolo_delegate").execute("foreground2", { type: "implementer", task: "Proceed directly" }, undefined, undefined, f.ctx);
    assert.equal(second.details.status, "completed"); assert.equal(second.details.result.text, "done"); assert.equal(nativeRequests, 0);
  } finally { await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); f.cleanup(); }
});

test("RPC startup informs without waiting for a dialog; the first prompt asks before inference", { timeout: 20000 }, async () => {
  const f = fixture(); let local: Awaited<ReturnType<typeof localJobs>> | undefined;
  try {
    local = await localJobs(f.root, f.ctx, { changed() {}, notify() {} });
    const id = randomUUID(), request: any = { version: 1, registry: "piccolo-1", requestId: id, workspace: local.workspace, owner: f.session, lifetime: "session", configDigest: "0".repeat(64), kind: "delegate",
      stage: { name: "delegate", task: "Answer", model: { provider: "fixture", modelId: "fixture" }, instructions: "Fixture", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 } };
    await local.jobs.submit(request); await eventually(async () => { await local!.jobs.refresh(); return local!.jobs.status(id).attention_total === 1; });
    await local.jobs.close("suspend"); local = undefined; f.ctx.mode = "rpc";
    const before = f.count(); await f.register(); await f.handlers.get("session_start")!({ reason: "startup" }, f.ctx);
    assert.equal(f.prompts.length, 0, "RPC input reader is not attached during startup"); assert.equal(f.count(), before);
    await f.handlers.get("before_agent_start")!({}, f.ctx);
    assert.equal(f.prompts.length, 1); assert.match(f.prompts[0], new RegExp(id)); assert.equal(f.count(), before);
    await f.handlers.get("before_agent_start")!({}, f.ctx); assert.equal(f.prompts.length, 1);
  } finally { if (local) await local.jobs.close("suspend"); await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); f.cleanup(); }
});

for (const profile of ["native_compare", "contributed_native_compare", "durable_compare"]) test(`foreground executor follows ${profile} invocation configuration`, { timeout: 15000 }, async () => {
  const f = fixture(); const listeners = new Map<string, Function[]>(); let nativeRequests = 0;
  try {
    fs.mkdirSync(path.join(f.root, ".piccolo"));
    fs.writeFileSync(path.join(f.root, ".piccolo", "config.toml"), `[background]\nexecutor = "${profile === "durable_compare" ? "native" : "durable"}"\n[profiles.native_compare.background]\nexecutor = "native"\n[profiles.durable_compare.background]\nexecutor = "durable"\n`);
    applyProfile(f.root, loadConfig(f.root, { userFile: path.join(f.root, "missing.toml") }));
    f.pi.getThinkingLevel = () => "off";
    f.pi.events.on = (name: string, fn: Function) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => {}; };
    f.pi.events.emit = (name: string, value: any) => {
      if (name === "pi-subagents:runtime-agent-register:v1") value.result = { ok: true, registration: { dispose() {} } };
      if (name === "prompt-template:subagent:request") {
        nativeRequests++; queueMicrotask(() => { for (const fn of listeners.get("prompt-template:subagent:response") ?? []) fn({ ...value, status: "completed", result: { kind: "text", text: "NATIVE-DONE" } }); });
      }
      for (const fn of listeners.get(name) ?? []) fn(value);
    };
    await piccolo(f.pi);
    if (profile === "contributed_native_compare") {
      const contribution = { contribution: { id: "fixture-profiles", version: "1", config: { profiles: { contributed_native_compare: { background: { executor: "native" } } } } }, result: undefined as any };
      f.pi.events.emit("piccolo:contribute:v1", contribution); assert.equal(contribution.result.ok, true);
    }
    const result = await f.tools.get("piccolo_delegate").execute("foreground", { type: "implementer", task: "Proceed directly", profile }, undefined, undefined, f.ctx);
    assert.equal(result.details.status, "completed"); assert.equal(nativeRequests, profile === "durable_compare" ? 0 : 1);
    assert.equal(result.details.result.text, profile === "durable_compare" ? "done" : "NATIVE-DONE");
  } finally { await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); f.cleanup(); }
});

for (const action of ["submit", "attach"]) test(`native session configuration cannot bypass saved Durable recovery through remote ${action}`, { timeout: 20000 }, async () => {
  const f = fixture(); let local: Awaited<ReturnType<typeof localJobs>> | undefined;
  const identity = { host: os.hostname(), cwd: f.root, identity: randomUUID() };
  const remote = await DurableWorker.open({ workspace: identity, storage: new MemoryStorage(), models: managedModels(f.ctx.modelRegistry), tools: [askParent], env: () => undefined });
  const socket = path.join(f.root, "worker.sock"), server = await serveWorker(remote, identity, socket, async () => {});
  const target = { workspace: identity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] };
  try {
    local = await localJobs(f.root, f.ctx, { changed() {}, notify() {} });
    const request: any = { version: 1, registry: "piccolo-1", requestId: randomUUID(), workspace: local.workspace, owner: f.session, lifetime: "session", configDigest: "0".repeat(64), kind: "delegate",
      stage: { name: "delegate", task: "Answer", model: { provider: "fixture", modelId: "fixture" }, instructions: "Fixture", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 } };
    await local.jobs.submit(request); await eventually(async () => (await local!.jobs.worker.status(request.requestId)).attention.length === 1);
    await local.jobs.close("suspend"); local = undefined;
    const independent = { ...request, requestId: randomUUID(), workspace: identity, lifetime: "independent" };
    if (action === "attach") await dispatchRemote(f.root, target, independent);
    fs.mkdirSync(path.join(f.root, ".piccolo")); fs.writeFileSync(path.join(f.root, ".piccolo", "config.toml"), `[background]\nexecutor = "native"\n[hosts.test]\nhostname = ${JSON.stringify(identity.host)}\ncwd = ${JSON.stringify(identity.cwd)}\nworker_identity = ${JSON.stringify(identity.identity)}\nworker_transport = ${JSON.stringify(target.transport)}\n`);
    applyProfile(f.root, loadConfig(f.root, { userFile: path.join(f.root, "missing.toml") }));
    f.pi.getThinkingLevel = () => "off"; f.pi.events.on = () => () => {};
    await piccolo(f.pi); await f.handlers.get("session_start")!({ reason: "resume" }, f.ctx);
    const invoke = action === "attach" ? f.call({ action: "attach", id: independent.requestId, host: "test" }) : f.tools.get("piccolo_submit").execute("new", { kind: "delegate", host: "test", arguments: { type: "implementer", task: "Answer" } }, undefined, undefined, f.ctx);
    await assert.rejects(invoke, /Saved Jobs are suspended/);
    assert.ok((await f.call({ action: "recovery" })).jobs.some((job: any) => job.id === request.requestId));
  } finally { if (local) await local.jobs.close("suspend"); await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); f.cleanup(); }
});

test("plain Pi Durable default does not require an environment policy file", { timeout: 10000 }, async () => {
  const f = fixture();
  try {
    delete process.env.PICCOLO_WORKER_POLICY;
    await f.register();
    const submitted = (await f.tools.get("piccolo_submit").execute("submit", { kind: "delegate", arguments: { task: "Proceed directly" } }, undefined, undefined, f.ctx)).details;
    await eventually(async () => (await f.call({ action: "status", id: submitted.id })).state === "completed");
    assert.equal((await f.call({ action: "result", id: submitted.id })).result.text, "done");
  } finally { await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); f.cleanup(); }
});

test("cancel_saved marks all paused Jobs before enabling their cancellation and permits new work", { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    await f.register();
    const id = (await f.tools.get("piccolo_submit").execute("submit", { kind: "delegate", arguments: { task: "Answer" } }, undefined, undefined, f.ctx)).details.id;
    await eventually(async () => (await f.call({ action: "status", id })).attention_total === 1);
    await f.call({ action: "suspend" }); const before = f.count();
    await f.call({ action: "cancel_saved" });
    await eventually(async () => (await f.call({ action: "status", id })).state === "cancelled"); assert.equal(f.count(), before);
    const next = (await f.tools.get("piccolo_submit").execute("submit", { kind: "delegate", arguments: { task: "Proceed directly" } }, undefined, undefined, f.ctx)).details.id;
    await eventually(async () => (await f.call({ action: "status", id: next })).state === "completed");
  } finally { await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); f.cleanup(); }
});

test("suspending terminal Jobs does not change a new owner's quit cancellation", { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    await f.register();
    const first = (await f.tools.get("piccolo_submit").execute("submit", { kind: "delegate", arguments: { task: "Proceed directly" } }, undefined, undefined, f.ctx)).details.id;
    await eventually(async () => (await f.call({ action: "status", id: first })).state === "completed"); await f.call({ action: "suspend" });
    const next = (await f.tools.get("piccolo_submit").execute("submit", { kind: "delegate", arguments: { task: "Answer" } }, undefined, undefined, f.ctx)).details.id;
    await eventually(async () => (await f.call({ action: "status", id: next })).attention_total === 1);
    await f.handlers.get("session_shutdown")!({ reason: "quit" }, f.ctx);
    const saved = await discoverJobs(f.root, f.session, f.ctx); assert.equal(saved.jobs.find(job => job.id === next)?.state, "aborted");
  } finally { await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); f.cleanup(); }
});

test("foreground delegate keeps cwd and task/parent associations in contract v2", { timeout: 10000 }, async () => {
  const f = fixture(), child = path.join(f.root, "nested"); fs.mkdirSync(child); f.ctx.cwd = child;
  try {
    applyProfile(child, loadConfig(f.root, { userFile: path.join(f.root, "missing.toml") }));
    f.pi.getThinkingLevel = () => "off"; f.pi.events.on = () => () => {};
    await piccolo(f.pi);
    const result = await f.tools.get("piccolo_delegate").execute("delegate", { type: "implementer", task: "Proceed directly", task_id: "task-42", parent_run_id: "parent-7" }, undefined, undefined, f.ctx);
    assert.equal(result.details.execution_contract, 2); assert.equal(result.details.cwd, child); assert.deepEqual(result.details.origin, { taskId: "task-42", parentRunId: "parent-7" });
    assert.equal(result.details.model, "fixture/fixture"); assert.equal(result.details.effort, "off");
  } finally { await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); f.cleanup(); }
});

for (const managed of [true, false]) test(`remote-first controller ${managed ? "rejects unqualified managed" : "permits configured plain"} local execution`, { timeout: 10000 }, async () => {
  const f = fixture(); let local: Awaited<ReturnType<typeof localJobs>> | undefined;
  const identity = { host: os.hostname(), cwd: f.root, identity: randomUUID() };
  const remote = await DurableWorker.open({ workspace: identity, storage: new MemoryStorage(), models: managedModels(f.ctx.modelRegistry), tools: [askParent], env: () => undefined });
  const socket = path.join(f.root, "worker.sock"), server = await serveWorker(remote, identity, socket, async () => {});
  const target = { workspace: identity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] };
  try {
    delete process.env.PICCOLO_WORKER_POLICY;
    local = await localJobs(f.root, f.ctx, { dispatchOnly: true, managedPolicy: managed, workerPolicy: { version: 1, revision: "plain", extensions: [] }, changed() {}, notify() {} });
    const request: any = { version: 1, registry: "piccolo-1", requestId: randomUUID(), workspace: local.workspace, owner: f.session, lifetime: "session", configDigest: "0".repeat(64), kind: "delegate",
      stage: { name: "delegate", task: "Proceed", model: { provider: "fixture", modelId: "fixture" }, instructions: "Proceed", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 } };
    const placed = { ...request, requestId: randomUUID(), placement: target };
    await local.jobs.submit(placed); await local.jobs.worker.wait(placed.requestId); assert.equal(f.count(), 1);
    if (managed) { await assert.rejects(local.jobs.submit(request), /no local worker policy/); assert.equal(f.count(), 1); }
    else { await local.jobs.submit(request); await local.jobs.worker.wait(request.requestId); assert.equal(f.count(), 2); }
  } finally { if (local) await local.jobs.close("suspend"); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); f.cleanup(); }
});

test("saved cancellation clearly scopes a mixed session and detached independent inventory", { timeout: 20000 }, async () => {
  const f = fixture(), confirmations: string[] = [];
  const identity = { host: os.hostname(), cwd: f.root, identity: randomUUID() };
  const remote = await DurableWorker.open({ workspace: identity, storage: new MemoryStorage(), models: managedModels(f.ctx.modelRegistry), tools: [askParent], env: () => undefined });
  const socket = path.join(f.root, "worker.sock"), server = await serveWorker(remote, identity, socket, async () => {});
  const target = { workspace: identity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] };
  try {
    fs.mkdirSync(path.join(f.root, ".piccolo")); fs.writeFileSync(path.join(f.root, ".piccolo", "config.toml"), `[hosts.test]\nhostname = ${JSON.stringify(identity.host)}\ncwd = ${JSON.stringify(identity.cwd)}\nworker_identity = ${JSON.stringify(identity.identity)}\nworker_transport = ${JSON.stringify(target.transport)}\n`);
    await f.register();
    const id = (await f.tools.get("piccolo_submit").execute("submit", { kind: "delegate", arguments: { task: "Answer" } }, undefined, undefined, f.ctx)).details.id;
    await eventually(async () => (await f.call({ action: "status", id })).attention_total === 1);
    await f.call({ action: "suspend" });
    const detached: any = { version: 1, registry: "piccolo-1", requestId: randomUUID(), workspace: identity, owner: "other-parent", lifetime: "independent", configDigest: "0".repeat(64), kind: "delegate",
      stage: { name: "delegate", task: "Answer", model: { provider: "fixture", modelId: "fixture" }, instructions: "Answer", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 } };
    await dispatchRemote(f.root, target, detached); await eventually(async () => (await remote.status(detached.requestId)).attention.length === 1);
    f.ctx.ui.confirm = async (title: string, body: string) => { confirmations.push(`${title} ${body}`); return true; };
    f.selections.push("Cancel saved Jobs"); await f.handlers.get("session_start")!({ reason: "resume" }, f.ctx);
    assert.match(f.prompts.at(-1)!, new RegExp(detached.requestId));
    assert.match(confirmations[0], /this session's saved Jobs/); assert.match(confirmations[0], /Detached Jobs from other parents require attach, then stop/);
    assert.equal((await f.call({ action: "status", id })).state, "cancelled");
    assert.notEqual((await remote.inspect(detached.requestId)).task!.state.status, "terminal");
    await f.call({ action: "attach", id: detached.requestId, host: "test" });
    await f.call({ action: "stop", id: detached.requestId });
    await eventually(async () => (await remote.inspect(detached.requestId)).task!.state.status === "terminal");
  } finally { await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); f.cleanup(); }
});

test("a failed deployment load preserves its required policy boundary for local and remote-first use", { timeout: 10000 }, async () => {
  const f = fixture(), previous = process.env.PICCOLO_REQUIRE_WORKER_POLICY; let local: Awaited<ReturnType<typeof localJobs>> | undefined;
  try {
    delete process.env.PICCOLO_WORKER_POLICY;
    const deployment = () => { process.env.PICCOLO_REQUIRE_WORKER_POLICY = "1"; throw new Error("Required deployment extension is missing"); };
    assert.throws(deployment, /Required deployment extension is missing/);
    assert.equal(process.env.PICCOLO_REQUIRE_WORKER_POLICY, "1");
    const callbacks = { workerPolicy: { version: 1 as const, revision: "plain", extensions: [] }, changed() {}, notify() {} };
    await assert.rejects(localJobs(f.root, f.ctx, callbacks), /Policy-required Durable workers/);
    local = await localJobs(f.root, f.ctx, { ...callbacks, dispatchOnly: true });
    const request: any = { version: 1, registry: "piccolo-1", requestId: randomUUID(), workspace: local.workspace, owner: f.session, lifetime: "session", configDigest: "0".repeat(64), kind: "delegate",
      stage: { name: "delegate", task: "Proceed", model: { provider: "fixture", modelId: "fixture" }, instructions: "Proceed", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 } };
    await assert.rejects(local.jobs.submit(request), /no local worker policy/); assert.equal(f.count(), 0);
  } finally { if (local) await local.jobs.close("suspend"); if (previous === undefined) delete process.env.PICCOLO_REQUIRE_WORKER_POLICY; else process.env.PICCOLO_REQUIRE_WORKER_POLICY = previous; f.cleanup(); }
});

for (const action of ["cancel", "native"] as const) test(`changed policy permits ${action} without executing saved work`, { timeout: 20000 }, async () => {
  const f = fixture(); let local: Awaited<ReturnType<typeof localJobs>> | undefined;
  try {
    local = await localJobs(f.root, f.ctx, { changed() {}, notify() {}, resume: false });
    const id = randomUUID(), request: any = { version: 1, registry: "piccolo-1", requestId: id, workspace: local.workspace, owner: f.session, lifetime: "session", configDigest: "0".repeat(64), kind: "delegate",
      stage: { name: "delegate", task: "Proceed", model: { provider: "fixture", modelId: "fixture" }, instructions: "Proceed", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 } };
    const root = await local.jobs.worker.harness.root(BACKGROUND_CONTEXT);
    await local.jobs.worker.harness.commit(async tx => {
      const taskId = await tx.createTask(createStageTask(() => ({})), { spec: request.stage, cwd: f.root }, { ownership: { kind: "conversation" }, conversationId: root.id });
      (await tx.doc(JobsDoc)).requests[id] = { taskId, fingerprint: digest(request), input: request };
    }, BACKGROUND_CONTEXT);
    await local.jobs.close("suspend"); local = undefined; assert.equal(f.count(), 0);
    fs.appendFileSync(path.join(f.root, "policy.ts"), "// deployment update\n");
    await assert.rejects(localJobs(f.root, f.ctx, { changed() {}, notify() {}, resume: false }), /Worker policy changed/);
    if (action === "native") {
      fs.mkdirSync(path.join(f.root, ".piccolo")); fs.writeFileSync(path.join(f.root, ".piccolo", "config.toml"), '[background]\nexecutor = "native"\n');
      const schema = Type.Object({ task: Type.String() });
      await registerJobs(f.pi, { delegate: schema, workflow: schema, schedule: schema, experiment: schema }, (kind: any, args: any) => ({ ...f.prepare(kind, args), execute: async () => ({ status: "completed", result: { kind: "text", text: "native" } }) }));
    } else await f.register();
    await f.handlers.get("session_start")!({ reason: "resume" }, f.ctx); assert.equal(f.count(), 0);
    if (action === "cancel") {
      await f.call({ action: "cancel_saved" }); assert.equal((await f.call({ action: "status", id })).state, "cancelled");
      await assert.rejects(f.call({ action: "resume" }), /Worker policy changed/);
      const saved = await discoverJobs(f.root, f.session, f.ctx); assert.equal(saved.jobs[0].state, "aborted");
    } else {
      const next = (await f.tools.get("piccolo_submit").execute("native", { kind: "delegate", arguments: { task: "Proceed" } }, undefined, undefined, f.ctx)).details.id;
      await eventually(async () => (await f.call({ action: "status", id: next })).state === "completed");
      assert.equal((await discoverJobs(f.root, f.session, f.ctx)).jobs[0].terminal, false);
    }
    assert.equal(f.count(), 0, "the saved pending stage would generate immediately if resumed");
  } finally { if (local) await local.jobs.close("suspend"); await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); f.cleanup(); }
});


test("a repaired remote outcome notifies again, requires fresh inspection and preserves review history on reopen", { timeout: 20000 }, async () => {
  const f = fixture(), identity = { host: os.hostname(), cwd: f.root, identity: randomUUID() }, notices: string[][] = [];
  const remote = await DurableWorker.open({ workspace: identity, storage: new MemoryStorage(), models: managedModels(f.ctx.modelRegistry), tools: [askParent], env: () => undefined });
  const socket = path.join(f.root, "worker.sock"), server = await serveWorker(remote, identity, socket, async () => {});
  const target = { workspace: identity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] };
  let local: Awaited<ReturnType<typeof localJobs>> | undefined;
  delete process.env.PICCOLO_WORKER_POLICY;
  const open = () => localJobs(f.root, f.ctx, { resume: false, dispatchOnly: true, changed() {}, notify(ids) { notices.push(ids); } });
  try {
    local = await open(); await local.jobs.worker.resumeSaved();
    const request: any = { version: 1, registry: "piccolo-1", requestId: randomUUID(), workspace: local.workspace, owner: f.session, lifetime: "session", configDigest: "0".repeat(64), kind: "delegate", placement: target,
      stage: { name: "delegate", task: "Answer", model: { provider: "fixture", modelId: "fixture" }, instructions: "Fixture", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 } };
    const id = await local.jobs.submit(request);
    await eventually(async () => { await local!.jobs.refresh(); return local!.jobs.status(id).attention_total === 1; });
    await local.jobs.close("suspend"); local = await open();
    const oldId = (await local.jobs.worker.admission(id)).taskId;
    // Preserve a historical failed dispatcher shape without faulting the remote agent.
    await local.jobs.worker.harness.commit(async tx => {
      const task = (await tx.task(oldId as any))!; delete (await tx.doc(RemoteSnapshots)).requests[id];
      (tx as any).setTask({ ...task, state: { status: "terminal", outcome: { status: "failed", error: { message: "legacy lost admission reply" } } }, endedAt: Date.now() });
    }, BACKGROUND_CONTEXT);
    await local.jobs.refresh(); const oldRevision = local.jobs.status(id).outcome_revision!;
    local.jobs.result(id); await local.jobs.acknowledge(id, oldRevision, "Investigated old controller failure");
    await new Promise(resolve => setTimeout(resolve, 150)); notices.length = 0;
    await local.jobs.worker.resumeSaved(); await workerRequest(target, { operation: "message", requestId: id, messageId: randomUUID(), text: "Proceed" });
    await local.jobs.worker.wait(id); await local.jobs.refresh();
    const revision = local.jobs.status(id).outcome_revision!; assert.notEqual(revision, oldRevision);
    assert.equal(local.jobs.status(id).parent_review.disposition, "pending");
    await assert.rejects(local.jobs.acknowledge(id, revision, "New result"), /Inspect this terminal/);
    await eventually(async () => notices.some(ids => ids.includes(id)));
    await local.jobs.close("suspend"); local = undefined;
    const saved = await discoverJobs(f.root, f.session, f.ctx); assert.equal(saved.error, undefined);
    assert.equal(saved.jobs[0].parentReview, "pending"); assert.equal(saved.jobs[0].outcomeRevision, revision);
    local = await open(); await local.jobs.refresh(); local.jobs.result(id); await local.jobs.acknowledge(id, revision, "Accepted new completion");
    const decisions = await local.jobs.worker.harness.snapshot(Decisions, BACKGROUND_CONTEXT);
    assert.equal(decisions!.history![id][0].revision, oldRevision); assert.equal(decisions!.decisions[id].revision, revision);
    await local.jobs.close("suspend"); local = undefined;
    assert.equal((await discoverJobs(f.root, f.session, f.ctx)).jobs[0].parentReview, "acknowledged");
    notices.length = 0; local = await open(); await local.jobs.refresh(); await new Promise(resolve => setTimeout(resolve, 150)); assert.deepEqual(notices, []);
    assert.equal(f.count(), 2, "Repair observes the original agent rather than resubmitting it");
  } finally { if (local) await local.jobs.close("suspend"); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); f.cleanup(); }
});

test("detached independent notices can be dismissed and restored without contacting or changing work", { timeout: 15000 }, async () => {
  const f = fixture(), identity = { host: os.hostname(), cwd: f.root, identity: randomUUID() };
  const remote = await DurableWorker.open({ workspace: identity, storage: new MemoryStorage(), models: managedModels(f.ctx.modelRegistry), tools: [askParent], env: () => undefined });
  const socket = path.join(f.root, "worker.sock"), server = await serveWorker(remote, identity, socket, async () => {});
  const target = { workspace: identity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] };
  const request: any = { version: 1, registry: "piccolo-1", requestId: randomUUID(), workspace: identity, owner: "previous-parent", lifetime: "independent", configDigest: "0".repeat(64), kind: "delegate",
    stage: { name: "delegate", task: "Answer", model: { provider: "fixture", modelId: "fixture" }, instructions: "Fixture", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 } };
  try {
    await dispatchRemote(f.root, target, request); await eventually(async () => (await remote.status(request.requestId)).attention.length === 1);
    const file = path.join(f.root, ".cache", "piccolo", "dispatch", `${request.requestId}.json`), original = fs.readFileSync(file, "utf8");
    await f.register(); await f.handlers.get("session_start")!({}, f.ctx);
    assert.equal((await f.call({ action: "dismiss", id: request.requestId })).dismissed, true);
    assert.equal((await f.call({ action: "recovery" })).independent.length, 0);
    const hidden = await f.call({ action: "recovery", include_dismissed: true }); assert.equal(hidden.independent[0].dismissed, true);
    const noticeFile = file.replace('.json', '.dismissed.json'); assert.equal(fs.statSync(noticeFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, "utf8"), original); assert.notEqual((await remote.inspect(request.requestId)).task!.state.status, "terminal");
    assert.equal((await discoverJobs(f.root, randomUUID(), f.ctx)).independent.length, 0, "Dismissal survives parent changes");
    await f.call({ action: "show_notice", id: request.requestId }); assert.equal((await f.call({ action: "recovery" })).independent.length, 1);
    await f.call({ action: "dismiss", id: request.requestId });
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), newIntentField: true }));
    assert.equal((await discoverJobs(f.root, f.session, f.ctx)).independent.length, 1, "A changed retained intent cannot inherit dismissal");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), submission: { ...request, lifetime: "session" } }));
    assert.throws(() => setRecoveryNotice(f.root, request.requestId, true), /Only retained independent/);
    fs.writeFileSync(file, original); fs.unlinkSync(noticeFile); fs.symlinkSync(file, noticeFile);
    assert.throws(() => setRecoveryNotice(f.root, request.requestId, true), /Invalid recovery/); assert.equal(fs.readFileSync(file, "utf8"), original);
  } finally { await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); f.cleanup(); }
});


test("pending saved cancellation remains waitable and a new submission cannot tear down its controller", { timeout: 15000 }, async () => {
  const f = fixture(); let local: Awaited<ReturnType<typeof localJobs>> | undefined;
  let release!: () => void, entered!: () => void, control: DurableWorker | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const original = (DurableWorker.prototype as any).cancelSaved;
  try {
    local = await localJobs(f.root, f.ctx, { nativeSettings: f.pi.getSettings(), changed() {}, notify() {} });
    const request: any = { version: 1, registry: "piccolo-1", requestId: randomUUID(), workspace: local.workspace, owner: f.session, lifetime: "session", configDigest: "0".repeat(64), kind: "delegate",
      stage: { name: "delegate", task: "Answer", model: { provider: "fixture", modelId: "fixture" }, instructions: "Fixture", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 } };
    await local.jobs.submit(request); await eventually(async () => (await local!.jobs.worker.status(request.requestId)).attention.length === 1);
    await local.jobs.close("suspend"); local = undefined;
    // Hold the real abort completion after durable marks and scheduler enablement.
    (DurableWorker.prototype as any).cancelSaved = function(owner: string, ctx: any) {
      const wait = this.harness.waitForTask.bind(this.harness);
      control = this;
      this.harness.waitForTask = async (...args: any[]) => { if (args[1] === BACKGROUND_CONTEXT) { entered(); await gate; } return wait(...args); };
      return original.call(this, owner, ctx);
    };
    await f.register(); await f.handlers.get("session_start")!({}, f.ctx); const before = f.count();
    await f.call({ action: "cancel_saved" }); await started;
    await assert.rejects(f.tools.get("piccolo_submit").execute("new", { kind: "delegate", arguments: { task: "Proceed" } }, undefined, undefined, f.ctx), /cancellation is still in progress/);
    const pendingWait = f.call({ action: "wait", id: request.requestId, wait_ms: 30 }); await pendingWait;
    assert.equal(f.count(), before); release(); await eventually(async () => !await control!.cancellationInProgress());
    await eventually(async () => (await f.call({ action: "status", id: request.requestId })).state === "cancelled");
    const next = (await f.tools.get("piccolo_submit").execute("new", { kind: "delegate", arguments: { task: "Proceed" } }, undefined, undefined, f.ctx)).details.id;
    await eventually(async () => (await f.call({ action: "status", id: next })).state === "completed");
  } finally { release(); (DurableWorker.prototype as any).cancelSaved = original; if (local) await local.jobs.close("suspend"); await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); f.cleanup(); }
});


test("recovery pages stay bounded and progress through stale notices even with oversized display fields", async () => {
  const f = fixture(), directory = path.join(f.root, ".cache", "piccolo", "dispatch"), ids = Array.from({ length: 32 }, () => randomUUID());
  try {
    fs.mkdirSync(directory, { recursive: true });
    for (const id of ids) fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ assignment: "0".repeat(64), submission: {
      version: 1, registry: "piccolo-1", requestId: id, workspace: { host: "remote.invalid", cwd: "/test", identity: randomUUID() }, owner: "\u0001".repeat(1024), lifetime: "independent", configDigest: "0".repeat(64), kind: "delegate",
      stage: { name: "delegate", task: "Answer", model: { provider: "fixture", modelId: "fixture" }, instructions: "Fixture", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 }
    } }));
    await f.register(); const found = new Set<string>(); let offset: number | null = 0;
    while (offset !== null) {
      const page = await f.call({ action: "recovery", offset, limit: 50 }); assert.ok(JSON.stringify(page).length < 16000); assert.equal(page.truncated, undefined);
      for (const job of page.independent) found.add(job.id);
      if (page.next_offset !== null) assert.ok(page.next_offset > offset);
      offset = page.next_offset;
    }
    assert.equal(found.size, ids.length); assert.equal(f.count(), 0);
  } finally { await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx); f.cleanup(); }
});
