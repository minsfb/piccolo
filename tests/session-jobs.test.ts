import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionJobs, type JobExecution } from "../src/session-jobs.ts";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-jobs-"));

test("interrupted native delegate remains unresolved even after explicit stop", async () => {
  const root = fixture(), jobs = new SessionJobs(root, "parent");
  try {
    const id = jobs.submit("delegate", {}, async ({ signal }) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "interrupted" };
    });
    await delay(0); jobs.stop(id); await jobs.wait(id);
    assert.equal(jobs.result(id).state, "unresolved");
  } finally { await jobs.close("quit"); fs.rmSync(root, { recursive: true }); }
});

test("submission returns before work finishes, snapshots inputs and coalesces terminal notices", async () => {
  const root = fixture(); const notices: string[][] = [];
  const jobs = new SessionJobs(root, "parent", { notify: ids => notices.push(ids) });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const input = { model: "original", effort: "medium" };
  const first = jobs.submit("delegate", input, async () => { await pending; return { status: "completed" }; });
  input.model = "changed";
  assert.equal(jobs.status(first).state, "queued");
  await delay(0); assert.equal(jobs.status(first).state, "running");
  const second = jobs.submit("workflow", {}, async () => ({ status: "needs_parent" }));
  const launch = JSON.parse(fs.readFileSync(path.join(root, `.piccolo/jobs/${first}/launch.json`), "utf8"));
  assert.equal(launch.inputs.model, "original");
  finish(); await jobs.wait(first); await jobs.wait(second); await delay(150);
  assert.equal(jobs.status(first).state, "completed"); assert.equal(jobs.status(second).state, "needs_parent");
  assert.equal(notices.length, 1); assert.deepEqual(new Set(notices[0]), new Set([first, second]));
  await jobs.close("quit"); fs.rmSync(root, { recursive: true });
});

test("selected stop is isolated; owning-session close cancels remaining work without wakeup", async () => {
  const root = fixture(); let notifications = 0;
  const jobs = new SessionJobs(root, "parent", { notify: () => notifications++ });
  const execute = async ({ signal }: JobExecution) => { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return { status: "cancelled" }; };
  const first = jobs.submit("delegate", {}, execute); const second = jobs.submit("schedule", {}, execute);
  await delay(0); jobs.stop(first); assert.equal(jobs.status(first).stopping, true); await jobs.wait(first);
  assert.equal(jobs.status(first).stopping, false);
  assert.equal(jobs.status(first).state, "cancelled"); assert.equal(jobs.status(second).state, "running");
  await jobs.close("resume"); await delay(150);
  assert.equal(jobs.status(second).state, "cancelled"); assert.equal(notifications, 0);
  assert.throws(() => jobs.submit("delegate", {}, execute), /closed/);
  fs.rmSync(root, { recursive: true });
});

test("instructions wait for one coordinator and record immutable routing and delivery events", async () => {
  const root = fixture(); const jobs = new SessionJobs(root, "parent");
  let execution!: JobExecution; let finish!: () => void;
  const id = jobs.submit("workflow", {}, async job => { execution = job; await new Promise<void>(resolve => { finish = resolve; }); return { status: "complete" }; });
  await delay(0);
  const instruction = jobs.message(id, "revise the implementation"); assert.equal(instruction.state, "queued");
  const reviewer = execution.child("review/reviewer", ["read"], false);
  assert.equal(reviewer.pending.length, 0);
  const implementer = execution.child("implement/worker", ["read", "bash"], true);
  assert.equal(implementer.pending.length, 1); assert.equal(reviewer.pending.length, 0);
  const message = implementer.pending[0]; message.state = "delivered";
  implementer.update({ kind: "message_delivered", message });
  const home = path.join(root, `.piccolo/jobs/${id}`);
  const events = fs.readdirSync(home).filter(name => /^\d+\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(home, name), "utf8")));
  assert.equal(events.find(event => event.kind === "message_queued").message.state, "queued");
  assert.equal(events.find(event => event.kind === "message_delivered").message.state, "delivered");
  finish(); await jobs.wait(id); assert.throws(() => jobs.message(id, "restart"), /Ended/);
  await jobs.close("quit"); fs.rmSync(root, { recursive: true });
});

