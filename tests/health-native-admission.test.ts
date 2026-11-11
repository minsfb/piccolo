import test from "node:test";
import assert from "node:assert/strict";
import { hasParentWake, requestParentWake } from "../packages/health/src/wake.ts";
import { resolveHealthConfig, selectsManagedWake } from "../packages/health/src/config.ts";

test("native admission requires explicit selection and exact versioned contract", () => {
  let calls = 0;
  const context = { sessionManager: { getSessionId: () => "session" }, turnAdmission: {
    version: 1, contract: "pi.completion-admission/v1", enqueue(request: { id: string }) { calls++; return { version: 1, id: request.id, status: "queued" }; },
  } };
  const request = { sessionId: "session", id: "outcome-revision", content: "Inspect retained result" };
  assert.equal(hasParentWake(context, false), false);
  assert.equal(requestParentWake(context, request, false).status, "unsupported");
  assert.equal(calls, 0);
  assert.equal(hasParentWake(context, false, true), true);
  assert.equal(requestParentWake(context, request, false, true).status, "accepted");
  assert.equal(requestParentWake(context, { ...request, sessionId: "replacement" }, false, true).status, "stale");
  assert.equal(calls, 1);
  for (const turnAdmission of [{ ...context.turnAdmission, version: 2 }, { ...context.turnAdmission, contract: "unknown" }, undefined]) {
    assert.equal(hasParentWake({ ...context, turnAdmission }, false, true), false);
    assert.equal(requestParentWake({ ...context, turnAdmission }, request, false, true).status, "unsupported");
  }
  const config = resolveHealthConfig([{ compatibility: "native-v1" }]);
  assert.equal(selectsManagedWake(config.compatibility, "1.5.0"), false);
});

test("native receipts retain busy/stale and refuse malformed replies without replay", () => {
  const request = { sessionId: "session", id: "completion", content: "Inspect" };
  for (const status of ["accepted", "busy", "stale", "queued", "unknown"]) {
    let calls = 0;
    const context = { sessionManager: { getSessionId: () => "session" }, turnAdmission: {
      version: 1, contract: "pi.completion-admission/v1", enqueue() { calls++; return { version: 1, id: request.id, status }; },
    } };
    assert.equal(requestParentWake(context, request, false, true).status, status === "queued" ? "accepted" : status === "unknown" ? "invalid" : status);
    assert.equal(calls, 1);
  }
});
