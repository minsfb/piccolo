import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Model, type ToolCall, type Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { WorkerWaitCancelled } from "../src/durable/wait.ts";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { defineTool, defineDoc, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { RemoteSnapshots } from "../src/durable/remote-task.ts";
import { DurableWorker } from "../src/durable/worker.ts";
import { openWorkerStorage } from "../src/durable/storage.ts";
import { submissionSchema, type WorkerSubmission } from "../src/durable/contract.ts";
import { DurableJobs } from "../src/durable/jobs.ts";
import { prepareSubmission } from "../src/durable/prepare.ts";
import { loadConfig, resolveAgent } from "../src/config.ts";
import { askParent, SupervisorDoc } from "../src/durable/supervisor.ts";
import { durablePool } from "../src/durable/pool.ts";
import { exportRoadmap } from "../src/durable/roadmap-export.ts";
import { sourceDigest } from "../src/durable/pipeline.ts";
import { compareTrials } from "../src/durable/comparison.ts";
import { claimSchedule } from "../src/durable/claims.ts";
import { serveWorker } from "../src/durable/service.ts";
import { experimentClient } from "../src/durable/client.ts";
import { workerRequest, retainedAssignment, dispatchRemote } from "../src/durable/remote.ts";
import { localJobs } from "../src/durable/local.ts";
import { inspectSchedule } from "../src/scheduler.ts";
import { readExperiment } from "../src/experiments.ts";

const workspace = { host: os.hostname(), cwd: fs.realpathSync(os.tmpdir()), identity: randomUUID() };
async function eventually(check: () => Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() >= deadline) throw new Error("Condition timed out"); await new Promise(resolve => setTimeout(resolve, 50)); }
}
function input(): WorkerSubmission {
  return { version: 1, registry: "piccolo-1", requestId: randomUUID(), workspace, lifetime: "independent", owner: "test",
    kind: "delegate", configDigest: "0".repeat(64), stage: { name: "delegate", task: "Answer", model: { provider: "test", modelId: "test" },
      instructions: "Follow project instructions", tools: [], thinkingLevel: "off", report: false, timeoutMs: 10000 } };
}
function models(answer: (context: Context) => string | ToolCall | AssistantMessage["content"] = () => "done") {
  const models = createModels();
  let requests = 0;
  models.getModel = () => ({ id: "test", provider: "test", api: "openai-completions", name: "Test", reasoning: false, input: ["text"],
    contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) as Model<any>;
  models.streamSimple = (_model, context) => {
    requests++;
    const stream = createAssistantMessageEventStream();
    const output = answer(context);
    const content: AssistantMessage["content"] = Array.isArray(output) ? output : [typeof output === "string" ? { type: "text", text: output } : output];
    const message: AssistantMessage = { role: "assistant", content, api: "openai-completions", provider: "test", model: "test",
      stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    return stream;
  };
  return { models, count: () => requests };
}

test("a failed generation capacity hook cannot fall through to a provider call", async () => {
  const model = models(); let acquisitions = 0;
  const resources = { acquire: async () => { if (++acquisitions >= 3) throw new Error("capacity denied"); }, release() {}, close() {} };
  const worker = await DurableWorker.open({ workspace, models: model.models, storage: new MemoryStorage(), tools: [], env: () => undefined, resources });
  try {
    const request = input(); await worker.submit(request); const outcome = await worker.wait(request.requestId);
    assert.equal(model.count(), 0); assert.notEqual((outcome.state.outcome as any).result?.status, "complete");
  } finally { await worker.close("suspend"); }
});

test("failed compaction capacity admission declines before invoking the summarizer", async () => {
  let denied = false, summaries = 0;
  const model = models(() => ({ type: "toolCall", id: "parent", name: "ask_parent", arguments: { question: "wait" } }));
  model.models.completeSimple = async () => { summaries++; throw new Error("summarizer must not run"); };
  const resources = { acquire: async () => { if (denied) throw new Error("capacity denied"); }, release() {}, close() {} };
  const worker = await DurableWorker.open({ workspace, models: model.models, storage: new MemoryStorage(), tools: [askParent], env: () => undefined, resources,
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 10, backgroundTokens: 0 } });
  try {
    const request = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
    request.stage.context = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `Observation ${i}: ` + "fixture ".repeat(100), timestamp: i }));
    await worker.submit(request); await eventually(async () => (await worker.status(request.requestId)).attention.length > 0);
    const stage = (await worker.inspect(request.requestId)).task!;
    const conversation = (await worker.harness.conversation((stage.state as any).checkpoint.conversationId, BACKGROUND_CONTEXT))!;
    denied = true;
    const compact = await conversation.compact(undefined, BACKGROUND_CONTEXT);
    const outcome = await worker.harness.waitForTask(compact, BACKGROUND_CONTEXT);
    assert.equal(outcome.state.outcome.status, "completed"); assert.equal(summaries, 0);
    assert.equal((await conversation.context(BACKGROUND_CONTEXT)).head, undefined);
    denied = false; await worker.abort(request.requestId);
  } finally { await worker.close("suspend"); }
});

test("a worker store rejects a different frozen compaction policy on reopen", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-policy-store-"));
  let store = await openWorkerStorage(directory, workspace);
  try {
    const worker = await DurableWorker.open({ workspace, storage: store.storage, models: models().models, tools: [], env: () => undefined });
    await worker.close("suspend"); store.release(); store = await openWorkerStorage(directory, workspace);
    await assert.rejects(DurableWorker.open({ workspace, storage: store.storage, models: models().models, tools: [], env: () => undefined,
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100, backgroundTokens: 0 } }), /Worker policy changed/);
  } finally { store.release(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a resumed compaction reacquires capacity at the model boundary", { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pd-compaction-resume-"));
  let denied = false, acquisitions = 0, summaries = 0;
  const pending = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const resources = { async acquire(_id: number, ctx: import("@earendil-works/chord/context").Context) {
    if (denied) { acquisitions++; await pending(ctx.abortSignal); }
  }, release() {}, close() {} };
  const model = models(() => ({ type: "toolCall", id: "parent", name: "ask_parent", arguments: { question: "wait" } }));
  model.models.completeSimple = async (_model, _transcript, options) => { summaries++; return pending(options?.signal); };
  const options = { workspace, models: model.models, tools: [askParent], env: () => undefined, resources,
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 10, backgroundTokens: 0 } };
  let store = await openWorkerStorage(directory, workspace);
  let worker = await DurableWorker.open({ ...options, storage: store.storage });
  try {
    const request = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
    request.stage.context = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `Observation ${i}: ` + "fixture ".repeat(100), timestamp: i }));
    await worker.submit(request); await eventually(async () => (await worker.status(request.requestId)).attention.length > 0);
    const stage = (await worker.inspect(request.requestId)).task!;
    const conversation = (await worker.harness.conversation((stage.state as any).checkpoint.conversationId, BACKGROUND_CONTEXT))!;
    const compact = await conversation.compact(undefined, BACKGROUND_CONTEXT);
    await eventually(async () => summaries === 1);
    assert.equal((await worker.harness.getTask(compact, BACKGROUND_CONTEXT))?.state.status, "running");
    await worker.close("suspend"); store.release(); denied = true;
    store = await openWorkerStorage(directory, workspace);
    worker = await DurableWorker.open({ ...options, storage: store.storage });
    // The stage, parent tool and already-selected compaction all independently
    // reacquire their shared stage slot. None may call the provider while queued.
    await eventually(async () => summaries > 1 || acquisitions >= 3);
    assert.equal(summaries, 1); assert.ok(acquisitions >= 3);
  } finally { await worker.close("suspend"); store.release(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Durable delegate commits one task and conversation across duplicate submissions", async () => {
  const model = models();
  const worker = await DurableWorker.open({ workspace, models: model.models, storage: new MemoryStorage(), tools: [], env: () => { throw new Error("no tools"); } });
  try {
    const request = input();
    const admissions = await Promise.all([worker.submit(request), worker.submit(request)]);
    assert.equal(admissions[0].taskId, admissions[1].taskId);
    const result = await worker.wait(request.requestId);
    assert.equal(result.state.outcome.status, "completed", JSON.stringify(result));
    assert.equal(model.count(), 1);
    assert.deepEqual((result.state.outcome as any).result.status, "complete");
    assert.deepEqual((result.state.outcome as any).result.provenance.observed, ["test/test"]);
    assert.equal((result.state.outcome as any).result.metrics.usage.turns, 1);
    await assert.rejects(worker.submit({ ...request, owner: "different" }), /different input/);
  } finally { await worker.close("suspend"); }
});

test("SQLite owner excludes concurrent writers and preserves admissions after reopen", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-durable-"));
  fs.chmodSync(directory, 0o700);
  const request = input();
  const model = models();
  let store = await openWorkerStorage(directory, workspace);
  let worker: DurableWorker | undefined;
  try {
    await assert.rejects(openWorkerStorage(directory, workspace), /locked/);
    worker = await DurableWorker.open({ workspace, storage: store.storage, models: model.models, tools: [], env: () => { throw new Error("no tools"); } });
    const first = await worker.submit(request);
    await worker.wait(request.requestId);
    await worker.close("suspend"); store.release(); worker = undefined;
    store = await openWorkerStorage(directory, workspace);
    worker = await DurableWorker.open({ workspace, storage: store.storage, models: model.models, tools: [], env: () => { throw new Error("no tools"); } });
    assert.equal((await worker.submit(request)).taskId, first.taskId);
    await worker.wait(request.requestId);
    assert.equal(model.count(), 1);
  } finally { await worker?.close("suspend"); store.release(); fs.rmSync(directory, { recursive: true, force: true }); }
});


