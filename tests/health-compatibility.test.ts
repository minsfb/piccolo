import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { registerHealth, INSPECT, CLAIM } from "../packages/health/index.ts";
import { resolveHealthConfig } from "../packages/health/src/config.ts";
import { hasParentWake, registerManagedWake, WAKE_BRIDGE } from "../packages/health/src/wake.ts";

test("current-session opt-out and version mismatch cannot reuse a process adapter", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "health-compatibility-"));
  const events = new EventEmitter(), handlers = new Map<string, any>();
  const pi: any = { events, on: (name: string, fn: any) => handlers.set(name, fn), registerTool() {}, registerMessageRenderer() {}, registerCommand() {}, appendEntry() {} };
  let clock = 100000, calls = 0, bridgeCalls = 0;
  let layer: any = { compatibility: "off" };
  let failConfig = false;
  const health = registerHealth(pi, {
    config: () => { if (failConfig) throw new Error("fixture config failure"); return resolveHealthConfig([{ interval_ms: 1000, attention_ms: 1000, ...layer }]); },
    directory: () => directory, now: () => clock,
  });
  const context: any = { cwd: directory, hasUI: false, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "fixture-session" }, modelRegistry: {} };
  events.on(INSPECT, request => { request.observations = [{ source: "attention", component: "attention", code: "unacknowledged" }]; });
  const claim = () => { const request = { sessionId: "fixture-session", claimed: false }; events.emit(CLAIM, request); return request.claimed; };
  const installed = { status: "installed", supports: () => true, request: (_context: unknown, request: any) => { calls++; return { id: request.id, status: "accepted" as const }; } };
  try {
    // A process adapter may have been installed by an earlier opted-in session.
    registerManagedWake(installed);
    for (const compatibility of ["off", VERSION === "0.86.1" ? "managed-0.85.1" : "managed-0.86.1"]) {
      layer = { compatibility };
      handlers.get("session_start")({}, context);
      assert.equal(hasParentWake(context), true, "process adapter still exists");
      assert.equal(health.facts().wake_capability, false);
      assert.equal(health.facts().wake_unavailable_reason, compatibility === "off" ? "managed_compatibility_disabled" : "runtime_version_mismatch");
      assert.equal(claim(), false);
      await health.tick(); clock += 2000; await health.tick();
      assert.equal(calls, 0, "no inference through a disallowed managed adapter");
    }
    // Explicit host capabilities are independent of the managed compatibility option.
    context[WAKE_BRIDGE] = (request: any) => { bridgeCalls++; return { id: request.id, status: "accepted" }; };
    layer = { compatibility: "off" }; handlers.get("session_start")({}, context);
    assert.equal(health.facts().wake_capability, true); assert.equal(claim(), true);
    await health.tick(); assert.equal(bridgeCalls, 1); assert.equal(calls, 0);
    delete context[WAKE_BRIDGE];

    layer = { compatibility: `managed-${VERSION}`, enabled: false };
    handlers.get("session_start")({}, context);
    assert.equal(health.facts().wake_capability, false); assert.equal(claim(), false);
    await health.tick(); assert.equal(calls, 0);
    failConfig = true; handlers.get("session_start")({}, context);
    assert.equal(health.facts().wake_capability, false); assert.equal(claim(), false);
    await health.tick(); assert.equal(calls, 0);
  } finally { health.close(); registerManagedWake(undefined); fs.rmSync(directory, { recursive: true, force: true }); }
});
