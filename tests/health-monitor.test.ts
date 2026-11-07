import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HealthMonitor, type HealthMonitorOptions } from "../packages/health/src/monitor.ts";

function fixture(options: Partial<HealthMonitorOptions> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-health-"));
  let now = 1000;
  const monitor = new HealthMonitor({ directory, session: "session-one", now: () => now,
    baseRetryMs: 10, maxRetryMs: 100, acknowledgementMs: 20, ...options });
  return { directory, monitor, advance: (ms: number) => { now += ms; }, now: () => now,
    clean: () => { monitor.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
const failure = { source: "job-one", component: "worker", code: "missing_receipt" } as const;

test("busy admission retains a bounded pending action without spending actual wake budgets", () => {
  const f = fixture({ maxAttempts: 1, maxActionsPerRuntime: 1 });
  try {
    f.monitor.observe(failure);
    let id = "";
    for (let n = 0; n < 60; n++) {
      const [action] = f.monitor.tick();
      assert.ok(action); if (!id) id = action.id;
      assert.equal(action.id, id); assert.equal(action.attempt, 1);
      f.monitor.recordAction(id, "busy"); f.monitor.recordAction(id, "busy");
      assert.equal(f.monitor.list()[0].actions[0].busy?.count, n + 1);
      if (n === 0) assert.equal(f.monitor.list()[0].nextCheck, 1010, "non-admission waits retry backoff, not acknowledgment deadline");
      assert.deepEqual(f.monitor.tick(), [], "busy responses have a cooldown");
      f.advance(100);
    }
    const incident = f.monitor.list()[0];
    assert.equal(incident.disposition, "open"); assert.equal(incident.actions.length, 1);
    assert.equal(incident.actions[0].pending, true);
    assert.equal(incident.actions[0].busy?.observations.length, 32);
    assert.equal(incident.actions[0].busy?.firstAt, 1000);
    const [admitted] = f.monitor.tick(); assert.equal(admitted.id, id);
    f.monitor.recordAction(id, "delivered");
    assert.equal(f.monitor.list()[0].actions[0].busy?.count, 60, "successful admission retains contention history");
    assert.throws(() => f.monitor.recordAction(id, "busy"), /Conflicting/);
    assert.throws(() => f.monitor.recordAction(id, "failed"), /Conflicting/);
    f.monitor.observe({ ...failure, source: "another-incident" });
    assert.deepEqual(f.monitor.tick(), [], "actual delivered wake exhausts runtime budget");
    assert.equal(f.monitor.list()[1].reason, "retry_exhausted");
    f.monitor.close();
    const newer = new HealthMonitor({ directory: f.directory, session: "next" });
    assert.equal(newer.list({ includeHistory: true })[0].actions[0].busy?.count, 60);
    assert.deepEqual(newer.tick(), []); newer.close();
  } finally { f.clean(); }
});

test("busy reservations do not prematurely exhaust other obligations in the same batch", () => {
  const f = fixture({ maxAttempts: 1, maxActionsPerRuntime: 1, maxActionsPerTick: 3 });
  try {
    f.monitor.observe(failure); f.monitor.observe({ ...failure, source: "second" });
    const [first] = f.monitor.tick();
    assert.equal(f.monitor.list()[1].disposition, "open");
    f.monitor.recordAction(first.id, "busy");
    const [second] = f.monitor.tick();
    assert.notEqual(first.incidentId, second.incidentId);
    f.monitor.recordAction(second.id, "busy");
    f.advance(100);
    const reclaimed = f.monitor.tick();
    assert.equal(reclaimed.length, 1, "reclaimed busy action reserves the only global slot");
    assert.equal(reclaimed[0].id, first.id);
    f.monitor.recordAction(first.id, "failed");
    assert.deepEqual(f.monitor.tick(), []);
    assert.equal(f.monitor.list()[1].reason, "retry_exhausted", "pending busy action cannot evade actual failed-wake ceiling");
  } finally { f.clean(); }
});

test("failed persistence of a busy receipt does not refund the durable wake reservation", () => {
  const f = fixture({ maxAttempts: 1, maxActionsPerRuntime: 1 });
  try {
    f.monitor.observe(failure); const [action] = f.monitor.tick();
    const file = path.join(f.directory, `${f.monitor.runtime}.json`);
    const durable = fs.readFileSync(file, "utf8");
    fs.unlinkSync(file); fs.mkdirSync(file);
    assert.throws(() => f.monitor.recordAction(action.id, "busy"));
    assert.equal(f.monitor.list()[0].actions[0].pending, undefined);
    assert.equal(f.monitor.list()[0].actions[0].busy, undefined);
    fs.rmdirSync(file); fs.writeFileSync(file, durable, { mode: 0o600 });
    f.advance(100); assert.deepEqual(f.monitor.tick(), []);
    assert.equal(f.monitor.list()[0].reason, "retry_exhausted", "unknown claim outcome conservatively spends the budget");
  } finally { f.clean(); }
});

test("observation-only reconciliation materializes failures without spending wake attempts", () => {
  const f = fixture({ maxAttempts: 1 });
  try {
    f.monitor.expect({ ...failure, deadline: 1000 });
    for (let i = 0; i < 10; i++) { f.advance(1000); assert.deepEqual(f.monitor.tick({ dispatch: false }), []); }
    assert.equal(f.monitor.list()[0].disposition, "open");
    assert.equal(f.monitor.list()[0].actions.length, 0);
    assert.equal(f.monitor.tick()[0].attempt, 1);
  } finally { f.clean(); }
});

test("missed callbacks become durable attention and delivery never implies handling", () => {
  const f = fixture();
  try {
    f.monitor.expect({ ...failure, deadline: 1020 });
    assert.deepEqual(f.monitor.tick(), []);
    f.advance(20);
    const [action] = f.monitor.tick();
    assert.equal(action.kind, "request_parent_attention");
    const stored = JSON.parse(fs.readFileSync(path.join(f.directory, `${f.monitor.runtime}.json`), "utf8"));
    assert.equal(stored.incidents[0].actions[0].id, action.id);
    f.monitor.recordAction(action.id, "delivered");
    assert.equal(f.monitor.list()[0].disposition, "open");
    assert.deepEqual(f.monitor.tick(), []);
    f.advance(20);
    assert.equal(f.monitor.tick()[0].attempt, 2);
    f.monitor.disposition(action.incidentId, "handling", { reason: "parent_inspecting", until: 1100 });
    f.advance(50);
    assert.deepEqual(f.monitor.tick(), []);
    f.monitor.disposition(action.incidentId, "resolved", { reason: "verified_recovery" });
    f.advance(100);
    assert.deepEqual(f.monitor.tick(), []);
  } finally { f.clean(); }
});

test("repeated snapshots cannot postpone deadlines; completed expectations are not failures", () => {
  const f = fixture();
  try {
    f.monitor.expect({ ...failure, deadline: 1010 });
    f.monitor.expect({ ...failure, deadline: 9000 });
    f.monitor.expect({ ...failure, source: "finished", deadline: 1005 });
    f.monitor.complete("finished"); f.advance(10);
    assert.equal(f.monitor.tick().length, 1);
    assert.equal(f.monitor.list().length, 1);
    f.monitor.complete("job-one");
    assert.equal(f.monitor.list()[0].disposition, "open");
  } finally { f.clean(); }
});

test("rate limit, auth, compaction and monitor faults are categorical and bounded", () => {
  const f = fixture({ maxAttempts: 2 });
  try {
    const secret = "Bearer SUPER-PRIVATE-ENDPOINT-TOKEN";
    const first = f.monitor.observe({ source: secret, component: "endpoint", code: "rate_limit", message: secret } as any);
    for (let n = 0; n < 100; n++) f.monitor.observe({ source: secret, component: "endpoint", code: "rate_limit" });
    assert.equal(f.monitor.list()[0].count, 101);
    assert.equal(f.monitor.list()[0].occurrences.length, 32);
    const [a] = f.monitor.tick(); f.monitor.recordAction(a.id, "failed");
    f.advance(20); const [b] = f.monitor.tick(); f.monitor.recordAction(b.id, "delivered");
    f.advance(20); assert.deepEqual(f.monitor.tick(), []);
    assert.equal(f.monitor.list()[0].reason, "retry_exhausted");
    for (const [component, code] of [["endpoint", "authentication"], ["compaction", "compaction_failed"], ["monitor", "diagnosis_failed"]] as const)
      f.monitor.observe({ source: code, component, code });
    assert.equal(f.monitor.tick().length, 1, "at most one recovery request per tick");
    const raw = fs.readFileSync(path.join(f.directory, `${f.monitor.runtime}.json`), "utf8");
    assert.equal(raw.includes(secret), false); assert.equal(raw.includes("message"), false);
    assert.equal(first.source.length, 64);
    assert.throws(() => f.monitor.observe({ ...failure, code: secret } as any), /categorical/);
  } finally { f.clean(); }
});

test("defer has explicit recheck, unsupported recovery escalates, receipts cannot conflict", () => {
  const f = fixture();
  try {
    const i = f.monitor.observe(failure);
    assert.throws(() => f.monitor.disposition(i.id, "handling", { reason: "parent_inspecting" }), /recheck/);
    assert.throws(() => f.monitor.disposition(i.id, "deferred", { reason: "retry_later", until: 1000 }), /recheck/);
    f.monitor.disposition(i.id, "deferred", { reason: "retry_later", until: 1030 });
    assert.deepEqual(f.monitor.tick(), []); f.advance(30);
    const [action] = f.monitor.tick();
    f.monitor.recordAction(action.id, "unsupported");
    f.monitor.recordAction(action.id, "unsupported");
    assert.throws(() => f.monitor.recordAction(action.id, "delivered"), /Conflicting/);
    assert.equal(f.monitor.list()[0].reason, "unsupported_recovery");
    f.advance(1000); assert.deepEqual(f.monitor.tick(), []);
    assert.throws(() => f.monitor.recordAction("not-owned", "delivered"), /Unknown/);
  } finally { f.clean(); }
});

test("recreation retains historical incidents without adopting prior session obligations", () => {
  const f = fixture();
  try {
    const old = f.monitor.observe(failure);
    f.monitor.expect({ source: "old-compaction", component: "compaction", code: "compaction_overdue", deadline: 1000 });
    f.monitor.tick(); f.monitor.close();
    const newer = new HealthMonitor({ directory: f.directory, session: "session-one", now: f.now });
    assert.deepEqual(newer.tick(), []);
    assert.deepEqual(newer.list(), []);
    assert.equal(newer.list({ includeHistory: true }).length, 2);
    assert.throws(() => newer.disposition(old.id, "resolved", { reason: "verified_recovery" }), /current-runtime/);
    const current = newer.observe(failure);
    assert.notEqual(current.id, old.id);
    const leaked = newer.list(); leaked[0].count = 999;
    assert.equal(newer.list()[0].count, 1);
    newer.close(); assert.throws(() => newer.tick(), /closed/);
  } finally { f.clean(); }
});

test("recurrence reopens resolved incidents without resetting the retry budget", () => {
  const f = fixture({ maxAttempts: 1 });
  try {
    const i = f.monitor.observe(failure);
    const [a] = f.monitor.tick(); f.monitor.recordAction(a.id, "delivered");
    f.monitor.disposition(i.id, "resolved", { reason: "verified_recovery" });
    f.advance(100); f.monitor.observe(failure);
    assert.equal(f.monitor.list()[0].count, 2);
    assert.deepEqual(f.monitor.tick(), []);
    assert.equal(f.monitor.list()[0].disposition, "development");
  } finally { f.clean(); }
});

test("persistence failures fail closed; full ledgers do not silently discard incidents", () => {
  const f = fixture({ maxIncidents: 1 });
  try {
    f.monitor.observe(failure);
    assert.throws(() => f.monitor.observe({ ...failure, source: "another" }), /limit/);
    assert.equal(f.monitor.list().length, 1);
    const file = path.join(f.directory, `${f.monitor.runtime}.json`);
    fs.unlinkSync(file); fs.mkdirSync(file);
    assert.throws(() => f.monitor.tick());
    assert.equal(f.monitor.list()[0].actions.length, 0, "failed durable claim is not retained in memory");
    assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith(".tmp")), false);
  } finally { f.clean(); }
});

test("private atomic records reject symlinks, unsafe modes, malformed schemas and reused identities", () => {
  const f = fixture();
  try {
    const file = path.join(f.directory, `${f.monitor.runtime}.json`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => new HealthMonitor({ directory: f.directory, session: "other", runtime: f.monitor.runtime }), /already exists/);
    fs.chmodSync(file, 0o644);
    assert.throws(() => new HealthMonitor({ directory: f.directory, session: "other" }), /Unsafe/);
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, '{"format":1,"incidents":[]}');
    assert.throws(() => new HealthMonitor({ directory: f.directory, session: "other" }), /Invalid/);
    fs.unlinkSync(file); fs.symlinkSync("/dev/null", file);
    assert.throws(() => new HealthMonitor({ directory: f.directory, session: "other" }));
  } finally { f.clean(); }
});