test("Durable workflow joins review and sequential QA at one exact candidate", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-stages-")));
  const worktree = path.join(root, "tree");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git(root, "init"); git(root, "config", "user.email", "fixture@example.invalid"); git(root, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(root, ".gitignore"), "/.pi/\n/.cache/\n/tree/\n");
  git(root, "add", "."); git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD"), identity = { ...workspace, cwd: fs.realpathSync(root) };
  const spec = (input() as Extract<WorkerSubmission, { kind: "delegate" }>).stage;
  let calls = 0;
  const model = models(() => {
    if (calls++ === 0) { fs.writeFileSync(path.join(worktree, "change.txt"), "implemented"); git(worktree, "add", "."); git(worktree, "commit", "-m", "implementation"); }
    return JSON.stringify({ status: "complete", summary: "verified", commit: git(worktree, "rev-parse", "HEAD"), evidence: ["inspected exact candidate"] });
  });
  const worker = await DurableWorker.open({ workspace: identity, models: model.models, storage: new MemoryStorage(), tools: [], env: () => { throw new Error("no tools"); } });
  try {
    const { stage: _stage, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
    const request = { ...envelope, workspace: identity, kind: "workflow", workflow: { root: identity.cwd, worktree, branch: "implementation", base, task: "Implement",
      maxRevisions: 1, stages: { implement: [spec], review: [spec, spec], qa: [spec, spec] }, checks: {}, validationMode: "reported" } };
    await worker.submit(request);
    const result = await worker.wait(request.requestId);
    assert.equal(result.state.outcome.status, "completed", JSON.stringify(result));
    assert.equal((result.state.outcome as any).result.status, "complete", JSON.stringify(result));
    assert.equal(calls, 5);
    assert.equal((await worker.harness.inspect((await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT)).tasks.length, 0);
  } finally { await worker.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a Durable check that changes the candidate retains its stale receipt and admits no later check", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-dirty-check-"))), cwd = path.join(root, "tree");
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git(root, "init"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(root, ".gitignore"), "/.pi/\n/.cache/\n/tree/\n"); git(root, "add", "."); git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD"), identity = { ...workspace, cwd: root };
  let calls = 0;
  const model = models(() => {
    if (calls++ === 0) { fs.writeFileSync(path.join(cwd, "source.txt"), "candidate"); git(cwd, "add", "."); git(cwd, "commit", "-m", "candidate"); }
    return JSON.stringify({ status: "complete", summary: "Candidate inspected", commit: git(cwd, "rev-parse", "HEAD"), evidence: ["Owned fixture"] });
  });
  const worker = await DurableWorker.open({ workspace: identity, models: model.models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  try {
    const { stage, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
    await worker.submit({ ...envelope, workspace: identity, kind: "workflow", workflow: { root, worktree: cwd, branch: "candidate", base, task: "Fixture", maxRevisions: 0,
      stages: { implement: [stage], review: [stage], qa: [stage] }, validationMode: "required", checks: {
        dirty: { command: "printf retained > unexpected.txt", cwd: ".", boundary: "isolated", scope: "Intentional untracked output", timeout_ms: 1000, required: true },
        later: { command: "printf later > later.txt", cwd: ".", boundary: "isolated", scope: "Must not run after source drift", timeout_ms: 1000, required: true },
      } } });
    const result = ((await worker.wait(envelope.requestId)).state.outcome as any).result;
    assert.equal(result.status, "needs_parent");
    assert.equal(result.checks.length, 1);
    const { readCheck } = await import("../src/validation.ts");
    const receipt = readCheck(cwd, result.checks[0]);
    assert.equal(receipt.status, "stale"); assert.equal(receipt.exit_code, 0);
    assert.match(result.summary, new RegExp(receipt.id));
    assert.equal(fs.readFileSync(path.join(cwd, "unexpected.txt"), "utf8"), "retained");
    assert.equal(fs.existsSync(path.join(cwd, "later.txt")), false);
  } finally { await worker.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});


for (const replay of ["safe", "unsafe"] as const) test(`SQLite restart ${replay === "safe" ? "replays safe" : "does not replay unsafe"} tool intent`, { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-recovery-"));
  fs.chmodSync(directory, 0o700);
  let attempts = 0, requests = 0;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const tool = defineTool({ name: "effect", description: "Test effect", replay, parameters: Type.Object({}),
    async execute(_args, _api, ctx) {
      attempts++; started();
      if (attempts === 1) await new Promise<void>((_resolve, reject) => { ctx.abortSignal!.addEventListener("abort", () => reject(new Error("cancelled invocation")), { once: true }); });
      return { output: [{ type: "text", text: "effect completed" }] };
    },
  });
  const model = models(() => requests++ === 0 ? { type: "toolCall", id: "effect-1", name: "effect", arguments: {} } : "done");
  const request = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  request.stage.tools = ["effect"];
  let store = await openWorkerStorage(directory, workspace);
  let worker = await DurableWorker.open({ workspace, models: model.models, storage: store.storage, tools: [tool], env: () => undefined });
  try {
    const first = await worker.submit(request);
    await entered;
    await worker.close("suspend"); store.release();
    store = await openWorkerStorage(directory, workspace);
    worker = await DurableWorker.open({ workspace, models: model.models, storage: store.storage, tools: [tool], env: () => undefined });
    assert.equal((await worker.submit(request)).taskId, first.taskId);
    const result = await worker.wait(request.requestId);
    assert.equal(result.state.outcome.status, "completed", JSON.stringify(result));
    assert.equal((result.state.outcome as any).result.status, replay === "safe" ? "complete" : "needs_parent", JSON.stringify(result));
    assert.equal(attempts, replay === "safe" ? 2 : 1);
  } finally { await worker.close("suspend"); store.release(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Durable experiment trials preserve criteria and stop admissions when frozen source changes", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-matrix-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n/.pi/\n");
  fs.writeFileSync(path.join(root, "source.txt"), "frozen"); git("add", "."); git("commit", "-m", "base");
  fs.mkdirSync(path.join(root, ".cache"));
  const base = git("rev-parse", "HEAD"), identity = { ...workspace, cwd: root };
  const model = models(() => { fs.writeFileSync(path.join(root, "source.txt"), "changed"); return "expected"; });
  const worker = await DurableWorker.open({ workspace: identity, models: model.models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const request = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  const { stage, ...envelope } = request;
  try {
    await worker.submit({ ...envelope, workspace: identity, kind: "experiment", pipeline: {
      maxActive: 1, failFast: false, source: { root, base, files: {} }, nodes: Object.fromEntries(["one", "two"].map(id => [id, {
        needs: [], criterion: { kind: "exact_text", expected: "expected" }, work: { kind: "delegate", stage, root, cwd: path.join(root, ".cache", id), base, branch: id },
      }])),
    } });
    const result = await worker.wait(request.requestId);
    assert.equal(result.state.outcome.status, "completed", JSON.stringify(result));
    assert.equal((result.state.outcome as any).result.status, "needs_parent");
    assert.equal((result.state.outcome as any).result.results.one.status, "complete");
    assert.match((result.state.outcome as any).result.error, /source changed/);
    assert.equal(model.count(), 1);
    assert.equal(fs.existsSync(path.join(root, ".cache", "two")), false);
  } finally { await worker.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

test("Durable Jobs require complete result inspection and persist immutable parent decisions", async () => {
  const model = models(() => "x".repeat(20000));
  const worker = await DurableWorker.open({ workspace, models: model.models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const jobs = new DurableJobs(workspace.cwd, "test", worker, { changed: () => {}, notify: () => {}, release: () => {} });
  try {
    const request = input();
    await jobs.submit(request); await worker.wait(request.requestId); await jobs.refresh();
    assert.equal(jobs.status(request.requestId).state, "completed");
    const revision = jobs.status(request.requestId).outcome_revision!;
    jobs.result(request.requestId);
    await assert.rejects(jobs.acknowledge(request.requestId, revision, "Reviewed"), /Inspect/);
    let offset: number | null = 0;
    while (offset !== null) offset = jobs.resultPage(request.requestId, revision, offset).next_offset;
    await jobs.acknowledge(request.requestId, revision, "Reviewed");
    assert.equal(jobs.status(request.requestId).parent_review.disposition, "acknowledged");
    await assert.rejects(jobs.acknowledge(request.requestId, revision, "Changed my mind"), /cannot be overwritten/);
  } finally { await jobs.close("test finished"); }
});

test("default implementation profiles compile to valid frozen Durable stages", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-prepare-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  const prior = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
    fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n/.pi/\n"); git("add", "."); git("commit", "-m", "base");
    const resolved = loadConfig(root, { userFile: path.join(root, "absent.toml") });
    const agents = Object.fromEntries(["implement", "review", "qa"].flatMap(stage => resolved.config.jobs!.implementation.stages![stage].agents!.map(type => [`workflow/${stage}/${type}`, resolveAgent(resolved, type)])));
    const prepared = prepareSubmission({ kind: "workflow", arguments: { task: "Implement", branch: "work", worktree: path.join(root, "tree") },
      resolved, agents, parent: { model: "test/test", effort: "off" } }, { ...workspace, cwd: root }, "test");
    assert.equal(prepared.kind, "workflow");
    if (prepared.kind !== "workflow") throw new Error("Wrong kind");
    assert.ok(prepared.workflow.stages.implement[0].task);
    assert.equal(prepared.workflow.base, git("rev-parse", "HEAD"));
  } finally { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; fs.rmSync(root, { recursive: true, force: true }); }
});

for (const remotePlacement of [false, true]) test(`Durable ${remotePlacement ? "remote linked-checkout" : "local"} default placement completes required Python validation`, { timeout: 30000 }, async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-placement-")));
  const root = path.join(directory, "local"); fs.mkdirSync(root);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git(root, "init"); git(root, "config", "user.email", "fixture@example.invalid"); git(root, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n/.pi/\n"); git(root, "add", "."); git(root, "commit", "-m", "base");
  const primary = remotePlacement ? path.join(directory, "remote") : root;
  let executionRoot = primary;
  if (remotePlacement) {
    git(root, "clone", "-q", root, primary); git(primary, "config", "user.email", "fixture@example.invalid"); git(primary, "config", "user.name", "Fixture");
    fs.mkdirSync(path.join(primary, ".worktrees")); executionRoot = path.join(primary, ".worktrees/controller");
    git(primary, "worktree", "add", "-qb", "controller", executionRoot, "HEAD");
  }
  const destination = path.join(primary, ".worktrees/feature-add");
  const identity = { ...workspace, cwd: root, identity: randomUUID() }, remoteIdentity = { ...workspace, cwd: executionRoot, identity: randomUUID() };
  let calls = 0;
  const model = models(() => {
    if (calls++ === 0) {
      fs.writeFileSync(path.join(destination, "arithmetic.py"), "def add(a, b):\n    return a + b\n");
      fs.mkdirSync(path.join(destination, "tests"));
      fs.writeFileSync(path.join(destination, "tests/test_arithmetic.py"), "import unittest\nfrom arithmetic import add\nclass AddTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n        self.assertEqual(add(-2, 2), 0)\n");
      git(destination, "add", "."); git(destination, "commit", "-m", "Add arithmetic and tests");
    }
    return JSON.stringify({ status: "complete", summary: "Scoped arithmetic verified", commit: git(destination, "rev-parse", "HEAD"), evidence: ["Exact candidate inspected"] });
  });
  const executor = await DurableWorker.open({ workspace: remotePlacement ? remoteIdentity : identity, models: model.models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  let server: Awaited<ReturnType<typeof serveWorker>> | undefined, controller: DurableWorker | undefined;
  try {
    const resolved = loadConfig(root, { userFile: path.join(directory, "absent.toml"), invocation: { jobs: { implementation: { validation: {
      mode: "required", checks: { unittest: { command: "python3 -m unittest discover -s tests", boundary: "isolated", scope: "Owned temporary arithmetic fixture", timeout_ms: 30000 } },
    } } } } });
    const agents = Object.fromEntries(["implement", "review", "qa"].flatMap(stage => resolved.config.jobs!.implementation.stages![stage].agents!.map(type =>
      [`workflow/${stage}/${type}`, { ...resolveAgent(resolved, type), model: "test/test", tools: [] }])));
    const snapshot = { kind: "workflow", arguments: { task: "Add add(a,b) and unittest coverage", branch: "feature/add", max_revisions: 0 }, resolved, agents, parent: { model: "test/test", effort: "off" } };
    let remote: Parameters<typeof prepareSubmission>[3];
    if (remotePlacement) {
      const socket = path.join(directory, "worker.sock");
      server = await serveWorker(executor, remoteIdentity, socket, async () => {});
      const target = { workspace: remoteIdentity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] };
      const info = await workerRequest(target, { operation: "info" });
      assert.equal(info.worktreeOwner, primary);
      assert.throws(() => prepareSubmission(snapshot, identity, "test", { target, base: info.head, lifetime: "session" }), /explicit worktree destination/);
      remote = { target, base: info.head, worktreeOwner: info.worktreeOwner, lifetime: "session" };
      controller = await DurableWorker.open({ workspace: identity, models: models().models, storage: new MemoryStorage(), tools: [], env: () => undefined });
    }
    const request = prepareSubmission(snapshot, identity, "test", remote);
    assert.equal(request.kind, "workflow");
    if (request.kind !== "workflow") throw new Error("Wrong kind");
    assert.equal(request.workflow.worktree, destination);
    assert.equal(fs.existsSync(destination), false);
    const owner = controller ?? executor;
    await owner.submit(request); const outcome = await owner.wait(request.requestId);
    assert.equal(outcome.state.outcome.status, "completed", JSON.stringify(outcome));
    const result = (outcome.state.outcome as any).result;
    assert.equal(result.status, "complete", JSON.stringify(result));
    assert.equal(result.worktree, destination);
    assert.equal(result.checks.length, 1);
    assert.equal(git(destination, "status", "--porcelain"), "");
    assert.match(fs.readFileSync(path.join(primary, ".gitignore"), "utf8"), /\/\.worktrees\//);
    assert.equal(fs.existsSync(path.join(executionRoot, ".worktrees")), remotePlacement ? false : true);
    assert.ok(calls >= 3);
    if (remotePlacement) assert.equal(fs.existsSync(path.join(root, ".worktrees")), false);
  } finally {
    await controller?.close("suspend"); await executor.close("suspend");
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const kind of ["delegate", "workflow"] as const) test(`generated ${kind} experiment placement uses the remote owner without remapping an overlapping prefix`, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-experiment-placement-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
    fs.mkdirSync(path.join(root, ".piccolo"));
    const file = path.join(root, ".piccolo/experiment.toml");
    fs.writeFileSync(file, `format=1\nname="placement"\nrepetitions=2\n[tasks.work]\nkind="${kind}"\ntask="Verify placement"\n${kind === "delegate" ? 'type="summarizer"\n' : ''}[tasks.work.criterion]\nkind="${kind === "delegate" ? "exact_text" : "required_checks"}"\n${kind === "delegate" ? 'expected="done"\n' : '[tasks.work.checks.unit]\ncommand="exit 0"\nboundary="isolated"\nscope="Owned fixture"\nrequired=true\n'}[variants.base]\n`);
    git("add", "."); git("commit", "-m", "experiment");
    const plan = readExperiment(file), resolved = loadConfig(root, { userFile: path.join(root, "absent.toml") });
    const agents: Record<string, unknown> = {}, configs: Record<string, typeof resolved> = {};
    for (const trial of plan.trials) {
      configs[trial.id] = resolved;
      agents[trial.id] = { ...resolveAgent(resolved, "summarizer"), model: "test/test", tools: [] };
      for (const [stage, recipe] of Object.entries(resolved.config.jobs!.implementation.stages!)) for (const type of recipe.agents!) {
        agents[`${trial.id}/${stage}/${type}`] = { ...resolveAgent(resolved, type), model: "test/test", tools: [] };
      }
    }
    const owner = path.join(root, "remote"), remoteRoot = path.join(owner, ".worktrees/controller");
    const target = { workspace: { ...workspace, cwd: remoteRoot }, transport: ["unused-test-transport"] };
    const prepared = prepareSubmission({ kind: "experiment", arguments: { spec: file }, resolved, experiment: plan, agents, configs, parent: { model: "test/test", effort: "off" } },
      { ...workspace, cwd: root }, "test", { target, worktreeOwner: owner, base: git("rev-parse", "HEAD"), lifetime: "session" });
    assert.equal(prepared.kind, "experiment");
    if (prepared.kind !== "experiment") throw new Error("Wrong kind");
    for (const node of Object.values(prepared.pipeline.nodes)) {
      const destination = node.work.kind === "delegate" ? node.work.cwd : node.work.workflow.worktree;
      assert.equal(path.dirname(destination), path.join(owner, ".worktrees"));
      assert.ok(path.basename(destination).startsWith(`experiment-${prepared.requestId}-`));
    }
    assert.equal(fs.existsSync(path.join(root, ".worktrees")), false);
    assert.equal(fs.existsSync(path.join(root, "remote")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Durable stop isolates concurrent jobs and a queued instruction receives a durable answer", { timeout: 15000 }, async () => {
  let generated = 0;
  const entered = new Map<number, () => void>();
  let both!: () => void;
  const started = new Promise<void>(resolve => { both = resolve; });
  const tool = defineTool({ name: "hold", description: "Wait for the test", replay: "safe", parameters: Type.Object({ label: Type.Number() }),
    async execute(args, _api, ctx) {
      await new Promise<void>((resolve, reject) => {
        entered.set(args.label, resolve);
        ctx.abortSignal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        if (entered.size === 2) both();
      });
      return { output: [{ type: "text", text: "released" }] };
    },
  });
  const model = models(() => generated < 2 ? { type: "toolCall", id: `hold-${generated}`, name: "hold", arguments: { label: generated++ } } : "done");
  const worker = await DurableWorker.open({ workspace, models: model.models, storage: new MemoryStorage(), tools: [tool], env: () => undefined, capacity: 2 });
  try {
    const first = input() as Extract<WorkerSubmission, { kind: "delegate" }>, second = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
    first.stage.tools = second.stage.tools = ["hold"];
    await worker.submit(first); await worker.submit(second); await started;
    const messageId = randomUUID();
    const submission = await worker.message(second.requestId, messageId, "Finish after the tool returns");
    assert.equal(await worker.message(second.requestId, messageId, "Finish after the tool returns"), submission);
    await assert.rejects(worker.message(second.requestId, messageId, "Different input"), /different input/);
    const stopped = await worker.abort(first.requestId);
    assert.equal(stopped.state.outcome.status, "aborted");
    assert.notEqual((await worker.inspect(second.requestId)).task!.state.status, "terminal");
    entered.get(1)!();
    await worker.wait(second.requestId);
    assert.equal((await (await worker.harness.submission(submission as any, BACKGROUND_CONTEXT))!.status(BACKGROUND_CONTEXT)).status, "done");
    assert.equal((await worker.harness.inspect(BACKGROUND_CONTEXT)).tasks.length, 0);
  } finally { await worker.close("suspend"); }
});

test("Durable dependency join integrates two exact predecessors before the dependent workflow", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-join-")));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git(root, "init"); git(root, "config", "user.email", "fixture@example.invalid"); git(root, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n/.pi/\n/.worktrees/\n");
  fs.mkdirSync(path.join(root, ".piccolo"));
  const roadmap = path.join(root, ".piccolo", "roadmap.json");
  fs.writeFileSync(roadmap, JSON.stringify({ format: 1, tasks: ["one", "two", "three"].map(id => ({ id, title: id, status: "planned", needs: id === "three" ? [{ task: "one" }, { task: "two" }] : [] })) }));
  git(root, "add", "."); git(root, "commit", "-m", "base");
  fs.mkdirSync(path.join(root, ".cache"));
  const base = git(root, "rev-parse", "HEAD"), identity = { ...workspace, cwd: root };
  const model = models(context => {
    const prompt = JSON.stringify(context.messages);
    const id = /Stay on branch pipeline-(one|two|three)/.exec(prompt)?.[1];
    assert.ok(id, prompt);
    const cwd = path.join(root, ".cache", id), change = path.join(cwd, `${id}.txt`);
    if (!fs.existsSync(change)) {
      if (id === "three") { assert.ok(fs.existsSync(path.join(cwd, "one.txt"))); assert.ok(fs.existsSync(path.join(cwd, "two.txt"))); }
      fs.writeFileSync(change, id); git(cwd, "add", "."); git(cwd, "commit", "-m", id);
    }
    return JSON.stringify({ status: "complete", summary: "verified", commit: git(cwd, "rev-parse", "HEAD"), evidence: ["exact candidate inspected"] });
  });
  const worker = await DurableWorker.open({ workspace: identity, models: model.models, storage: new MemoryStorage(), tools: [], env: () => undefined, capacity: 2 });
  const { stage, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  try {
    await worker.submit({ ...envelope, workspace: identity, kind: "schedule", pipeline: { source: { root, base, files: { ".piccolo/roadmap.json": sourceDigest(roadmap) } }, maxActive: 2, failFast: true,
      nodes: Object.fromEntries(["one", "two", "three"].map(id => [id, { needs: id === "three" ? ["one", "two"] : [], work: { kind: "workflow", workflow: {
        root, worktree: path.join(root, ".cache", id), branch: `pipeline-${id}`, base, task: `Implement ${id}`, maxRevisions: 0,
        stages: { implement: [stage], review: [stage], qa: [stage] }, checks: {}, validationMode: "reported",
      } } }])) } });
    const task = await worker.wait(envelope.requestId);
    assert.equal(task.state.outcome.status, "completed", JSON.stringify(task));
    const result = (task.state.outcome as any).result;
    assert.equal(result.status, "complete", JSON.stringify(result));
    const candidate = result.results.three.result.candidate;
    for (const id of ["one", "two"]) git(root, "merge-base", "--is-ancestor", result.results[id].result.candidate, candidate);
    assert.equal(model.count(), 9);
    const exported = await exportRoadmap(worker, envelope.requestId);
    assert.equal((await exportRoadmap(worker, envelope.requestId)).digest, exported.digest);
    const projected = JSON.parse(fs.readFileSync(roadmap, "utf8")).tasks.find((task: any) => task.id === "three");
    assert.equal(projected.status, "complete");
    assert.equal(projected.candidate, candidate);
    assert.equal(projected.recorded_dependencies.one, result.results.one.result.candidate);
    fs.writeFileSync(roadmap, fs.readFileSync(roadmap, "utf8") + " ");
    await assert.rejects(exportRoadmap(worker, envelope.requestId), /changed after export/);
  } finally { await worker.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

test("forked context is committed before the stage input", async () => {
  const model = models(context => {
    const messages = context.messages.filter(message => message.role === "user");
    assert.equal(messages[0].content, "Prior context codeword: willow");
    assert.equal(messages.at(-1)?.content, "Answer");
    return "willow";
  });
  const worker = await DurableWorker.open({ workspace, models: model.models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  try {
    const request = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
    request.stage.context = [{ role: "user", content: "Prior context codeword: willow", timestamp: Date.now() }];
    await worker.submit(request);
    const result = await worker.wait(request.requestId);
    assert.equal(result.state.outcome.status, "completed", JSON.stringify(result));
    assert.equal((result.state.outcome as any).result.text, "willow");
  } finally { await worker.close("suspend"); }
});

test("a pending parent decision survives SQLite reopen and is answered once", { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-supervisor-")); fs.chmodSync(directory, 0o700);
  let turn = 0;
  const model = models(context => {
    if (turn++ === 0) return { type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "May I proceed with the chosen approach?" } };
    assert.match(JSON.stringify(context.messages), /Proceed with the chosen approach/);
    return "done";
  });
  let store = await openWorkerStorage(directory, workspace);
  let worker = await DurableWorker.open({ workspace, models: model.models, storage: store.storage, tools: [askParent], env: () => undefined });
  let jobs: DurableJobs | undefined;
  try {
    const asked = new Promise<void>(resolve => {
      const unsubscribe = worker.harness.subscribeCommits(publication => {
        if (publication.changes.some(change => change.type === "document" && change.record.kind === "piccolo.supervisor")) { unsubscribe(); resolve(); }
      });
    });
    const request = input(); await worker.submit(request); await asked;
    await worker.close("suspend"); store.release();
    store = await openWorkerStorage(directory, workspace);
    worker = await DurableWorker.open({ workspace, models: model.models, storage: store.storage, tools: [askParent], env: () => undefined });
    jobs = new DurableJobs(workspace.cwd, "test", worker, { changed: () => {}, notify: () => {}, release: () => {} });
    await jobs.refresh();
    assert.equal(jobs.status(request.requestId).state, "needs_parent");
    assert.equal(jobs.status(request.requestId).attention?.length, 1);
    const messageId = randomUUID();
    const first = await worker.message(request.requestId, messageId, "Proceed with the chosen approach");
    assert.equal(await worker.message(request.requestId, messageId, "Proceed with the chosen approach"), first);
    const result = await worker.wait(request.requestId);
    assert.equal(result.state.outcome.status, "completed", JSON.stringify(result));
    assert.equal(Object.keys((await worker.harness.snapshot(SupervisorDoc, BACKGROUND_CONTEXT))!.requests).length, 1);
  } finally { if (jobs) await jobs.close("finished"); else await worker.close("suspend"); store.release(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("remote service reconnect preserves assignment, supervisor attention and independent lifetime", { timeout: 25000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-wire-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n");
  const identity = { ...workspace, cwd: root }, remoteIdentity = { ...identity, identity: randomUUID() };
  let turn = 0;
  const model = models(() => turn++ === 0 ? { type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Choose the next step" } } : "done");
  const remote = await DurableWorker.open({ workspace: remoteIdentity, models: model.models, storage: new MemoryStorage(), tools: [askParent], env: () => undefined });
  const socket = path.join(root, "worker.sock");
  let server = await serveWorker(remote, remoteIdentity, socket, async () => {});
  const target = { workspace: remoteIdentity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] };
  const store = await openWorkerStorage(path.join(root, "controller"), identity);
  const local = await DurableWorker.open({ workspace: identity, models: models().models, storage: store.storage, tools: [], env: () => undefined });
  const jobs = new DurableJobs(root, "test", local, { changed: () => {}, notify: () => {}, release: () => {} });
  const request = { ...input(), workspace: identity, placement: target };
  try {
    await jobs.submit(request);
    await eventually(async () => { await jobs.refresh(); return jobs.status(request.requestId).attention_total === 1; });
    assert.equal(jobs.status(request.requestId).host, remoteIdentity.host);
    const status = await workerRequest(target, { operation: "inspect", requestId: request.requestId });
    assert.equal(status.input, undefined);
    assert.equal(status.task.input, undefined);
    retainedAssignment(root, target, request.requestId);
    assert.throws(() => retainedAssignment(root, { ...target, workspace: { ...remoteIdentity, identity: randomUUID() } }, request.requestId), /original worker/);
    await assert.rejects(workerRequest({ ...target, workspace: identity }, { operation: "info" }), /identity mismatch/);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.notEqual((await local.inspect(request.requestId)).task!.state.status, "terminal");
    server = await serveWorker(remote, remoteIdentity, socket, async () => {});
    await jobs.message(request.requestId, "Proceed");
    await eventually(async () => { await jobs.refresh(); return jobs.status(request.requestId).state === "completed"; });
    assert.equal(model.count(), 2);
    assert.equal(jobs.status(request.requestId).messages_total, 1);
    await jobs.close("parent quit");
    assert.equal((await remote.inspect(request.requestId)).task!.state.status, "terminal");
  } finally {
    await local.close("suspend"); store.release();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await remote.close("suspend"); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("instructions queued before capacity admission survive until the stage reads them", { timeout: 15000 }, async () => {
  let release!: () => void, started!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const tool = defineTool({ name: "hold", description: "Hold capacity", replay: "safe", parameters: Type.Object({}),
    async execute() { started(); await new Promise<void>(resolve => { release = resolve; }); return { output: [{ type: "text", text: "released" }] }; } });
  const model = models(context => {
    if (calls++ === 0) return { type: "toolCall", id: "hold", name: "hold", arguments: {} };
    if (JSON.stringify(context.messages).includes("second job")) assert.match(JSON.stringify(context.messages), /Queued instruction/);
    return "done";
  });
  const worker = await DurableWorker.open({ workspace, models: model.models, storage: new MemoryStorage(), tools: [tool], env: () => undefined, capacity: 1 });
  try {
    const first = input() as Extract<WorkerSubmission, { kind: "delegate" }>, second = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
    first.stage.tools = ["hold"]; second.stage.task = "second job";
    await worker.submit(first); await entered; await worker.submit(second);
    await eventually(async () => ((await worker.inspect(second.requestId)).task!.state as any).checkpoint?.phase === "queued");
    const id = randomUUID(), stage = await worker.message(second.requestId, id, "Queued instruction");
    assert.equal(await worker.message(second.requestId, id, "Queued instruction"), stage);
    release(); await worker.wait(first.requestId); await worker.wait(second.requestId);
    const status = await worker.status(second.requestId);
    assert.equal(status.messages[0].state, "delivered");
    assert.equal(calls, 3);
  } finally { release?.(); await worker.close("suspend"); }
});

test("shared schedule attempt claims reject a second controller and changed input", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-claim-")));
  try {
    const { stage, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
    const request: WorkerSubmission = { ...envelope, kind: "schedule", pipeline: { source: { root, base: "a".repeat(40), files: {} }, maxActive: 1, failFast: true,
      nodes: { work: { attempt: 1, needs: [], dependencies: [], merges: {}, work: { kind: "delegate", stage, root, cwd: path.join(root, "tree"), base: "a".repeat(40), branch: "work" } } } } };
    claimSchedule(root, request); claimSchedule(root, request);
    assert.throws(() => claimSchedule(root, { ...request, requestId: randomUUID() }), /already claimed/);
    assert.throws(() => claimSchedule(root, { ...request, configDigest: "1".repeat(64) }), /already claimed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("report correction is bounded and disables tools on the correction turn", async () => {
  let calls = 0;
  const model = models(context => {
    if (calls++) assert.equal(context.tools?.length ?? 0, 0);
    return "not a JSON report";
  });
  const worker = await DurableWorker.open({ workspace, models: model.models, storage: new MemoryStorage(), tools: [askParent], env: () => undefined });
  try {
    const request = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
    request.stage.report = true;
    await worker.submit(request);
    const result = await worker.wait(request.requestId);
    assert.equal((result.state.outcome as any).result.status, "needs_parent");
    assert.equal(calls, 2);
  } finally { await worker.close("suspend"); }
});

test("experiment comparisons retain provenance and missing measurements without inferring correctness", () => {
  const report = compareTrials({ source: { root: workspace.cwd, base: "a".repeat(40), files: {} }, nodes: {}, maxActive: 1, failFast: false,
    experiment: { name: "comparison", manifestDigest: "manifest", taskDigest: "tasks", trials: {
      one: { task: "task", variant: "variant", repetition: 1, configDigest: "config" },
      two: { task: "task", variant: "variant", repetition: 2, configDigest: "config" },
    } } }, { one: { status: "complete", correctness: "unassessed", elapsedMs: 10, result: { status: "complete", provenance: { observed: ["test/test"] } } } })!;
  assert.equal(report.groups[0].correctness_pass, 0);
  assert.equal(report.groups[0].correctness_unassessed, 2);
  assert.equal(report.groups[0].usage, null);
  assert.equal(report.groups[0].median_elapsed_ms, 10);
  assert.equal(report.trials[1].status, "not_started");
  assert.deepEqual(report.trials[0].provenance, { observed: ["test/test"] });
});

test("remote experiment report, assessment and comparison preserve immutable criteria", { timeout: 20000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-exp-"))), identity = { ...workspace, cwd: root };
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n/.pi/\n/worker.sock\n"); git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD"), model = models();
  const worker = await DurableWorker.open({ workspace: identity, models: model.models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const socket = path.join(root, "worker.sock"), server = await serveWorker(worker, identity, socket, async () => {});
  const target = { workspace: identity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] };
  const ids: string[] = [];
  try {
    for (const run of [1, 2]) {
      const { stage, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
      ids.push(envelope.requestId);
      const request = { ...envelope, workspace: identity, kind: "experiment", pipeline: { maxActive: 1, failFast: false, source: { root, base, files: {} },
        experiment: { name: "fixture", manifestDigest: "manifest", taskDigest: "tasks", trials: Object.fromEntries(["001", "002"].map((id, index) => [id, { task: "task", variant: "variant", repetition: index + 1, configDigest: "config" }])) },
        nodes: Object.fromEntries(["001", "002"].map(id => [id, { needs: [], criterion: { kind: "rubric", description: "Human assessment" }, work: { kind: "delegate", stage, root,
          cwd: path.join(root, ".cache", "piccolo", "experiments", envelope.requestId, "worktrees", id), branch: `run-${run}-${id}`, base } }])) } };
      await dispatchRemote(root, target, submissionSchema.parse(request)); await worker.wait(envelope.requestId);
    }
    const first: any = await experimentClient(root, target, "report", [ids[0]]);
    assert.equal(first.groups[0].usage_samples, 2);
    assert.equal(first.groups[0].correctness_pass, 0);
    const assessment = { trial: "001", outcomeDigest: first.trials[0].outcome_digest, verdict: "pass", assessor: "Fixture", provenance: "human_reported", evidence: ["Inspected result"], note: "Matches rubric" };
    const file = path.join(root, ".cache", "assessment.json"); fs.writeFileSync(file, JSON.stringify(assessment));
    await experimentClient(root, target, "assess", [ids[0]], file);
    await experimentClient(root, target, "assess", [ids[0]], file);
    fs.writeFileSync(file, JSON.stringify({ ...assessment, verdict: "fail" }));
    await assert.rejects(experimentClient(root, target, "assess", [ids[0]], file), /cannot be overwritten/);
    const comparison: any = await experimentClient(root, target, "compare", ids);
    assert.equal(comparison.comparable_inputs, true);
    assert.equal(comparison.reports[0].assessments["001"].verdict, "pass");
    assert.equal(comparison.reports[0].groups[0].correctness_pass, 0);
    assert.equal(model.count(), 4);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await worker.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const replay of ["safe", "unsafe"] as const) test(`hard process death releases SQLite ownership and ${replay} effects follow replay policy`, { timeout: 20000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-kill-")));
  const request = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  request.workspace = { ...workspace, cwd: root }; request.stage.tools = ["effect"];
  fs.writeFileSync(path.join(root, "request.json"), JSON.stringify(request));
  const children: ReturnType<typeof spawn>[] = [];
  const launch = () => {
    const child = spawn(process.execPath, ["--experimental-strip-types", path.resolve("tests/fixtures/durable-crash-worker.mjs"), root, replay], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child); let output = "", errors = "";
    const events: any[] = [];
    child.stdout!.setEncoding("utf8"); child.stdout!.on("data", chunk => { output += chunk; let end; while ((end = output.indexOf("\n")) >= 0) { events.push(JSON.parse(output.slice(0, end))); output = output.slice(end + 1); } });
    child.stderr!.on("data", chunk => { errors = (errors + chunk).slice(-4000); });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { child, events, closed, errors: () => errors };
  };
  try {
    const first = launch();
    await eventually(async () => { if (first.child.exitCode !== null) throw new Error(first.errors()); return first.events.some(event => event.type === "effect_started"); });
    first.child.kill("SIGKILL"); await first.closed;
    assert.equal(fs.readFileSync(path.join(root, "effects"), "utf8"), "1");
    const second = launch(); assert.equal(await second.closed, 0, second.errors());
    const result = second.events.find(event => event.type === "result");
    assert.ok(result, second.errors());
    assert.equal(result.outcome.result.status, replay === "safe" ? "complete" : "needs_parent");
    assert.equal(fs.readFileSync(path.join(root, "effects"), "utf8"), replay === "safe" ? "2" : "1");
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child.once("close", resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("intentional session close cancels its scope and suspends independent work for reopen", { timeout: 15000 }, async () => {
  let turns = 0;
  const model = models(() => turns++ < 2 ? { type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Choose next step" } } : "done");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pd-lifetime-"));
  let store = await openWorkerStorage(directory, workspace);
  let worker = await DurableWorker.open({ workspace, models: model.models, storage: store.storage, tools: [askParent], env: () => undefined });
  try {
    const session = { ...input(), lifetime: "session", owner: "owner" }, independent = { ...input(), owner: "owner" };
    await worker.submit(session); await worker.submit(independent);
    await eventually(async () => Object.keys((await worker.harness.snapshot(SupervisorDoc, BACKGROUND_CONTEXT))?.requests ?? {}).length === 2);
    await worker.close("cancel-session", "owner"); store.release();
    store = await openWorkerStorage(directory, workspace);
    worker = await DurableWorker.open({ workspace, models: model.models, storage: store.storage, tools: [askParent], env: () => undefined });
    const stopped = (await worker.inspect(session.requestId)).task!;
    assert.equal(stopped.state.status, "terminal");
    assert.equal((stopped.state as any).outcome.status, "aborted");
    await eventually(async () => (await worker.status(independent.requestId)).attention.length === 1);
    await worker.message(independent.requestId, randomUUID(), "Proceed");
    const completed = await worker.wait(independent.requestId);
    assert.equal(completed.state.outcome.status, "completed");
    assert.equal(turns, 3);
  } finally { await worker.close("suspend"); store.release(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Durable workers share native host capacity and preserve queue limits", { timeout: 15000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-pool-"))), pool = path.join(root, "pool");
  const identity1 = { ...workspace, cwd: root }, identity2 = { ...identity1, identity: randomUUID() };
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let turns = 0;
  const hold = defineTool({ name: "hold", description: "Hold the shared slot", replay: "safe", parameters: Type.Object({}),
    async execute() { entered(); await new Promise<void>(resolve => { release = resolve; }); return { output: [{ type: "text", text: "done" }] }; } });
  const firstModels = models(() => turns++ === 0 ? { type: "toolCall", id: "hold", name: "hold", arguments: {} } : "done"), secondModels = models();
  const resources1 = durablePool(identity1, { capacity: 1, queue_timeout_ms: 5000 }, pool), resources2 = durablePool(identity2, { capacity: 1, queue_timeout_ms: 100 }, pool);
  const first = await DurableWorker.open({ workspace: identity1, models: firstModels.models, storage: new MemoryStorage(), resources: resources1, tools: [hold], env: () => undefined });
  const second = await DurableWorker.open({ workspace: identity2, models: secondModels.models, storage: new MemoryStorage(), resources: resources2, tools: [], env: () => undefined });
  try {
    const request = input() as Extract<WorkerSubmission, { kind: "delegate" }>; request.workspace = identity1; request.stage.tools = ["hold"];
    await first.submit(request); await started;
    const queued = { ...input(), workspace: identity2 }; await second.submit(queued);
    const blocked = await second.wait(queued.requestId);
    assert.equal(blocked.state.outcome.status, "faulted");
    assert.match((blocked.state.outcome as any).error.message, /pool queue timeout/);
    assert.equal(secondModels.count(), 0);
    release(); await first.wait(request.requestId);
    const next = { ...input(), workspace: identity2 }; await second.submit(next); await second.wait(next.requestId);
    assert.equal(secondModels.count(), 1);
    assert.equal(fs.readdirSync(pool).filter(name => name.startsWith("slot-")).length, 0);
  } finally { release?.(); await first.close("suspend"); await second.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

test("Compaction cannot hide uncertainty from the next generation, even without native policy", async () => {
  const request = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  request.stage.tools = ["effect"];
  const model = models(() => ({ type: "toolCall", id: "effect", name: "effect", arguments: {} }));
  let effects = 0;
  const effect = defineTool({ name: "effect", description: "Historical uncertainty fixture", parameters: Type.Object({}),
    async execute(_args, api, ctx) {
      effects++;
      await api.commit(async tx => {
        await tx.appendEntry(api.conversationId, { kind: "pi.tool-result", data: { diagnostics: [{ code: "interrupted" }] } });
        await tx.appendEntry(api.conversationId, { kind: "pi.compaction", head: "self", model: [{ role: "user", content: "Prior work summarized.", timestamp: Date.now() }] });
      }, ctx);
      return { output: [{ type: "text", text: "Summarized" }] };
    } });
  const worker = await DurableWorker.open({ workspace, models: model.models, storage: new MemoryStorage(), tools: [effect], env: () => undefined });
  try {
    await worker.submit(request);
    const result = (await worker.wait(request.requestId)).state.outcome;
    assert.equal(result.status, "completed");
    assert.equal((result as any).result.status, "needs_parent");
    assert.equal(effects, 1); assert.equal(model.count(), 1);
    const active = await (await worker.harness.conversation((result as any).result.conversationId, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT);
    assert.equal(active.entries.some(entry => (entry.data as any)?.diagnostics?.some((d: any) => d.code === "interrupted")), false);
  } finally { await worker.close("suspend"); }
});

for (const code of ["interrupted", "unknown", "wrapped-unknown"] as const) test(`an unsafe ${code} effect stops provider continuation without native policy`, async () => {
  const request = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  request.stage.tools = ["effect"];
  let effects = 0;
  // A second provider request would repeat the same effect under a fresh call ID.
  const model = models(() => ({ type: "toolCall", id: randomUUID(), name: "effect", arguments: {} }));
  const effect = defineTool({ name: "effect", description: "Uncertain effect", parameters: Type.Object({}),
    async execute() {
      effects++;
      if (code === "unknown") throw Object.assign(new Error("Transport lost after effect"), { code });
      if (code === "wrapped-unknown") throw new Error("Edit failed", { cause: Object.assign(new Error("Transport lost after write"), { code: "unknown" }) });
      return { output: [], isError: true, diagnostics: [{ severity: "error" as const, code, message: "Interrupted effect" }] };
    } });
  const worker = await DurableWorker.open({ workspace, models: model.models, storage: new MemoryStorage(), tools: [effect], env: () => undefined });
  try {
    await worker.submit(request);
    const result = (await worker.wait(request.requestId)).state.outcome;
    assert.equal(result.status, "completed"); assert.equal((result as any).result.status, "needs_parent");
    assert.equal(effects, 1); assert.equal(model.count(), 1);
  } finally { await worker.close("suspend"); }
});

test("private local and remote state is rejected before writes when not git-ignored", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-private-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  const identity = { ...workspace, cwd: root };
  const ctx = { sessionManager: { getSessionId: () => randomUUID() } } as any;
  try {
    await assert.rejects(localJobs(root, ctx, { changed() {}, notify() {} }), /Ignore the Piccolo runtime/);
    await assert.rejects(dispatchRemote(root, { workspace: identity, transport: ["must-not-launch"] }, { ...input(), workspace: identity }), /Ignore the Piccolo runtime/);
    assert.equal(fs.existsSync(path.join(root, ".cache")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("remote tasks terminate on a local dispatch privacy rejection", { timeout: 5000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-rejected-dispatch-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  const identity = { ...workspace, cwd: root };
  const worker = await DurableWorker.open({ workspace: identity, models: models().models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  try {
    const request = { ...input(), workspace: identity, placement: { workspace: identity, transport: ["must-not-launch"] } };
    await worker.submit(request);
    const result = (await worker.wait(request.requestId)).state.outcome;
    assert.equal(result.status, "failed"); assert.match((result as any).error.message, /Ignore the Piccolo runtime/);
    assert.equal(fs.existsSync(path.join(root, ".cache")), false);
  } finally { await worker.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ["unknown", "deadline"] as const) test(`uncertain ${failure} review effects cannot become an automatic implementation revision`, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-uncertain-review-"))), worktree = path.join(root, "tree");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git(root, "init"); git(root, "config", "user.email", "fixture@example.invalid"); git(root, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(root, ".gitignore"), "/.pi/\n/.cache/\n/tree/\n"); git(root, "add", "."); git(root, "commit", "-m", "base");
  const identity = { ...workspace, cwd: root }, base = git(root, "rev-parse", "HEAD");
  const spec = { ...(input() as Extract<WorkerSubmission, { kind: "delegate" }>).stage, report: true };
  let calls = 0, effects = 0;
  const model = models(() => {
    if (++calls === 1) {
      fs.writeFileSync(path.join(worktree, "change.txt"), "implemented"); git(worktree, "add", "."); git(worktree, "commit", "-m", "implementation");
      return JSON.stringify({ status: "complete", summary: "implemented", commit: git(worktree, "rev-parse", "HEAD"), evidence: ["candidate"] });
    }
    if (calls > 2) return JSON.stringify({ status: "blocked", summary: "Unexpected revision", commit: git(worktree, "rev-parse", "HEAD"), evidence: ["extra model request"] });
    return [
      { type: "text", text: JSON.stringify({ status: "changes_requested", summary: "revise", commit: git(worktree, "rev-parse", "HEAD"), evidence: ["observed defect"] }) },
      { type: "toolCall", id: randomUUID(), name: "effect", arguments: {} },
    ];
  });
  const effect = defineTool({ name: "effect", description: "Uncertain review side effect", parameters: Type.Object({}), async execute(_args, _api, context) {
    effects++;
    if (failure === "deadline") await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(new Error("Tool stopped after effect"));
      if (context.abortSignal?.aborted) abort(); else context.abortSignal?.addEventListener("abort", abort, { once: true });
    });
    throw Object.assign(new Error("Lost result after effect"), { code: "unknown" });
  } });
  const worker = await DurableWorker.open({ workspace: identity, models: model.models, storage: new MemoryStorage(), tools: [effect], env: () => undefined });
  try {
    const { stage: _stage, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
    const request = { ...envelope, workspace: identity, kind: "workflow", workflow: { root, worktree, branch: "implementation", base, task: "Implement",
      maxRevisions: 1, stages: { implement: [spec], review: [{ ...spec, timeoutMs: 1000, tools: ["effect"] }], qa: [spec] }, checks: {}, validationMode: "reported" } };
    await worker.submit(request); const outcome = (await worker.wait(request.requestId)).state.outcome;
    assert.equal(outcome.status, "completed"); assert.equal((outcome as any).result.status, "needs_parent");
    assert.match((outcome as any).result.summary, /reconciliation/);
    assert.equal(calls, 2); assert.equal(effects, 1);
  } finally { await worker.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const control of ["stop", "session-close"] as const) test(`lost remote admission reply followed by local rejection retains ${control} ownership`, { timeout: 15000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-lost-admission-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n");
  const identity = { ...workspace, cwd: root }, remoteIdentity = { ...identity, identity: randomUUID() };
  const model = models(() => ({ type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Wait for parent" } }));
  const remote = await DurableWorker.open({ workspace: remoteIdentity, models: model.models, storage: new MemoryStorage(), tools: [askParent], env: () => undefined });
  const socket = path.join(root, "worker.sock"), server = await serveWorker(remote, remoteIdentity, socket, async () => {});
  const transport = path.join(root, "transport.py");
  fs.writeFileSync(transport, `import sys,json,subprocess,pathlib\nr=json.load(sys.stdin)\np=subprocess.run([sys.executable,${JSON.stringify(path.resolve("scripts/durable-client.py"))},${JSON.stringify(socket)}],input=json.dumps(r),text=True,capture_output=True)\nif r['operation']=='submit':\n pathlib.Path(${JSON.stringify(path.join(root, ".gitignore"))}).write_text('')\n sys.exit(1)\nsys.stdout.write(p.stdout)\nsys.exit(p.returncode)\n`);
  const target = { workspace: remoteIdentity, transport: ["python3", transport] };
  const local = await DurableWorker.open({ workspace: identity, models: models().models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const jobs = new DurableJobs(root, "test", local, { changed() {}, notify() {}, release() {} });
  const request = { ...input(), lifetime: "session" as const, workspace: identity, placement: target };
  try {
    await jobs.submit(request);
    await eventually(async () => { await jobs.refresh(); return jobs.status(request.requestId).attention_total === 1; });
    assert.equal((await local.inspect(request.requestId)).task!.state.status === "terminal", false);
    assert.equal(model.count(), 1);
    if (control === "stop") await jobs.stop(request.requestId, 3000);
    else await jobs.close("quit");
    await eventually(async () => (await remote.inspect(request.requestId)).task!.state.status === "terminal");
    assert.equal((await remote.inspect(request.requestId)).task!.state.outcome?.status, "aborted");
    assert.equal(model.count(), 1);
  } finally {
    await jobs.close("cleanup"); await new Promise<void>(resolve => server.close(() => resolve()));
    await remote.close("suspend"); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote Jobs message retries retain one input and reject identity reuse with changed text", { timeout: 15000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-message-retry-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" }); fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n");
  const identity = { ...workspace, cwd: root }, remoteIdentity = { ...identity, identity: randomUUID() };
  const model = models(context => JSON.stringify(context.messages).includes("Proceed") ? "done" : { type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Wait" } });
  const remote = await DurableWorker.open({ workspace: remoteIdentity, models: model.models, storage: new MemoryStorage(), tools: [askParent], env: () => undefined });
  const socket = path.join(root, "worker.sock"), server = await serveWorker(remote, remoteIdentity, socket, async () => {});
  const local = await DurableWorker.open({ workspace: identity, models: models().models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const jobs = new DurableJobs(root, "test", local, { changed() {}, notify() {}, release() {} });
  const request = { ...input(), workspace: identity, placement: { workspace: remoteIdentity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] } };
  try {
    await jobs.submit(request); await eventually(async () => { await jobs.refresh(); return jobs.status(request.requestId).attention_total === 1; });
    const id = randomUUID(), first = await jobs.message(request.requestId, "Proceed", undefined, id);
    const second = await jobs.message(request.requestId, "Proceed", undefined, id);
    assert.equal(first.submission, second.submission);
    await assert.rejects(jobs.message(request.requestId, "Changed", undefined, id), /reused/);
    await remote.wait(request.requestId); assert.equal((await remote.status(request.requestId)).messages.length, 1);
  } finally { await jobs.close("cleanup"); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

test("attaching independent remote work preserves its original owner and parent exit does not cancel it", { timeout: 20000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-attach-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" }); fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n");
  const identity = { ...workspace, cwd: root }, remoteIdentity = { ...identity, identity: randomUUID() };
  const model = models(context => JSON.stringify(context.messages).includes("Proceed") ? "done" : { type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Wait" } });
  const remote = await DurableWorker.open({ workspace: remoteIdentity, models: model.models, storage: new MemoryStorage(), tools: [askParent], env: () => undefined });
  const socket = path.join(root, "worker.sock"); let server = await serveWorker(remote, remoteIdentity, socket, async () => {});
  const target = { workspace: remoteIdentity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] };
  const original = { ...input(), workspace: remoteIdentity, owner: "original-parent" };
  const local = await DurableWorker.open({ workspace: identity, models: models().models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const jobs = new DurableJobs(root, "new-parent", local, { changed() {}, notify() {}, release() {} });
  try {
    await dispatchRemote(root, target, original); await eventually(async () => (await remote.status(original.requestId)).attention.length === 1);
    const id = await jobs.attach(retainedAssignment(root, target, original.requestId).submission, target);
    assert.equal(await jobs.attach(original, target), id);
    await eventually(async () => { await jobs.refresh(); return jobs.status(id).attention_total === 1; });
    assert.equal((await local.admission(id)).originOwner, "original-parent"); assert.equal(jobs.status(id).lifetime, "independent"); assert.equal(model.count(), 1);
    await jobs.close("quit"); assert.notEqual((await remote.inspect(id)).task!.state.status, "terminal");
    await workerRequest(target, { operation: "message", requestId: id, messageId: randomUUID(), text: "Proceed" });
    await remote.wait(id); assert.equal(model.count(), 2);
  } finally { await jobs.close("cleanup"); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const restart of [false, true]) test(`aggregate pipeline deadline cancels active children and prevents successors${restart ? " across reopen" : ""}`, { timeout: 15000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-deadline-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n"); git("add", "."); git("commit", "-m", "base");
  const identity = { ...workspace, cwd: root }, base = git("rev-parse", "HEAD"), model = models(() => ({ type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Wait" } }));
  let store = await openWorkerStorage(path.join(root, ".cache", "store"), identity);
  const options = { workspace: identity, models: model.models, tools: [askParent], env: () => undefined };
  let worker = await DurableWorker.open({ ...options, storage: store.storage });
  const stage = (input() as Extract<WorkerSubmission, { kind: "delegate" }>).stage;
  const node = (id: string, needs: string[]) => ({ needs, work: { kind: "delegate", stage, root, cwd: path.join(root, ".cache", id), base, branch: id } });
  const { stage: _unused, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  const request = submissionSchema.parse({ ...envelope, workspace: identity, kind: "experiment",
    pipeline: { nodes: { one: node("one", []), two: node("two", ["one"]) }, maxActive: 1, source: { root, base, files: {} }, failFast: true, timeoutMs: 1000 } });
  try {
    await worker.submit(request); await eventually(async () => (await worker.status(request.requestId)).attention.length === 1);
    const before = (await worker.inspect(request.requestId)).task!.state as any, deadline = before.checkpoint.deadline;
    assert.equal(typeof deadline, "number");
    if (restart) {
      await worker.close("suspend"); store.release();
      await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline - Date.now() + 50)));
      store = await openWorkerStorage(path.join(root, ".cache", "store"), identity);
      worker = await DurableWorker.open({ ...options, storage: store.storage });
    }
    const result = (await worker.wait(request.requestId)).state.outcome as any;
    assert.equal(result.status, "completed"); assert.equal(result.result.status, "needs_parent"); assert.equal(result.result.timedOut, true);
    assert.deepEqual(result.result.pending, ["two"]); assert.equal(fs.existsSync(path.join(root, ".cache", "two")), false); assert.equal(model.count(), 1);
  } finally { await worker.close("suspend"); store.release(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("schedule budget rejection creates no immutable claims", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-claims-budget-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture"); fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n"); git("add", "."); git("commit", "-m", "base");
  const identity = { ...workspace, cwd: root }, base = git("rev-parse", "HEAD"), worker = await DurableWorker.open({ workspace: identity, models: models().models, storage: new MemoryStorage(), tools: [], env: () => undefined, maxJobs: 1 });
  try {
    const first = { ...input(), workspace: identity }; await worker.submit(first); await worker.wait(first.requestId);
    const stage = (input() as Extract<WorkerSubmission, { kind: "delegate" }>).stage;
    const { stage: _unused, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
    const request = submissionSchema.parse({ ...envelope, workspace: identity, kind: "schedule", pipeline: { nodes: { one: { needs: [], work: { kind: "delegate", stage, root, cwd: path.join(root, ".cache", "one"), base, branch: "one" } } }, maxActive: 1, source: { root, base, files: {} }, failFast: true } });
    await assert.rejects(worker.submit(request), /admission budget/);
    const home = path.join(root, ".piccolo", "schedules", (await import("../src/config.ts")).digest({ task: "one", attempt: 1 })), file = path.join(home, "launch.json");
    assert.equal(fs.existsSync(file), false);
  } finally { await worker.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

test("bounded Jobs stop returns stopping while a tool ignores cancellation", { timeout: 10000 }, async () => {
  let release!: () => void, started = false;
  const slow = defineTool({ name: "slow", description: "Fixture", parameters: Type.Object({}), replay: "safe",
    async execute() { started = true; await new Promise<void>(resolve => { release = resolve; }); return { output: [{ type: "text", text: "released" }] }; } });
  const worker = await DurableWorker.open({ workspace, storage: new MemoryStorage(), models: models(() => ({ type: "toolCall", id: "slow", name: "slow", arguments: {} })).models, tools: [slow], env: () => undefined });
  const jobs = new DurableJobs(workspace.cwd, "test", worker, { changed() {}, notify() {}, release() {} });
  const request = input() as Extract<WorkerSubmission, { kind: "delegate" }>; request.stage.tools = ["slow"];
  try {
    await jobs.submit(request); await eventually(async () => started);
    const before = Date.now(), status = await jobs.stop(request.requestId, 30);
    assert.ok(Date.now() - before < 1500); assert.equal(status.stopping, true); assert.equal(status.outcome_revision, undefined);
    release(); await worker.wait(request.requestId);
  } finally { release?.(); await jobs.close("cleanup"); }
});

test("recovery preserves the stored compaction policy while new workers use the Durable default", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pd-stored-compaction-"));
  const original = { enabled: false, reserveTokens: 1234, keepRecentTokens: 4321, backgroundTokens: 0 };
  let store = await openWorkerStorage(directory, workspace), worker = await DurableWorker.open({ workspace, storage: store.storage, models: models().models, tools: [], env: () => undefined, compaction: original });
  try {
    await worker.close("suspend"); store.release(); store = await openWorkerStorage(directory, workspace);
    worker = await DurableWorker.open({ workspace, storage: store.storage, models: models().models, tools: [], env: () => undefined, reuseStoredCompaction: true });
    assert.deepEqual(worker.capabilities().compactionPolicy, original);
  } finally { await worker.close("suspend"); store.release(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("parent Blackhole configuration does not select compaction or extensions for a Durable stage", () => {
  const resolved = loadConfig(workspace.cwd, { profile: "blackhole", userFile: path.join(workspace.cwd, "missing-piccolo-config.toml"), invocation: { integration: { server_compaction: "none" } } });
  resolved.config.integration = { child_extensions: ["/parent/native-only.ts"] };
  const request: any = prepareSubmission({ kind: "delegate", arguments: { task: "Answer" }, resolved,
    agents: { delegate: resolveAgent(resolved, "implementer") }, parent: { model: "test/test", effort: "off" } }, workspace, "parent");
  assert.equal(request.kind, "delegate"); assert.equal(request.stage.compaction, undefined); assert.equal(request.stage.extensions, undefined);
});

test("a conflict in a later schedule node does not leave an earlier node claimed", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-claim-preflight-")));
  const identity = { ...workspace, cwd: root }, stage = (input() as Extract<WorkerSubmission, { kind: "delegate" }>).stage;
  const { stage: _unused, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  const request = (ids: string[]) => submissionSchema.parse({ ...envelope, requestId: randomUUID(), workspace: identity, kind: "schedule", pipeline: {
    nodes: Object.fromEntries(ids.map(id => [id, { needs: [], work: { kind: "delegate", stage, root, cwd: path.join(root, id), base: "0".repeat(40), branch: id } }])),
    maxActive: 1, source: { root, base: "0".repeat(40), files: {} }, failFast: true } });
  try {
    fs.mkdirSync(path.join(root, ".piccolo"));
    fs.writeFileSync(path.join(root, ".piccolo", "schedule.toml"), "format = 1\n[tasks]\n");
    fs.writeFileSync(path.join(root, ".piccolo", "roadmap.json"), JSON.stringify({ format: 1, tasks: [] }));
    claimSchedule(root, request(["later"]));
    assert.throws(() => claimSchedule(root, request(["earlier", "later"])), /already claimed/);
    const digest = (await import("../src/config.ts")).digest;
    assert.equal(fs.existsSync(path.join(root, ".piccolo", "schedules", digest({ task: "earlier", attempt: 1 }), "launch.json")), false);
    assert.equal(fs.existsSync(path.join(root, ".piccolo", "schedules", digest({ task: "later", attempt: 1 }), "launch.json")), true);
    assert.equal(inspectSchedule(root).claims.length, 1);
    claimSchedule(root, request(["earlier"]));
    assert.equal(inspectSchedule(root).claims.length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const control of ["stop", "session-close", "late-result"] as const) test(`unchanged remote polls retain ${control} after multiple idle intervals`, { timeout: 15000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-idle-remote-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" }); fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n");
  const identity = { ...workspace, cwd: root }, remoteIdentity = { ...identity, identity: randomUUID() };
  const model = models(context => JSON.stringify(context.messages).includes("Proceed") ? "done" : { type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Wait" } });
  const remote = await DurableWorker.open({ workspace: remoteIdentity, models: model.models, storage: new MemoryStorage(), tools: [askParent], env: () => undefined });
  const socket = path.join(root, "worker.sock"), server = await serveWorker(remote, remoteIdentity, socket, async () => {});
  const local = await DurableWorker.open({ workspace: identity, models: models().models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const jobs = new DurableJobs(root, "test", local, { changed() {}, notify() {}, release() {} });
  const request = { ...input(), lifetime: "session" as const, workspace: identity, placement: { workspace: remoteIdentity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] } };
  try {
    await jobs.submit(request); await eventually(async () => { await jobs.refresh(); return jobs.status(request.requestId).attention_total === 1; });
    await eventually(async () => { const state = (await local.inspect(request.requestId)).task!.state as any; return state.status === "terminal" || state.checkpoint?.poll >= 3; });
    assert.notEqual((await local.inspect(request.requestId)).task!.state.status, "terminal"); assert.equal(model.count(), 1);
    if (control === "stop") await jobs.stop(request.requestId, 3000);
    else if (control === "session-close") await jobs.close("quit");
    else { await jobs.message(request.requestId, "Proceed", undefined, randomUUID()); await jobs.wait(request.requestId, 3000); }
    assert.equal((await remote.inspect(request.requestId)).task!.state.status, "terminal");
    if (control === "late-result") { await jobs.refresh(); assert.equal(jobs.status(request.requestId).state, "completed"); }
  } finally { await jobs.close("cleanup"); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a definite first remote rejection has a durable negative receipt and does not poll forever", { timeout: 10000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-rejected-remote-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" }); fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n");
  const identity = { ...workspace, cwd: root }, remoteIdentity = { ...identity, identity: randomUUID() }, model = models();
  const remote = await DurableWorker.open({ workspace: remoteIdentity, models: model.models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const socket = path.join(root, "worker.sock"), server = await serveWorker(remote, remoteIdentity, socket, async () => {});
  const local = await DurableWorker.open({ workspace: identity, models: models().models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const request = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  request.stage.tools = ["unavailable"]; const placed = { ...request, workspace: identity, placement: { workspace: remoteIdentity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] } };
  try {
    await local.submit(placed); const result = (await local.wait(request.requestId)).state.outcome as any;
    assert.equal(result.status, "failed"); assert.match(result.error.message, /Unavailable worker tool/); assert.equal(result.result.status, "rejected"); assert.equal(model.count(), 0);
    const rejection = await remote.rejection(request.requestId); assert.equal(rejection?.state, "rejected");
    const admission = await local.admission(request.requestId); await local.cancelSaved("test");
    assert.equal((await local.admission(request.requestId)).taskId, admission.taskId);
    assert.equal(((await local.inspect(request.requestId)).task!.state as any).outcome.result.status, "rejected");
    const changed = { ...request, workspace: remoteIdentity, stage: { ...request.stage, tools: [] } };
    await assert.rejects(remote.submit(changed), /rejected before admission/); assert.equal(model.count(), 0);
  } finally { await local.close("suspend"); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

test("fresh stage budget is per owner and a restored stage is not charged again", { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pd-owner-launches-"));
  const model = models(context => JSON.stringify(context.messages).includes("Proceed") ? "done" : { type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Wait" } });
  const options = { workspace, models: model.models, tools: [askParent], env: () => undefined, maxLaunchesPerOwner: 1 };
  let store = await openWorkerStorage(directory, workspace), worker = await DurableWorker.open({ ...options, storage: store.storage });
  try {
    const first = input(); await worker.submit(first); await eventually(async () => (await worker.status(first.requestId)).attention.length === 1);
    await worker.close("suspend"); store.release(); store = await openWorkerStorage(directory, workspace); worker = await DurableWorker.open({ ...options, storage: store.storage });
    await worker.message(first.requestId, randomUUID(), "Proceed"); assert.equal((await worker.wait(first.requestId)).state.outcome.status, "completed");
    const count = model.count(), second = input(); await worker.submit(second); const denied = (await worker.wait(second.requestId)).state.outcome as any;
    assert.notEqual(denied.result?.status, "complete"); assert.match(JSON.stringify(denied), /stage launch guideline/); assert.equal(model.count(), count);
    const third = input() as Extract<WorkerSubmission, { kind: "delegate" }>; third.owner = "another-parent"; third.stage.task = "Proceed";
    await worker.submit(third); assert.equal((await worker.wait(third.requestId)).state.outcome.status, "completed"); assert.equal(model.count(), count + 1);
  } finally { await worker.close("suspend"); store.release(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("source preflight crossing an aggregate deadline admits no successor task", { timeout: 15000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-slow-preflight-"))), priorPath = process.env.PATH;
  const systemGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const git = (...args: string[]) => execFileSync(systemGit, ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture"); fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n"); git("add", "."); git("commit", "-m", "base");
  const identity = { ...workspace, cwd: root }, base = git("rev-parse", "HEAD"), model = models();
  const worker = await DurableWorker.open({ workspace: identity, models: model.models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const wrapper = path.join(root, ".cache", "bin"); fs.mkdirSync(wrapper, { recursive: true });
  const quotedGit = "'" + systemGit.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(wrapper, "git"), `#!/bin/sh\nif [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then sleep 1.1; fi\nexec ${quotedGit} "$@"\n`, { mode: 0o700 });
  process.env.PATH = wrapper + path.delimiter + priorPath;
  const { stage, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  const request = submissionSchema.parse({ ...envelope, workspace: identity, kind: "experiment", pipeline: { nodes: { one: { needs: [], work: { kind: "delegate", stage, root, cwd: path.join(root, ".cache", "one"), base, branch: "one" } } }, maxActive: 1, source: { root, base, files: {} }, failFast: true, timeoutMs: 1000 } });
  try {
    await worker.submit(request); const result = (await worker.wait(request.requestId)).state.outcome as any;
    assert.equal(result.result.timedOut, true); assert.deepEqual(result.result.pending, ["one"]); assert.equal(model.count(), 0);
    assert.equal((await worker.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(task => task.record.kind === "piccolo.pipeline-node").length, 0);
    assert.equal(fs.existsSync(path.join(root, ".cache", "one")), false);
  } finally { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; await worker.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a stop wait deadline cannot withdraw an abort mark queued behind a busy mutation line", { timeout: 10000 }, async () => {
  const worker = await DurableWorker.open({ workspace, storage: new MemoryStorage(), models: models(() => ({ type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Wait" } })).models, tools: [askParent], env: () => undefined });
  const jobs = new DurableJobs(workspace.cwd, "test", worker, { changed() {}, notify() {}, release() {} });
  let release!: () => void;
  try {
    const request = input(); await jobs.submit(request); await eventually(async () => (await worker.status(request.requestId)).attention.length === 1);
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const busy = worker.harness.commit(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); }, BACKGROUND_CONTEXT);
    await started;
    const before = Date.now(), status = await jobs.stop(request.requestId, 20);
    assert.ok(Date.now() - before < 500); assert.equal(status.stopping, true);
    release(); await busy;
    const outcome = (await worker.wait(request.requestId)).state.outcome;
    assert.equal(outcome.status, "aborted");
  } finally { release?.(); await jobs.close("cleanup"); }
});

test("a lost message reply can reconcile after a workflow advances to multiple review stages", { timeout: 20000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-message-topology-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture"); fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n/.pi/\n"); git("add", "."); git("commit", "-m", "base");
  fs.mkdirSync(path.join(root, ".cache")); const base = git("rev-parse", "HEAD"), identity = { ...workspace, cwd: root }, remoteIdentity = { ...identity, identity: randomUUID() };
  const model = models(context => {
    const text = JSON.stringify(context.messages);
    if (text.includes("ROLE_IMPL") && text.includes("Proceed")) {
      const cwd = path.join(root, ".cache", "tree");
      const command = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
      if (command("rev-parse", "HEAD") === base) { fs.writeFileSync(path.join(cwd, "change.txt"), "fixture"); command("add", "change.txt"); command("commit", "-m", "fixture change"); }
      return JSON.stringify({ status: "complete", summary: "done", commit: command("rev-parse", "HEAD"), evidence: [] });
    }
    return { type: "toolCall", id: "question", name: "ask_parent", arguments: { question: text.includes("ROLE_IMPL") ? "Implementation decision" : "Review decision" } };
  });
  const remote = await DurableWorker.open({ workspace: remoteIdentity, models: model.models, storage: new MemoryStorage(), tools: [askParent], env: () => undefined });
  const socket = path.join(root, ".cache", "worker.sock"), server = await serveWorker(remote, remoteIdentity, socket, async () => {}), transport = path.join(root, ".cache", "transport.py");
  const marker = path.join(root, ".cache", "lost-message");
  fs.writeFileSync(transport, `import sys,json,subprocess,pathlib\nr=json.load(sys.stdin)\np=subprocess.run([sys.executable,${JSON.stringify(path.resolve("scripts/durable-client.py"))},${JSON.stringify(socket)}],input=json.dumps(r),text=True,capture_output=True)\nm=pathlib.Path(${JSON.stringify(marker)})\nif r['operation']=='message' and not m.exists():\n m.write_text('lost')\n sys.exit(1)\nsys.stdout.write(p.stdout)\nsys.exit(p.returncode)\n`);
  const local = await DurableWorker.open({ workspace: identity, models: models().models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const jobs = new DurableJobs(root, "test", local, { changed() {}, notify() {}, release() {} });
  const { stage, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  const spec = (name: string, role: string) => ({ ...stage, name, instructions: role, report: true });
  const request = submissionSchema.parse({ ...envelope, workspace: identity, lifetime: "session", placement: { workspace: remoteIdentity, transport: ["python3", transport] }, kind: "workflow",
    workflow: { root, worktree: path.join(root, ".cache", "tree"), branch: "message-topology", base, task: "Fixture", maxRevisions: 0, checks: {}, validationMode: "reported",
      stages: { implement: [spec("implement", "ROLE_IMPL")], review: [spec("review-one", "ROLE_REVIEW"), spec("review-two", "ROLE_REVIEW")], qa: [spec("qa", "ROLE_QA")] } } });
  try {
    await jobs.submit(request); await eventually(async () => { await jobs.refresh(); return jobs.status(request.requestId).attention_total === 1; });
    const id = randomUUID(); await assert.rejects(jobs.message(request.requestId, "Proceed", undefined, id), /Transport/);
    await eventually(async () => { await jobs.refresh(); return jobs.status(request.requestId).children_total === 2 && jobs.status(request.requestId).attention_total === 2; });
    const repeated = await jobs.message(request.requestId, "Proceed", undefined, id);
    assert.equal(repeated.id, id); assert.equal((await remote.status(request.requestId)).messages.length, 1);
    await assert.rejects(jobs.message(request.requestId, "Changed", undefined, id), /reused/);
  } finally { await jobs.close("cleanup"); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a base-format fingerprint-only store recovers its original compaction policy", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pd-legacy-policy-")), legacy = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 0 };
  const token = defineDoc<{ fingerprint: string | null }>({ kind: "piccolo.worker-configuration", version: 1, scope: "session", initial: () => ({ fingerprint: null }) });
  let store = await openWorkerStorage(directory, workspace);
  const old = await Harness.open(store.storage, { registry: createRegistry(), models: models().models }, BACKGROUND_CONTEXT);
  await old.commit(async tx => { (await tx.doc(token)).fingerprint = (await import("../src/config.ts")).digest({ compaction: legacy, policy: null }); }, BACKGROUND_CONTEXT);
  await old.close(BACKGROUND_CONTEXT); store.release(); store = await openWorkerStorage(directory, workspace);
  const worker = await DurableWorker.open({ workspace, storage: store.storage, models: models().models, tools: [], env: () => undefined, reuseStoredCompaction: true, legacyCompactions: [legacy] });
  try { assert.deepEqual(worker.capabilities().compactionPolicy, legacy); }
  finally { await worker.close("suspend"); store.release(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("saved-store protection is enforced by Worker submit and wait until an explicit decision", { timeout: 10000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pd-store-fence-")), model = models(() => ({ type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Wait" } }));
  const options = { workspace, models: model.models, tools: [askParent], env: () => undefined };
  let store = await openWorkerStorage(directory, workspace), worker = await DurableWorker.open({ ...options, storage: store.storage });
  try {
    const request = input(); await worker.submit(request); await eventually(async () => (await worker.status(request.requestId)).attention.length === 1);
    await worker.close("suspend"); store.release(); store = await openWorkerStorage(directory, workspace); worker = await DurableWorker.open({ ...options, storage: store.storage, resume: false });
    await assert.rejects(worker.submit(input()), /Saved Jobs are suspended/); await assert.rejects(worker.wait(request.requestId), /waiting cannot resume/);
    assert.equal(model.count(), 1); await worker.cancelSaved("test"); assert.equal((await worker.inspect(request.requestId)).task!.state.status, "terminal"); assert.equal(model.count(), 1);
  } finally { await worker.close("suspend"); store.release(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a message not sent to the remote is uncertain rather than routed", { timeout: 10000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-unsent-message-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" }); fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n");
  const identity = { ...workspace, cwd: root }, remoteIdentity = { ...identity, identity: randomUUID() };
  const remote = await DurableWorker.open({ workspace: remoteIdentity, models: models(() => ({ type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Wait" } })).models, storage: new MemoryStorage(), tools: [askParent], env: () => undefined });
  const socket = path.join(root, "worker.sock"), server = await serveWorker(remote, remoteIdentity, socket, async () => {}), transport = path.join(root, "transport.py");
  fs.writeFileSync(transport, `import sys,json,subprocess\nr=json.load(sys.stdin)\nif r['operation']=='message':sys.exit(1)\np=subprocess.run([sys.executable,${JSON.stringify(path.resolve("scripts/durable-client.py"))},${JSON.stringify(socket)}],input=json.dumps(r),text=True,capture_output=True)\nsys.stdout.write(p.stdout)\nsys.exit(p.returncode)\n`);
  const local = await DurableWorker.open({ workspace: identity, models: models().models, storage: new MemoryStorage(), tools: [], env: () => undefined }), jobs = new DurableJobs(root, "test", local, { changed() {}, notify() {}, release() {} });
  const request = { ...input(), lifetime: "session" as const, workspace: identity, placement: { workspace: remoteIdentity, transport: ["python3", transport] } };
  try {
    await jobs.submit(request); await eventually(async () => { await jobs.refresh(); return jobs.status(request.requestId).attention_total === 1; });
    await assert.rejects(jobs.message(request.requestId, "Proceed", undefined, randomUUID()), /Transport/); await jobs.refresh();
    assert.equal(jobs.status(request.requestId).messages[0].state, "uncertain"); assert.equal((await remote.status(request.requestId)).messages.length, 0);
  } finally { await jobs.close("cleanup"); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const committed of [false, true]) test(`schedule commit failure ${committed ? "retains admitted claims" : "cleans new claim directories"}`, { timeout: 10000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-claim-commit-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  fs.mkdirSync(path.join(root, ".piccolo")); fs.writeFileSync(path.join(root, ".piccolo", "schedule.toml"), 'format = 1\n[tasks]\n'); fs.writeFileSync(path.join(root, ".piccolo", "roadmap.json"), JSON.stringify({ format: 1, tasks: [] }));
  fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n"); git("add", "."); git("commit", "-m", "base"); fs.mkdirSync(path.join(root, ".cache"));
  const identity = { ...workspace, cwd: root }, base = git("rev-parse", "HEAD"), worker = await DurableWorker.open({ workspace: identity, models: models().models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const { stage, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  const request = submissionSchema.parse({ ...envelope, workspace: identity, kind: "schedule", pipeline: { nodes: { one: { needs: [], work: { kind: "delegate", stage, root, cwd: path.join(root, ".cache", "one"), base, branch: "one" } } }, maxActive: 1, source: { root, base, files: {} }, failFast: true } });
  const original = worker.harness.commit.bind(worker.harness);
  (worker.harness as any).commit = async (change: any, context: any) => {
    const value = await original(async tx => {
      const result = await change(tx);
      if (!committed && result?.input?.kind === "schedule") throw new Error("Injected commit failure");
      return result;
    }, context);
    if (committed && (value as any)?.input?.kind === "schedule") throw new Error("Injected lost commit reply");
    return value;
  };
  try {
    await assert.rejects(worker.submit(request), /Injected/);
    assert.equal(inspectSchedule(root).claims.length, committed ? 1 : 0);
    if (committed) { assert.ok(await worker.admission(request.requestId)); await worker.abort(request.requestId); }
  } finally { (worker.harness as any).commit = original; await worker.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const shape of ["faulted", "legacy"] as const) for (const action of (shape === "legacy" ? ["resume", "stop", "cancel", "cancel-unavailable", "quit"] : ["resume", "stop", "cancel", "cancel-unavailable", "cancel-race", "cancel-race-unavailable", "cancel-race-window", "quit"]) as string[]) test(`explicit ${action} repairs a ${shape} remote controller without resubmitting its agent`, { timeout: 15000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-controller-repair-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" }); fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n");
  const identity = { ...workspace, cwd: root }, remoteIdentity = { ...identity, identity: randomUUID() }, model = models(context => JSON.stringify(context.messages).includes("Proceed") ? "done" : { type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Wait" } });
  const remote = await DurableWorker.open({ workspace: remoteIdentity, models: model.models, storage: new MemoryStorage(), tools: [askParent], env: () => undefined });
  const socket = path.join(root, "worker.sock"); let server = await serveWorker(remote, remoteIdentity, socket, async () => {});
  const target = { workspace: remoteIdentity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] }, directory = path.join(root, ".cache", "controller");
  let store = await openWorkerStorage(directory, identity), local = await DurableWorker.open({ workspace: identity, models: models().models, storage: store.storage, tools: [], env: () => undefined });
  const request = { ...input(), lifetime: "session" as const, workspace: identity, placement: target }; let jobs = new DurableJobs(root, "test", local, { changed() {}, notify() {}, release() {} });
  try {
    await jobs.submit(request); await eventually(async () => { await jobs.refresh(); return jobs.status(request.requestId).attention_total === 1; });
    await jobs.close("suspend"); store.release(); store = await openWorkerStorage(directory, identity);
    local = await DurableWorker.open({ workspace: identity, models: models().models, storage: store.storage, tools: [], env: () => undefined, resume: false });
    const oldId = (await local.admission(request.requestId)).taskId;
    if (action === "stop") await local.resumeSaved();
    await local.harness.commit(async tx => { const record = (await tx.task(oldId as any))!; // Test-only historical record injection; production uses public abort/create APIs.
      // Base RemoteTask stored this plain failure after a lost submit reply plus
      // retry preflight rejection. The separate lost-reply/privacy test exercises
      // that real trigger; this persisted fixture preserves its unclassified shape.
      if (shape === "legacy") delete (await tx.doc(RemoteSnapshots)).requests[request.requestId];
      (tx as any).setTask({ ...record, state: { status: "terminal", outcome: { status: shape === "legacy" ? "failed" : "faulted", error: { message: shape === "legacy" ? "local retry rejected after lost admission reply" : "legacy idle poll fault" } } }, endedAt: Date.now() }); }, BACKGROUND_CONTEXT);
    if (action === "resume") await local.resumeSaved();
    else if (action === "stop") await local.abort(request.requestId);
    else if (action === "quit") {
      await local.close("cancel-session", "test"); store.release(); store = await openWorkerStorage(directory, identity);
      local = await DurableWorker.open({ workspace: identity, models: models().models, storage: store.storage, tools: [], env: () => undefined, resume: false });
      await local.resumeSaved(); await local.wait(request.requestId);
    }
    else if (action.startsWith("cancel-race")) {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const replace = (local as any).replaceRemoteController.bind(local); // Test-only phase barrier, outside the Harness mutation line.
      (local as any).replaceRemoteController = async (id: string, old: any, cancel: boolean) => { if (cancel) { enter(); await gate; } return replace(id, old, cancel); };
      const wait = withCancel(BACKGROUND_CONTEXT); let timer: ReturnType<typeof setTimeout> | undefined;
      if (action === "cancel-race-window") {
        const mark = local.harness.abortTask.bind(local.harness);
        // Test-only crash window: the logical intent commits, but this process
        // ends before the replacement task's abort mark can be written.
        (local.harness as any).abortTask = (id: number, ctx: any) => id === oldId ? mark(id as any, ctx) : Promise.resolve("marked");
      }
      const cancellation = local.cancelSaved("test", wait.context).catch(error => error);
      try {
        await entered; await local.resumeSaved();
        const winner = await local.admission(request.requestId); assert.notEqual(winner.taskId, oldId);
        if (action === "cancel-race-unavailable") await new Promise<void>(resolve => server.close(() => resolve()));
        if (action === "cancel-race-window") timer = setTimeout(() => wait.cancel(), 100);
        release(); const outcome = await cancellation;
        if (action === "cancel-race-window") assert.ok(outcome instanceof WorkerWaitCancelled); else assert.ok(!(outcome instanceof Error));
        const saved = await local.inspect(request.requestId); assert.equal(saved.cancellationRequested, true); assert.equal(saved.taskId, winner.taskId);
        if (action === "cancel-race-unavailable") {
          assert.equal((saved.task!.state as any).outcome.result.status, "unresolved");
          assert.equal((saved.task!.input as any).cancel, false, "resume won with an ordinary observer, so persistence must live on the Job");
          await local.close("suspend"); store.release(); server = await serveWorker(remote, remoteIdentity, socket, async () => {});
          store = await openWorkerStorage(directory, identity); local = await DurableWorker.open({ workspace: identity, models: models().models, storage: store.storage, tools: [], env: () => undefined, resume: false });
          assert.equal((await local.inspect(request.requestId)).task!.abortRequested, true, "reopening reconciles Job intent before scheduling");
          await local.resumeSaved(); await local.wait(request.requestId);
          assert.equal((await local.admission(request.requestId)).cancellationRequested, true);
        }
        if (action === "cancel-race-window") {
          assert.notEqual(saved.task!.state.status, "terminal"); assert.ok(!saved.task!.abortRequested);
          await local.close("suspend"); store.release(); store = await openWorkerStorage(directory, identity);
          local = await DurableWorker.open({ workspace: identity, models: models().models, storage: store.storage, tools: [], env: () => undefined, resume: false });
          assert.equal((await local.inspect(request.requestId)).task!.abortRequested, true, "reopening reconciles intent committed before the missing task mark");
          await local.resumeSaved(); await local.wait(request.requestId);
        }
        assert.equal(((await remote.inspect(request.requestId)).task!.state as any).outcome.status, "aborted");
      } finally { if (timer) clearTimeout(timer); wait.cancel(); release(); await cancellation; }
    }
    else {
      if (action === "cancel-unavailable") await new Promise<void>(resolve => server.close(() => resolve()));
      await local.cancelSaved("test");
      if (action === "cancel-unavailable") {
        const cancelled = await local.inspect(request.requestId);
        assert.equal((cancelled.task!.input as any).cancel, true);
        assert.equal((cancelled.task!.state as any).outcome.result.status, "unresolved");
        assert.notEqual((await remote.inspect(request.requestId)).task!.state.status, "terminal");
        await local.close("suspend"); store.release();
        server = await serveWorker(remote, remoteIdentity, socket, async () => {});
        store = await openWorkerStorage(directory, identity);
        local = await DurableWorker.open({ workspace: identity, models: models().models, storage: store.storage, tools: [], env: () => undefined, resume: false });
        await local.resumeSaved(); await local.wait(request.requestId);
      }
      assert.equal((await remote.inspect(request.requestId)).task!.state.status, "terminal");
      assert.equal(((await remote.inspect(request.requestId)).task!.state as any).outcome.status, "aborted");
    }
    if (action === "stop" || action === "quit") assert.equal(((await remote.inspect(request.requestId)).task!.state as any).outcome.status, "aborted");
    jobs = new DurableJobs(root, "test", local, { changed() {}, notify() {}, release() {} }); await jobs.refresh();
    assert.notEqual((await local.admission(request.requestId)).taskId, oldId); assert.ok((await local.admission(request.requestId)).previousControllers!.includes(oldId)); assert.equal(model.count(), 1);
    if (action === "resume") {
      await jobs.message(request.requestId, "Proceed", undefined, randomUUID()); await jobs.wait(request.requestId, 3000);
      assert.equal(jobs.status(request.requestId).state, "completed"); assert.equal(model.count(), 2);
    } else assert.equal(jobs.status(request.requestId).state, "cancelled");
  } finally { await jobs.close("suspend"); store.release(); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const transient of [false, true]) for (const control of ["stop", "cancel", "quit"] as const) test(`remote preflight ${transient ? "after a transient failure" : "against an older worker"} stays terminal under ${control}`, { timeout: 10000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-old-worker-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" }); fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n");
  const identity = { ...workspace, cwd: root }, remoteIdentity = { ...identity, identity: randomUUID() }, transport = path.join(root, "transport.py"), calls = path.join(root, "calls.jsonl");
  fs.writeFileSync(transport, `import sys,json,pathlib\nr=json.load(sys.stdin)\np=pathlib.Path(${JSON.stringify(calls)})\nfirst=not p.exists()\nwith p.open('a') as f:f.write(json.dumps(r)+'\\n')\nif ${transient ? "True" : "False"} and first:sys.exit(1)\nprint(json.dumps({'result':{'version':${transient ? 2 : 1},'registry':'piccolo-1','workspace':${JSON.stringify(remoteIdentity)},'capabilities':{'submissionFeatures':[]}}}))\n`);
  const directory = path.join(root, ".cache", "local"), options = { workspace: identity, models: models().models, tools: [], env: () => undefined };
  let store = await openWorkerStorage(directory, identity), local = await DurableWorker.open({ ...options, storage: store.storage });
  const request = { ...input(), lifetime: "session" as const, workspace: identity, placement: { workspace: remoteIdentity, transport: ["python3", transport] } };
  try {
    await local.submit(request); const outcome = (await local.wait(request.requestId)).state.outcome as any, admission = await local.admission(request.requestId);
    assert.equal(outcome.status, "failed"); assert.match(outcome.error.message, transient ? /identity or registry mismatch/ : /rejection receipts are required/);
    assert.equal(outcome.result.status, "rejected");
    if (control === "stop") await local.abort(request.requestId);
    else if (control === "cancel") await local.cancelSaved("test");
    else { await local.close("cancel-session", "test"); store.release(); store = await openWorkerStorage(directory, identity); local = await DurableWorker.open({ ...options, storage: store.storage, resume: false }); }
    assert.equal((await local.admission(request.requestId)).taskId, admission.taskId);
    assert.deepEqual(((await local.inspect(request.requestId)).task!.state as any).outcome, outcome);
    const operations = fs.readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line).operation);
    assert.deepEqual(operations, transient ? ["info", "info"] : ["info"]);
  } finally { await local.close("suspend"); store.release(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ["failed", "faulted"] as const) for (const control of ["stop", "cancel", "quit"] as const) test(`verified remote ${failure} outcome is preserved under ${control}`, { timeout: 15000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-terminal-outcome-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" }); fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n");
  const identity = { ...workspace, cwd: root }, remoteIdentity = { ...identity, identity: randomUUID() }, model = models();
  let acquisitions = 0;
  const remote = await DurableWorker.open({ workspace: remoteIdentity, storage: new MemoryStorage(), models: model.models, tools: [], env: () => undefined,
    ...(failure === "faulted" ? { instructions: () => { throw new Error("verified remote stage setup failed"); } } : {
      resources: { async acquire() { if (++acquisitions > 1) await new Promise(resolve => setTimeout(resolve, 1200)); }, release() {}, close() {} } as any,
    }) });
  const socket = path.join(root, "worker.sock"), server = await serveWorker(remote, remoteIdentity, socket, async () => {}), directory = path.join(root, ".cache", "local");
  const options = { workspace: identity, models: models().models, tools: [], env: () => undefined };
  let store = await openWorkerStorage(directory, identity), local = await DurableWorker.open({ ...options, storage: store.storage });
  const original = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  const request = { ...original, stage: { ...original.stage, timeoutMs: failure === "failed" ? 1000 : original.stage.timeoutMs }, lifetime: "session" as const, workspace: identity, placement: { workspace: remoteIdentity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] } };
  try {
    await local.submit(request); const outcome = (await local.wait(request.requestId)).state.outcome as any, admission = await local.admission(request.requestId);
    assert.equal(outcome.status, failure); assert.match(outcome.error.message, failure === "failed" ? /Stage deadline exceeded/ : /verified remote stage setup failed/);
    assert.deepEqual(((await remote.inspect(request.requestId)).task!.state as any).outcome, outcome);
    if (control === "stop") await local.abort(request.requestId);
    else if (control === "cancel") await local.cancelSaved("test");
    else { await local.close("cancel-session", "test"); store.release(); store = await openWorkerStorage(directory, identity); local = await DurableWorker.open({ ...options, storage: store.storage, resume: false }); }
    assert.equal((await local.admission(request.requestId)).taskId, admission.taskId);
    assert.deepEqual(((await local.inspect(request.requestId)).task!.state as any).outcome, outcome); assert.equal(model.count(), 0);
  } finally { await local.close("suspend"); store.release(); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ["failed", "faulted"] as const) test(`a late remote ${failure} outcome observed by cancellation remains verified after the worker goes offline`, { timeout: 15000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-late-terminal-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" }); fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n");
  const identity = { ...workspace, cwd: root }, remoteIdentity = { ...identity, identity: randomUUID() }, model = models();
  let acquireCount = 0, entered!: () => void, release!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const remote = await DurableWorker.open({ workspace: remoteIdentity, storage: new MemoryStorage(), models: model.models, tools: [], env: () => undefined,
    ...(failure === "failed" ? { resources: { async acquire() { if (++acquireCount > 1) { entered(); await gate; } }, release() {}, close() {} } as any } : {
      instructions: async () => { entered(); await gate; throw new Error("late verified remote setup fault"); },
    }) });
  const socket = path.join(root, "worker.sock"); let server = await serveWorker(remote, remoteIdentity, socket, async () => {});
  const directory = path.join(root, ".cache", "local"), options = { workspace: identity, models: models().models, tools: [], env: () => undefined };
  let store = await openWorkerStorage(directory, identity), local = await DurableWorker.open({ ...options, storage: store.storage });
  const original = input() as Extract<WorkerSubmission, { kind: "delegate" }>, request = { ...original, stage: { ...original.stage, timeoutMs: 1000 }, lifetime: "session" as const, workspace: identity,
    placement: { workspace: remoteIdentity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] } };
  try {
    await local.submit(request); await entry; await local.close("suspend"); store.release(); store = await openWorkerStorage(directory, identity);
    local = await DurableWorker.open({ ...options, storage: store.storage, resume: false });
    const oldId = (await local.admission(request.requestId)).taskId;
    await local.harness.commit(async tx => { const old = (await tx.task(oldId as any))!;
      (tx as any).setTask({ ...old, state: { status: "terminal", outcome: { status: "faulted", error: { message: "local observer failed before remote completion" } } }, endedAt: Date.now() }); }, BACKGROUND_CONTEXT);
    await new Promise(resolve => setTimeout(resolve, 1100)); release(); const actual = (await remote.wait(request.requestId)).state.outcome;
    assert.equal(actual.status, failure); await local.cancelSaved("test");
    const saved = await local.inspect(request.requestId); assert.deepEqual((saved.task!.state as any).outcome, actual);
    assert.equal((await local.harness.snapshot(RemoteSnapshots, BACKGROUND_CONTEXT))!.requests[request.requestId].task.state.status, "terminal");
    await new Promise<void>(resolve => server.close(() => resolve()));
    await local.close("cancel-session", "test"); store.release(); store = await openWorkerStorage(directory, identity);
    local = await DurableWorker.open({ ...options, storage: store.storage, resume: false });
    assert.equal((await local.admission(request.requestId)).taskId, saved.taskId); assert.deepEqual(((await local.inspect(request.requestId)).task!.state as any).outcome, actual); assert.equal(model.count(), 0);
  } finally { release(); await local.close("suspend"); store.release(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});


test("saved cancellation isolates a missing remote intent, cancels healthy siblings and retains the failure for repair", { timeout: 20000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-cancel-isolation-")));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" }); fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n");
  const identity = { ...workspace, cwd: root }, remoteIdentity = { ...identity, identity: randomUUID() };
  const model = models(() => ({ type: "toolCall", id: "question", name: "ask_parent", arguments: { question: "Wait" } }));
  const remote = await DurableWorker.open({ workspace: remoteIdentity, models: model.models, storage: new MemoryStorage(), tools: [askParent], env: () => undefined });
  const socket = path.join(root, "worker.sock"), server = await serveWorker(remote, remoteIdentity, socket, async () => {});
  const target = { workspace: remoteIdentity, transport: ["python3", path.resolve("scripts/durable-client.py"), socket] }, directory = path.join(root, ".cache", "controller");
  let store = await openWorkerStorage(directory, identity), local = await DurableWorker.open({ workspace: identity, models: models().models, storage: store.storage, tools: [], env: () => undefined });
  const requests = [0, 1].map(() => ({ ...input(), workspace: identity, lifetime: "session" as const, placement: target }));
  try {
    for (const request of requests) await local.submit(request);
    await eventually(async () => { try { return (await remote.status(requests[0].requestId)).attention.length === 1 && (await remote.status(requests[1].requestId)).attention.length === 1; } catch { return false; } });
    await local.close("suspend"); store.release(); store = await openWorkerStorage(directory, identity);
    local = await DurableWorker.open({ workspace: identity, models: models().models, storage: store.storage, tools: [], env: () => undefined, cancellationOnly: true });
    await assert.rejects(local.wait(requests[1].requestId), /Start saved cancellation/);
    for (const request of requests) {
      const taskId = (await local.admission(request.requestId)).taskId;
      await local.harness.commit(async tx => {
      const task = (await tx.task(taskId as any))!;
      delete (await tx.doc(RemoteSnapshots)).requests[request.requestId];
      (tx as any).setTask({ ...task, state: { status: "terminal", outcome: { status: "failed", error: { message: "legacy dispatcher failure" } } }, endedAt: Date.now() });
    }, BACKGROUND_CONTEXT); }
    const intent = path.join(root, ".cache", "piccolo", "dispatch", `${requests[0].requestId}.json`), saved = fs.readFileSync(intent); fs.unlinkSync(intent);
    const before = model.count(); await local.cancelSaved("test"); await local.wait(requests[1].requestId);
    assert.equal(model.count(), before); assert.equal((await local.admission(requests[0].requestId)).cancellationRequested, true);
    assert.match((await local.admission(requests[0].requestId)).cancellationError!, /ENOENT|retained|intent/i);
    assert.equal(((await remote.inspect(requests[1].requestId)).task!.state as any).outcome.status, "aborted");
    assert.notEqual((await remote.inspect(requests[0].requestId)).task!.state.status, "terminal");
    await local.close("suspend"); store.release(); store = await openWorkerStorage(directory, identity);
    local = await DurableWorker.open({ workspace: identity, models: models().models, storage: store.storage, tools: [], env: () => undefined, cancellationOnly: true });
    assert.ok((await local.admission(requests[0].requestId)).cancellationError, "The unresolved cancellation survives reopening");
    fs.writeFileSync(intent, saved); await local.cancelSaved("test"); await local.wait(requests[0].requestId);
    assert.equal((await local.admission(requests[0].requestId)).cancellationError, undefined);
    assert.equal(((await remote.inspect(requests[0].requestId)).task!.state as any).outcome.status, "aborted");
    assert.equal(model.count(), before);
  } finally { await local.close("suspend"); store.release(); await new Promise<void>(resolve => server.close(() => resolve())); await remote.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});


for (const cancel of [false, true]) test(`stages queued behind this worker capacity ${cancel ? "cancel without stopping active work" : "wait beyond host queue timeout"}`, { timeout: 15000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-capacity-queue-"))), pool = path.join(root, "pool"), identity = { ...workspace, cwd: root };
  let release!: () => void, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const hold = defineTool({ name: "hold", description: "Hold the first stage", replay: "safe", parameters: Type.Object({}), async execute() { enter(); await gate; return { output: [{ type: "text", text: "done" }] }; } });
  const model = models(context => !context.messages.some(message => message.role === "toolResult") && JSON.stringify(context.messages).includes("Hold first") ? { type: "toolCall", id: "hold", name: "hold", arguments: {} } : "done");
  const resources = durablePool(identity, { capacity: 1, queue_timeout_ms: 100 }, pool);
  const worker = await DurableWorker.open({ workspace: identity, models: model.models, storage: new MemoryStorage(), resources, capacity: 1, tools: [hold], env: () => undefined });
  const jobs = new DurableJobs(root, "test", worker, { changed() {}, notify() {}, release() {} });
  try {
    const first: any = { ...input(), workspace: identity }; first.stage = { ...first.stage, task: "Hold first", tools: ["hold"] };
    await jobs.submit(first); await entered;
    const second = { ...input(), workspace: identity }; await jobs.submit(second);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.notEqual((await worker.inspect(second.requestId)).task!.state.status, "terminal", "A queued stage must remain durable beyond the host queue timeout");
    assert.equal(model.count(), 1, "The queued stage has not called its model");
    await jobs.refresh(); assert.equal(jobs.status(second.requestId).state, "queued");
    assert.equal((await worker.status(second.requestId)).children[0].phase, "waiting");
    let next = second;
    if (cancel) {
      await worker.abort(second.requestId);
      assert.notEqual((await worker.inspect(first.requestId)).task!.state.status, "terminal", "Cancelling the waiter cannot abort the capacity owner");
      next = { ...input(), workspace: identity }; await jobs.submit(next);
    }
    release(); await worker.wait(first.requestId); await worker.wait(next.requestId);
    assert.equal(((await worker.inspect(next.requestId)).task!.state as any).outcome.result.status, "complete");
    assert.equal(fs.readdirSync(pool).filter(name => name.startsWith("slot-")).length, 0);
  } finally { release(); await jobs.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of ["optional-only", "required", "tampered"] as const) test(`required_checks correctness ${scenario}`, { timeout: 15000 }, async () => {
  const required = scenario !== "optional-only";
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-required-criterion-")));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git(root, "init"); git(root, "config", "user.email", "fixture@example.invalid"); git(root, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n/.pi/\n"); git(root, "add", "."); git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD"), cwd = path.join(root, ".cache", "candidate"); fs.mkdirSync(path.dirname(cwd));
  git(root, "worktree", "add", "-b", "criterion", cwd, base); fs.writeFileSync(path.join(cwd, "candidate.txt"), "candidate"); git(cwd, "add", "."); git(cwd, "commit", "-m", "candidate");
  const candidate = git(cwd, "rev-parse", "HEAD"), identity = { ...workspace, cwd: root };
  const model = models(() => JSON.stringify({ status: "complete", summary: "candidate inspected", commit: candidate, evidence: ["Inspected the exact candidate"] }));
  const worker = await DurableWorker.open({ workspace: identity, models: model.models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const { stage, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  if (scenario === "tampered") worker.harness.subscribeCommits(publication => {
    for (const change of publication.changes) if (change.type === "task" && change.value.kind === "piccolo.workflow" && change.value.state.status === "terminal") {
      const outcome: any = change.value.state.outcome;
      if (outcome.result?.status === "complete") fs.writeFileSync(path.join(cwd, ".cache", "piccolo", "checks", outcome.result.checks[0], "output.log"), "tampered");
    }
  });
  try {
    await worker.submit({ ...envelope, workspace: identity, kind: "experiment", pipeline: { source: { root, base, files: {} }, maxActive: 1, failFast: false,
      nodes: { trial: { needs: [], criterion: { kind: "required_checks" }, work: { kind: "workflow", workflow: {
        root, worktree: cwd, branch: "criterion", base, candidate, task: "Inspect precommitted candidate", maxRevisions: 0,
        stages: { implement: [stage], review: [stage], qa: [stage] }, validationMode: "reported",
        checks: { smoke: { command: "exit 0", cwd: ".", boundary: "isolated", scope: "Owned fixture", timeout_ms: 1000, required },
          optional: { command: "exit 1", cwd: ".", boundary: "isolated", scope: "Owned fixture", timeout_ms: 1000, required: false } },
      } } } } } });
    const result = ((await worker.wait(envelope.requestId)).state.outcome as any).result;
    assert.equal(result.results.trial.correctness, scenario === "required" ? "pass" : "fail", JSON.stringify(result));
    assert.equal(result.results.trial.status, scenario === "required" ? "complete" : "needs_parent");
    assert.equal(result.results.trial.result.checks.length, 2, "The fixture actually ran both configured commands");
  } finally { await worker.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});


for (const boundary of ["integration-symlink", "integration-not-ignored", "delegate-alias"] as const) test(`pipeline rejects ${boundary} before worktree mutation`, { timeout: 15000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-pipeline-boundary-"))), outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-pipeline-outside-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  fs.writeFileSync(path.join(root, ".gitignore"), boundary === "integration-not-ignored" ? "/.cache/upstream/\n/.cache/dependent/\n/.pi/\n" : "/.cache/\n/.pi/\n/.worktrees/\n"); git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD"), identity = { ...workspace, cwd: root }, model = models(() => JSON.stringify({ status: "blocked", summary: "Fixture must not reach inference", commit: base, evidence: ["Fixture"] }));
  const worker = await DurableWorker.open({ workspace: identity, models: model.models, storage: new MemoryStorage(), tools: [], env: () => undefined });
  const { stage, ...envelope } = input() as Extract<WorkerSubmission, { kind: "delegate" }>;
  try {
    fs.mkdirSync(path.join(root, ".cache")); let node: any;
    if (boundary === "delegate-alias") {
      fs.symlinkSync(outside, path.join(root, ".cache", "alias"));
      node = { needs: [], work: { kind: "delegate", root, cwd: path.join(root, ".cache", "alias", "target"), branch: "delegate-alias", base, stage } };
    } else {
      const upstream = path.join(root, ".cache", "upstream"); git("worktree", "add", "-b", "predecessor", upstream, base);
      fs.writeFileSync(path.join(upstream, "upstream.txt"), "upstream");
      execFileSync("git", ["-C", upstream, "add", "."]); execFileSync("git", ["-C", upstream, "commit", "-m", "upstream"], { stdio: "ignore" });
      const dependency = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      if (boundary === "integration-symlink") { fs.symlinkSync(outside, path.join(root, ".worktrees")); }
      node = { needs: [], dependencies: [dependency], work: { kind: "workflow", workflow: { root, worktree: path.join(root, ".cache", "dependent"), branch: "dependent", base,
        task: "Fixture", maxRevisions: 0, stages: { implement: [stage], review: [stage], qa: [stage] }, checks: {}, validationMode: "reported" } } };
    }
    await worker.submit({ ...envelope, workspace: identity, kind: "experiment", pipeline: { nodes: { one: node }, maxActive: 1, failFast: false, source: { root, base, files: {} } } });
    const result = ((await worker.wait(envelope.requestId)).state.outcome as any).result;
    assert.equal(result.status, "needs_parent"); assert.equal(model.count(), 0);
    assert.deepEqual(fs.readdirSync(outside), [], "No worktree contents may be written through an alias");
    assert.equal(git("for-each-ref", "--format=%(refname)", "refs/heads/piccolo-integration", "refs/heads/delegate-alias"), "", "No integration/delegate branch is created");
    if (boundary === "integration-not-ignored") assert.equal(fs.existsSync(path.join(root, ".worktrees")), true);
  } finally { await worker.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});


test("queued stages use a freed reservation while another stage remains busy", { timeout: 15000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-capacity-first-"))), pool = path.join(root, "pool"), identity = { ...workspace, cwd: root };
  const entered = new Set<string>(), release = new Map<string, () => void>();
  const hold = defineTool({ name: "hold", description: "Hold a named stage", replay: "safe", parameters: Type.Object({ name: Type.String() }),
    async execute({ name }) { entered.add(name); await new Promise<void>(resolve => release.set(name, resolve)); return { output: [{ type: "text", text: "done" }] }; } });
  const model = models(context => {
    const name = /Hold (one|two)/.exec(JSON.stringify(context.messages))?.[1];
    return name && !context.messages.some(message => message.role === "toolResult") ? { type: "toolCall", id: "hold", name: "hold", arguments: { name } } : "done";
  });
  const worker = await DurableWorker.open({ workspace: identity, models: model.models, storage: new MemoryStorage(), capacity: 2,
    resources: durablePool(identity, { capacity: 2, queue_timeout_ms: 100 }, pool), tools: [hold], env: () => undefined });
  try {
    const requests = ["one", "two", "three"].map(name => { const r: any = { ...input(), workspace: identity }; r.stage = { ...r.stage, task: name === "three" ? "Finish" : `Hold ${name}`, tools: ["hold"] }; return r; });
    await worker.submit(requests[0]); await worker.submit(requests[1]); await eventually(async () => entered.size === 2);
    await worker.submit(requests[2]); await new Promise(resolve => setTimeout(resolve, 300));
    release.get("one")!(); await worker.wait(requests[0].requestId);
    await eventually(async () => (await worker.inspect(requests[2].requestId)).task!.state.status === "terminal", 3000);
    assert.equal(((await worker.inspect(requests[2].requestId)).task!.state as any).outcome.result.status, "complete");
    assert.notEqual((await worker.inspect(requests[1].requestId)).task!.state.status, "terminal", "The remaining busy stage does not hold up a free slot");
    release.get("two")!(); await worker.wait(requests[1].requestId);
  } finally { for (const done of release.values()) done(); await worker.close("suspend"); fs.rmSync(root, { recursive: true, force: true }); }
});


test("a persisted capacity waiter stays suspended on reopen and resumes after its reservation owner settles", { timeout: 15000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-queue-reopen-"))), directory = path.join(root, "store"), pool = path.join(root, "pool"), identity = { ...workspace, cwd: root };
  let release!: () => void, enter!: () => void, attempts = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const hold = defineTool({ name: "hold", description: "An owned safe wait", replay: "safe", parameters: Type.Object({}), async execute(_args, _api, ctx) {
    if (attempts++ === 0) { enter(); await new Promise<void>(resolve => { release = resolve; ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true }); }); }
    return { output: [{ type: "text", text: "done" }] };
  } });
  const model = models(context => JSON.stringify(context.messages).includes("Hold first") && !context.messages.some(message => message.role === "toolResult") ? { type: "toolCall", id: "hold", name: "hold", arguments: {} } : "done");
  let store = await openWorkerStorage(directory, identity);
  const options = () => ({ workspace: identity, models: model.models, storage: store.storage, capacity: 1, resources: durablePool(identity, { capacity: 1, queue_timeout_ms: 100 }, pool), tools: [hold], env: () => undefined });
  let worker = await DurableWorker.open(options());
  try {
    const first: any = { ...input(), workspace: identity }; first.stage = { ...first.stage, task: "Hold first", tools: ["hold"] };
    await worker.submit(first); await entered;
    const second = { ...input(), workspace: identity }; await worker.submit(second);
    await eventually(async () => (await worker.inspect(second.requestId)).task!.state.status === "running" && ((await worker.inspect(second.requestId)).task!.state as any).checkpoint?.phase === "queued");
    const id = (await worker.admission(second.requestId)).taskId;
    await worker.close("suspend"); store.release(); const before = model.count();
    store = await openWorkerStorage(directory, identity); worker = await DurableWorker.open({ ...options(), resume: false });
    assert.equal((await worker.admission(second.requestId)).taskId, id);
    assert.equal(((await worker.inspect(second.requestId)).task!.state as any).checkpoint.phase, "queued");
    assert.equal(model.count(), before); await assert.rejects(worker.wait(second.requestId), /suspended/);
    await worker.resumeSaved(); await worker.wait(second.requestId);
    assert.equal(((await worker.inspect(second.requestId)).task!.state as any).outcome.result.status, "complete");
  } finally { release?.(); await worker.close("suspend"); store.release(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("queued stage admissions still enforce the owner's launch guideline", { timeout: 15000 }, async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const hold = defineTool({ name: "hold", description: "Owned wait", replay: "safe", parameters: Type.Object({}), async execute() { enter(); await gate; return { output: [{ type: "text", text: "done" }] }; } });
  const model = models(context => JSON.stringify(context.messages).includes("Hold first") && !context.messages.some(message => message.role === "toolResult") ? { type: "toolCall", id: "hold", name: "hold", arguments: {} } : "done");
  const worker = await DurableWorker.open({ workspace, models: model.models, storage: new MemoryStorage(), capacity: 1, maxLaunchesPerOwner: 2, tools: [hold], env: () => undefined });
  try {
    const first: any = input(); first.stage = { ...first.stage, task: "Hold first", tools: ["hold"] }; await worker.submit(first); await entered;
    const second = input(); await worker.submit(second);
    await eventually(async () => ((await worker.inspect(second.requestId)).task!.state as any).checkpoint?.phase === "queued");
    const excess = input(); await worker.submit(excess);
    await eventually(async () => (await worker.inspect(excess.requestId)).task!.state.status === "terminal");
    const outcome: any = (await worker.inspect(excess.requestId)).task!.state;
    assert.equal(outcome.outcome.status, "faulted"); assert.match(outcome.outcome.error.message, /launch guideline|launch budget/);
    assert.equal(model.count(), 1); release(); await worker.wait(first.requestId); await worker.wait(second.requestId);
  } finally { release(); await worker.close("suspend"); }
});
