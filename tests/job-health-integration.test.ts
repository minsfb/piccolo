import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Type } from "typebox";
import { registerJobs } from "../src/job-interface.ts";
import { appendJobHealthSnapshot } from "../src/health-integration.ts";
import { registerHealth, INSPECT, type HealthInspection } from "../packages/health/index.ts";
import { resolveHealthConfig } from "../packages/health/src/config.ts";
import { WAKE_BRIDGE, type WakeRequest } from "../packages/health/src/wake.ts";

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-job-health-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const handlers = new Map<string, Function[]>(), tools = new Map<string, any>(), events = new EventEmitter();
  const notices: Array<{ message: any; options: any }> = [], wakes: WakeRequest[] = [];
  const releases: Array<() => void> = [];
  const submittedSettings: Array<{ notifications: "notify_only" | "follow_up" }> = [];
  const context: any = { cwd: root, hasUI: false, isIdle: () => true, isProjectTrusted: () => true, modelRegistry: {},
    sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined },
    [WAKE_BRIDGE]: (request: WakeRequest) => { wakes.push(request); return { id: request.id, status: "accepted" }; } };
  const pi: any = { events, on: (name: string, callback: Function) => handlers.set(name, [...(handlers.get(name) ?? []), callback]),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {}, registerCommand() {}, appendEntry() {},
    sendMessage: (message: any, options: any) => notices.push({ message, options }) };
  const schema = Type.Object({ notifications: Type.Union([Type.Literal("notify_only"), Type.Literal("follow_up")]),
    status: Type.Union([Type.Literal("completed"), Type.Literal("blocked")]) });
  const jobs = await registerJobs(pi, { delegate: schema, workflow: schema, experiment: schema, schedule: schema }, (_kind, params) => {
    const settings = { executor: "native" as const, notifications: params.notifications }; submittedSettings.push(settings);
    return { snapshot: {}, settings, execute: async () => {
      await new Promise<void>(resolve => releases.push(resolve)); return { status: params.status };
    } };
  });
  events.on(INSPECT, (request: HealthInspection) => appendJobHealthSnapshot(request, jobs.health(request.sessionId)));
  const health = registerHealth(pi, { config: () => resolveHealthConfig([{ tool_ms: 3600000 }]), directory: () => path.join(root, "health") });
  const emit = async (name: string, event: unknown = {}) => { for (const callback of handlers.get(name) ?? []) await callback(event, context); };
  await emit("session_start");
  return { jobs, health, notices, wakes, submittedSettings,
    submit: async (notifications: "notify_only" | "follow_up", status = "completed") => {
      const result = await tools.get("piccolo_submit").execute("submit", { kind: "delegate", arguments: { notifications, status } }, undefined, undefined, context);
      return result.details.id as string;
    },
    finish: async (ids: string[]) => {
      releases.splice(0).forEach(release => release());
      for (const id of ids) await tools.get("piccolo_jobs").execute("wait", { action: "wait", id, wait_ms: 3000 }, undefined, undefined, context);
      await new Promise(resolve => setTimeout(resolve, 160)); // Native SessionJobs coalesces notices at 100ms.
    },
    resolve: (id: string) => tools.get("harness_health").execute("resolve", { action: "disposition", id,
      disposition: "resolved", reason: "verified_recovery" }, undefined, undefined, context),
    clean: async () => {
      releases.splice(0).forEach(release => release()); await emit("session_shutdown", { reason: "quit" });
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    } };
}

for (const status of ["completed", "blocked"]) {
  test(`notify_only ${status} job stays passive with an active health attention owner`, async () => {
    const f = await fixture();
    try {
      const id = await f.submit("notify_only", status);
      f.submittedSettings[0].notifications = "follow_up"; // Submission capture must win.
      await f.health.tick();
      assert.equal(f.jobs.health("parent")[0].notifications, "notify_only");
      await f.finish([id]); await f.health.tick(); await f.health.tick();
      assert.equal(f.notices.length, 1); assert.ok(f.notices[0].message.content.includes(id));
      assert.deepEqual(f.notices[0].options, { triggerTurn: false, deliverAs: "nextTurn" });
      assert.equal(f.wakes.length, 0); assert.equal(f.health.facts().incidents.length, 0);
    } finally { await f.clean(); }
  });
}

test("mixed notification modes keep one passive notice and one health-owned follow-up path", async () => {
  const f = await fixture();
  try {
    const passive = await f.submit("notify_only"), automatic = await f.submit("follow_up");
    f.submittedSettings[1].notifications = "notify_only";
    await f.health.tick(); await f.finish([passive, automatic]); await f.health.tick();
    assert.equal(f.jobs.health("parent").find(j => j.id === automatic)?.notifications, "follow_up");
    assert.equal(f.notices.length, 1, "health suppresses only the follow_up portion of the coalesced batch");
    assert.ok(f.notices[0].message.content.includes(passive)); assert.equal(f.notices[0].message.content.includes(automatic), false);
    assert.equal(f.notices[0].options.triggerTurn, false);
    assert.equal(f.wakes.length, 1); assert.ok(f.wakes[0].content.includes(automatic));
    const [incident] = f.health.facts().incidents; assert.equal(incident.reference?.id, automatic);
    await f.resolve(incident.id); await f.health.tick(); await f.health.tick();
    assert.equal(f.wakes.length, 1); assert.equal(f.notices.length, 1, "completed snapshots do not duplicate either delivery");
  } finally { await f.clean(); }
});

test("notify_only excludes ordinary terminal attention but retains explicit health deadline policy", () => {
  const active: HealthInspection = { sessionId: "parent", phase: "active", resolved: { tool_ms: 1000 } };
  appendJobHealthSnapshot(active, [
    { id: "running", state: "running", updatedAt: 1000, notifications: "notify_only" },
    { id: "ended", state: "needs_parent", updatedAt: 1000, notifications: "notify_only" },
  ]);
  assert.deepEqual(active.observations, []);
  assert.equal(active.expectations?.length, 1); assert.equal(active.expectations?.[0].deadline, 2000);
});