test("runtime action ceiling bounds chains with fresh incident identities", () => {
  const f = fixture({ maxActionsPerRuntime: 2 });
  try {
    for (let n = 0; n < 5; n++) {
      const incident = f.monitor.observe({ source: `failure-${n}`, component: "worker", code: "worker_failed" });
      const actions = f.monitor.tick();
      assert.equal(actions.length, n < 2 ? 1 : 0);
      if (actions.length) f.monitor.disposition(incident.id, "resolved", { reason: "verified_recovery" });
    }
    assert.equal(f.monitor.list().reduce((n, i) => n + i.actions.length, 0), 2);
    assert.equal(f.monitor.list().at(-1)?.disposition, "development");
  } finally { f.clean(); }
});

test("invalid optional disposition timestamps cannot poison retained history", () => {
  const f = fixture();
  try {
    const incident = f.monitor.observe(failure);
    for (const until of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
      assert.throws(() => f.monitor.disposition(incident.id, "resolved", { reason: "verified_recovery", until }), /timestamp/);
    assert.equal(f.monitor.list()[0].disposition, "open");
    f.monitor.close();
    const next = new HealthMonitor({ directory: f.directory, session: "new-session", now: f.now });
    assert.equal(next.list({ includeHistory: true }).length, 1); next.close();
  } finally { f.clean(); }
});