test("unacknowledged shutdown remains unresolved; a fresh runtime cannot adopt or stop it", async () => {
  const root = fixture(); const jobs = new SessionJobs(root, "parent", { shutdownMs: 10 });
  const id = jobs.submit("delegate", {}, () => new Promise(() => {}));
  await delay(0); await jobs.close("quit"); assert.equal(jobs.status(id).state, "unresolved");
  assert.equal(jobs.status(id).stopping, false, "unknown outcome must say unresolved, not imply cancellation is progressing");
  const replacement = new SessionJobs(root, "parent");
  assert.throws(() => replacement.stop(id), /not owned/);
  assert.equal(fs.existsSync(path.join(root, `.piccolo/jobs/${id}/outcome.json`)), false);
  await replacement.close("quit"); fs.rmSync(root, { recursive: true });
});

test("job records reject a symlinked execution directory", () => {
  const root = fixture(); const outside = fixture();
  fs.symlinkSync(outside, path.join(root, ".piccolo"));
  assert.throws(() => new SessionJobs(root, "parent").submit("delegate", {}, async () => ({})), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.rmSync(root, { recursive: true }); fs.rmSync(outside, { recursive: true });
});

test("storage failure cannot prevent stop or cancellation of every job on session close", async () => {
  const root = fixture(); const jobs = new SessionJobs(root, "parent", { shutdownMs: 20 });
  const signals: AbortSignal[] = [];
  const execute = async ({ signal }: JobExecution) => { signals.push(signal); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return { status: "completed" }; };
  const first = jobs.submit("delegate", {}, execute); const second = jobs.submit("delegate", {}, execute); const third = jobs.submit("delegate", {}, execute);
  await delay(0);
  const link = fs.linkSync;
  fs.linkSync = (() => { throw Object.assign(new Error("injected record failure"), { code: "EIO" }); }) as typeof fs.linkSync;
  try {
    jobs.stop(first); assert.equal(signals[0].aborted, true);
    await jobs.close("reload"); assert.ok(signals.every(signal => signal.aborted));
    for (const id of [first, second, third]) assert.equal(jobs.status(id).state, "unresolved");
  } finally { fs.linkSync = link; }
  await jobs.close("retry"); fs.rmSync(root, { recursive: true });
});

test("notification receipt storage failure does not escape the host timer", async () => {
  const root = fixture(); const jobs = new SessionJobs(root, "parent");
  const id = jobs.submit("delegate", {}, async () => ({ status: "completed" })); await jobs.wait(id);
  const link = fs.linkSync;
  fs.linkSync = (() => { throw Object.assign(new Error("injected notification failure"), { code: "EIO" }); }) as typeof fs.linkSync;
  try { await delay(150); assert.match(jobs.status(id).error ?? "", /failure/); }
  finally { fs.linkSync = link; await jobs.close("quit"); fs.rmSync(root, { recursive: true }); }
});

test("an idle schedule with blocked or waiting tasks needs its parent", async () => {
  const root = fixture(); const jobs = new SessionJobs(root, "parent");
  const blocked = jobs.submit("schedule", {}, async () => ({ status: "idle", readiness: { task_status_counts: { blocked: 2, planned: 1 } } }));
  const complete = jobs.submit("schedule", {}, async () => ({ status: "idle", readiness: { task_status_counts: { complete: 3 } } }));
  await jobs.wait(blocked); await jobs.wait(complete);
  assert.equal(jobs.status(blocked).state, "needs_parent"); assert.equal(jobs.status(complete).state, "completed");
  await jobs.close("quit"); fs.rmSync(root, { recursive: true });
});

test("terminal parent decisions require inspected exact results and retain superseded attempts", async () => {
  const root = fixture(); const notices: string[][] = [];
  const jobs = new SessionJobs(root, "parent", { notify: ids => notices.push(ids) });
  try {
    const first = jobs.submit("workflow", {}, async () => ({ status: "blocked", summary: "bad path" }));
    assert.throws(() => jobs.acknowledge(first, "", "too early"), /Inspect/);
    await jobs.wait(first); // explicit result read
    const initial = jobs.result(first); const revision = initial.outcome_revision!;
    assert.equal(initial.parent_review.disposition, "pending");
    const outcome = fs.readFileSync(path.join(root, initial.record, "outcome.json"));
    assert.throws(() => jobs.acknowledge(first, "wrong", "checked"), /Inspect/);
    assert.throws(() => jobs.acknowledge(first, revision, "checked", first), /later/);
    const second = jobs.submit("workflow", {}, async () => ({ status: "complete" }));
    const decision = jobs.acknowledge(first, revision, "Corrected path; bounded replacement", second);
    assert.equal(decision.state, "needs_parent");
    assert.equal(decision.parent_review.disposition, "superseded");
    assert.deepEqual(fs.readFileSync(path.join(root, initial.record, "outcome.json")), outcome);
    assert.deepEqual(jobs.acknowledge(first, revision, "Corrected path; bounded replacement", second), decision);
    assert.throws(() => jobs.acknowledge(first, revision, "overwrite decision"), /already/);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(notices, [[second]], "handled failure is omitted from pending notice batch");
    assert.equal(jobs.status(second).parent_review.disposition, "pending");
    assert.throws(() => jobs.acknowledge(second, jobs.status(second).outcome_revision!, "not inspected"), /Inspect/);
    const complete = jobs.result(second);
    jobs.acknowledge(second, complete.outcome_revision!, "Verified candidate and QA evidence");
    const files = fs.readdirSync(path.join(root, initial.record)).filter(f => /^\d/.test(f));
    assert.ok(files.some(f => JSON.parse(fs.readFileSync(path.join(root, initial.record, f), "utf8")).kind === "parent_decision"));
  } finally { await jobs.close("quit"); fs.rmSync(root, { recursive: true }); }
});

test("synchronous worker message acceptance is retained and does not imply action", async () => {
  const root = fixture(); const jobs = new SessionJobs(root, "parent");
  let execution!: JobExecution, finish!: () => void;
  try {
    const id = jobs.submit("delegate", {}, async job => { execution = job; await new Promise<void>(resolve => { finish = resolve; }); return { status: "completed" }; });
    await delay(0);
    const child = execution.child("delegate", ["read"], true);
    child.send = message => { message.state = "delivered"; child.update({ kind: "message_delivered", message }); };
    assert.equal(jobs.message(id, "instruction").state, "delivered");
    assert.equal(jobs.status(id).messages[0].observation, "native_message_start; action_not_verified");
    finish(); await jobs.wait(id);
  } finally { await jobs.close("quit"); fs.rmSync(root, { recursive: true }); }
});


test("result exposes full error rather than qualifying a status preview", async () => {
  const root = fixture(), jobs = new SessionJobs(root, "parent");
  try {
    const id = jobs.submit("delegate", {}, async () => { throw new Error("x".repeat(3200) + "CRITICAL-TAIL"); });
    const value = await jobs.wait(id);
    assert.equal(jobs.status(id).error_truncated, true);
    assert.equal(value.error_truncated, false); assert.match(value.error!, /CRITICAL-TAIL$/);
    assert.equal(jobs.acknowledge(id, value.outcome_revision!, "Read full failure including critical tail").parent_review.disposition, "acknowledged");
    const large = jobs.submit("delegate", {}, async () => { throw new Error("x".repeat(20000)); });
    const huge = await jobs.wait(large);
    assert.throws(() => jobs.acknowledge(large, huge.outcome_revision!, "only pointer will be returned"), /Inspect/);
  } finally { await jobs.close("quit"); fs.rmSync(root, { recursive: true }); }
});
