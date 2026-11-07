import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { appendJobHealthSnapshot } from "../src/health-integration.ts";
import { registerHealth, INSPECT, type HealthInspection } from "../packages/health/index.ts";

const job = { id: "12345678-1234-1234-1234-123456789abc", state: "running", updatedAt: 100000 };

test("Piccolo produces deadlines only for resolved active inspections and preserves other contributions", () => {
  const configuration: HealthInspection = { sessionId: "session", phase: "configuration", config: { tool_ms: 1234 } };
  appendJobHealthSnapshot(configuration, [job]);
  assert.equal(configuration.expectations, undefined); assert.equal(configuration.observations, undefined);
  assert.throws(() => appendJobHealthSnapshot({ phase: "active" }, [job]), /resolved tool deadline/);
  const observation = { source: "other-package", component: "endpoint", code: "transport" } as const;
  const expectation = { source: "other-timer", component: "compaction", code: "compaction_overdue", deadline: 123456 } as const;
  const active: HealthInspection = { sessionId: "session", phase: "active", config: { tool_ms: 900000 },
    resolved: { tool_ms: 1000 }, observations: [observation], expectations: [expectation] };
  appendJobHealthSnapshot(active, [job, { ...job, id: "23456789-1234-1234-1234-123456789abc", state: "completed" }]);
  assert.deepEqual(active.observations?.[0], observation); assert.deepEqual(active.expectations?.[0], expectation);
  assert.equal(active.expectations?.[1].deadline, job.updatedAt + 1000);
  assert.equal(active.observations?.[1].code, "unacknowledged");
});

for (const scenario of [
  { name: "user short deadline", user: 1000, project: undefined, trusted: true, override: {}, expected: 1000 },
  { name: "trusted project long deadline", user: 1000, project: 3600000, trusted: true, override: {}, expected: 3600000 },
  { name: "untrusted project is ignored", user: 1000, project: 3600000, trusted: false, override: {}, expected: 1000 },
  { name: "Piccolo override wins", user: 1000, project: 3600000, trusted: true, override: { tool_ms: 2000 }, expected: 2000 },
]) {
  test(`job progress uses fully resolved health policy: ${scenario.name}`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-health-policy-"));
    const previous = process.env.XDG_CONFIG_HOME;
    const configHome = path.join(directory, "config"), project = path.join(directory, "project");
    fs.mkdirSync(path.join(configHome, "pi-harness-health"), { recursive: true });
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(configHome, "pi-harness-health/config.toml"), `tool_ms = ${scenario.user}\nrecovery = "observe"\n`);
    if (scenario.project) fs.writeFileSync(path.join(project, ".pi/health.toml"), `tool_ms = ${scenario.project}\n`);
    process.env.XDG_CONFIG_HOME = configHome;
    let session = "first", clock = job.updatedAt;
    const handlers = new Map<string, any>(), events = new EventEmitter(), snapshots: HealthInspection[] = [];
    const context: any = { cwd: project, hasUI: false, isIdle: () => true, isProjectTrusted: () => scenario.trusted,
      modelRegistry: {}, sessionManager: { getSessionId: () => session } };
    const pi: any = { events, on: (name: string, handler: any) => handlers.set(name, handler),
      registerTool() {}, registerMessageRenderer() {}, registerCommand() {}, appendEntry() {} };
    events.on(INSPECT, (request: HealthInspection) => {
      request.config = scenario.override;
      appendJobHealthSnapshot(request, request.sessionId === "first" ? [job] : []);
      snapshots.push(structuredClone(request));
    });
    const health = registerHealth(pi, { directory: () => path.join(directory, "state"), now: () => clock });
    try {
      handlers.get("session_start")({}, context);
      assert.equal(snapshots[0].phase, "configuration");
      assert.equal(snapshots[0].resolved, undefined); assert.equal(snapshots[0].expectations, undefined);
      await health.tick();
      const snapshot = snapshots.at(-1)!;
      assert.equal(snapshot.phase, "active"); assert.equal(snapshot.resolved?.tool_ms, scenario.expected);
      assert.equal(snapshot.expectations?.[0].deadline, job.updatedAt + scenario.expected);
      assert.equal(health.facts().incidents.filter(i => i.code === "deadline_expired").length, 0);
      clock = job.updatedAt + scenario.expected;
      await health.tick();
      assert.equal(health.facts().incidents.filter(i => i.code === "deadline_expired").length, 1);
      // A replacement session discovers policy afresh, without exporting the
      // previous monitor's resolved value during configuration discovery.
      fs.writeFileSync(path.join(configHome, "pi-harness-health/config.toml"), 'tool_ms = 6000\nrecovery = "observe"\n');
      fs.writeFileSync(path.join(project, ".pi/health.toml"), 'tool_ms = 7000\n');
      session = "replacement";
      handlers.get("session_start")({}, context);
      assert.equal(snapshots.at(-1)?.phase, "configuration");
      assert.equal(snapshots.at(-1)?.resolved, undefined);
      assert.equal(snapshots.at(-1)?.expectations, undefined);
      assert.equal(health.facts().incidents.length, 0);
      await health.tick();
      assert.equal(snapshots.at(-1)?.resolved?.tool_ms,
        (scenario.override as { tool_ms?: number }).tool_ms ?? (scenario.trusted ? 7000 : 6000));
      assert.deepEqual(snapshots.at(-1)?.expectations, [], "old session jobs are not adopted");
    } finally {
      health.close();
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("handled outcomes stop contributing new attention observations", () => {
  const request: HealthInspection = { sessionId: "s", phase: "active", resolved: { tool_ms: 1000 } };
  appendJobHealthSnapshot(request, [{ ...job, state: "completed", acknowledged: true }, { ...job, id: "pending", state: "completed" }]);
  assert.equal(request.observations?.length, 1);
  assert.equal(request.observations?.[0].reference?.id, "pending");
});
