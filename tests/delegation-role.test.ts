import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { delegate } from "../src/delegation.ts";

test("workflow roles retain native tool limits without the removed completion heuristic", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-native-role-"));
  const previous = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = directory;
  try {
    for (const role of [undefined, true, false]) {
      const listeners = new Map<string, (value: any) => void>(); let definition: any; let disposed = false;
      const pi: any = { events: {
        on(name: string, fn: (value: any) => void) { listeners.set(name, fn); return () => listeners.delete(name); },
        emit(name: string, value: any) {
          if (name === "pi-subagents:runtime-agent-register:v1") { definition = value.definition; value.result = { ok: true, registration: { dispose() { disposed = true; } } }; }
          if (name === "prompt-template:subagent:request") listeners.get("prompt-template:subagent:response")!({ requestId: value.requestId, ownerRunId: value.ownerRunId, nodeId: value.nodeId, status: "completed", result: { kind: "text", text: "Reviewed exact candidate" } });
        },
      } };
      const ctx: any = { cwd: directory, sessionManager: { getSessionId: () => `fixture-${role}` }, ...(role === undefined ? {} : { piccoloCoordinator: role }) };
      const result = await delegate(pi, ctx, { tools: ["read", "bash"] }, "Review the original request: implement a feature", "fixture", []);
      assert.equal(result.status, "completed");
      assert.equal(definition.completionGuard, undefined);
      assert.deepEqual(definition.tools, ["read", "bash"]);
      assert.equal(disposed, true); assert.equal(listeners.size, 0);
      assert.equal(fs.existsSync(result.pool_lease as string), false);
    }
  } finally { if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous; fs.rmSync(directory, { recursive: true }); }
});


test("background handoff keeps its lease until the correlated terminal response", async () => {
  const { withBackground } = await import("../src/job-context.ts");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-handoff-"));
  const previous = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = directory;
  try {
    const listeners = new Map<string, (value: any) => void>(); let request: any; let disposed = false;
    const pi: any = { events: {
      on(name: string, fn: (value: any) => void) { listeners.set(name, fn); return () => listeners.delete(name); },
      emit(name: string, value: any) {
        if (name === "pi-subagents:runtime-agent-register:v1") value.result = { ok: true, registration: { dispose() { disposed = true; } } };
        if (name === "prompt-template:subagent:request") request = value;
      },
    } };
    const ctx = withBackground({ cwd: directory, sessionManager: { getSessionId: () => "handoff" } } as any, {} as any);
    let settled = false;
    const pending = delegate(pi, ctx, {}, "Ask supervisor, then continue", "owner", []).then(value => { settled = true; return value; });
    while (!request) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(request.awaitSupervisor, true);
    listeners.get("prompt-template:subagent:response")!({ ...request, ownerRunId: "another-owner", status: "completed" });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(settled, false); assert.equal(disposed, false);
    listeners.get("prompt-template:subagent:response")!({ ...request, status: "completed", result: { kind: "text", text: "continued" } });
    const result = await pending;
    assert.equal(result.status, "completed"); assert.equal(disposed, true);
    assert.equal(fs.existsSync(result.pool_lease as string), false);
  } finally { if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous; fs.rmSync(directory, { recursive: true }); }
});

test("the pinned native parser carries supervisor ownership into execution", async () => {
  const { pathToFileURL } = await import("node:url");
  const root = path.resolve(import.meta.dirname, "../node_modules/pi-subagents");
  const parser = await import(pathToFileURL(path.join(root, "src/slash/delegation-request.js")).href);
  const adapters = await import(pathToFileURL(path.join(root, "src/slash/delegation-adapters.js")).href);
  const request = { requestId: "request", ownerRunId: "owner", nodeId: "delegate", agent: "fixture", task: "Ask supervisor", context: "fresh", cwd: "/tmp", model: "fixture/model", awaitSupervisor: true, result: { kind: "text" } };
  const parsed = parser.parseSubagentDelegationRequest(request);
  assert.equal(parsed.ok, true);
  const params = adapters.toSubagentDelegationExecutionParams(parsed.request);
  assert.equal(params.workflowAwaitDetached, true);
  assert.equal(params.retainOriginCancellation, true);
  assert.equal(parser.parseSubagentDelegationRequest({ ...request, awaitSupervisor: "yes" }).ok, false);
});
