import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { visibleWidth } from "@earendil-works/pi-tui";
import { compactTool, jobNoticeRenderer, piccoloSummary } from "../src/display.ts";
import { healthRenderers, healthMessageRenderer } from "../packages/health/src/display.ts";
const theme: any = { fg: (_color: string, text: string) => text };
const tool = compactTool({ name: "piccolo_jobs", label: "Jobs", description: "fixture", parameters: Type.Object({}), async execute() { return { content: [], details: undefined }; } });
const rendered = (value: any, expanded = false, context: any = {}) => tool.renderResult!({ content: [{ type: "text", text: JSON.stringify(value) }], details: value }, { expanded, isPartial: false }, theme, context).render(48);

test("large JSON stays compact at narrow widths and expands without changing model data", () => {
  const value = { id: "12345678-1234-1234-1234-123456789abc", state: "completed", parent_review: { disposition: "pending" }, result: { text: "RETAINED-RESULT-".repeat(1000) } };
  const before = JSON.stringify(value);
  const lines = rendered(value);
  assert.equal(lines.length, 2); assert.ok(lines.every(line => visibleWidth(line) <= 48));
  assert.match(lines.join("\n"), /completed/); assert.doesNotMatch(lines.join("\n"), /RETAINED-RESULT/);
  assert.match(rendered(value, true).join("\n"), /RETAINED-RESULT/);
  assert.equal(JSON.stringify(value), before);
});

test("failures, truncation and partial progress are distinct from completion", () => {
  assert.match(rendered({ status: "blocked", error: "Endpoint unavailable" }).join("\n"), /Attention.*blocked[\s\S]*Endpoint unavailable/);
  assert.match(rendered({ truncated: true, record: "fixture" }).join("\n"), /truncated/);
  const component = tool.renderResult!({ content: [], details: {} }, { expanded: false, isPartial: true }, theme, {} as any);
  assert.match(component.render(80).join("\n"), /Running/);
  const terminalError = tool.renderResult!({ content: [{ type: "text", text: "Launch denied" }], details: undefined }, { expanded: false, isPartial: false }, theme, { isError: true } as any);
  assert.match(terminalError.render(80).join("\n"), /Attention[\s\S]*Launch denied/);
});

test("collapsed presentation rejects terminal controls and keeps execution/schema identity", () => {
  const result = rendered({ status: "blocked", error: "bad\x1b[2J\x1b]0;title\x07\r\nnext" }).join("\n");
  assert.doesNotMatch(result, /\x1b|\r|\x07/);
  const original = { name: "piccolo_fixture", label: "Fixture", description: "fixture", parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }) };
  const decorated = compactTool(original);
  assert.equal(decorated.execute, original.execute); assert.equal(decorated.parameters, original.parameters);
});

test("job notices and health incident messages use compact summaries with expandable originals", () => {
  const message = { content: "Inspect this exact outcome and acknowledge after verification. " + "DETAIL ".repeat(100), details: { jobs: ["a", "b"] } };
  assert.match(jobNoticeRenderer(message, { expanded: false }).render(80).join("\n"), /2 job outcomes/);
  assert.match(jobNoticeRenderer(message, { expanded: true }).render(80).join("\n"), /acknowledge after verification/);
  const incident = { component: "attention", code: "unacknowledged", disposition: "resolved", id: "123456789abc", actions: [{ detail: "FULL-RECEIPT" }] };
  const healthMessage = { content: JSON.stringify(incident) };
  assert.match(healthMessageRenderer(healthMessage, { expanded: false }).render(100).join("\n"), /resolved/);
  assert.doesNotMatch(healthMessageRenderer(healthMessage, { expanded: false }).render(100).join("\n"), /FULL-RECEIPT/);
  assert.match(healthMessageRenderer(healthMessage, { expanded: true }).render(100).join("\n"), /FULL-RECEIPT/);
});

test("health recording and wake degradation stay visible; details are unchanged", () => {
  for (const [value, expected] of [
    [{ storage_failed: true }, /recording failed/],
    [{ active: true, recovery: "wake", wake_capability: false, incidents: [] }, /automatic wake unavailable/],
    [{ active: true, incidents: [{ component: "worker", code: "deadline_expired", disposition: "open", id: "abc" }] }, /1 unresolved[\s\S]*deadline_expired/],
  ] as const) {
    const before = JSON.stringify(value);
    const result = { content: [{ type: "text", text: before }], details: value };
    assert.match(healthRenderers.renderResult(result, { expanded: false }, theme, {}).render(120).join("\n"), expected);
    assert.equal(JSON.stringify(value), before);
  }
});


test("readiness counts map entries and remote outcomes retain failures", () => {
  assert.equal(piccoloSummary("piccolo_readiness", {ready: [], waiting: {a: ["b"]}, stale: {c: ["d"]}}), "0 ready · 1 waiting · 1 stale");
  const remote = compactTool({...tool, name: "piccolo_remote"});
  for (const status of ["failed", "startup_error", "timed_out"]) {
    const value = {state: "terminal", outcome: {status, error: "Worker unavailable"}};
    const text = remote.renderResult!({content: [], details: value}, {expanded:false,isPartial:false}, theme, {} as any).render(120).join("\n");
    assert.match(text, /Attention.*terminal/); assert.ok(text.includes(status)); assert.match(text, /Worker unavailable/);
  }
  assert.match(piccoloSummary("piccolo_remote", {state:"terminal",outcome:{status:"completed"}}), /terminal.*completed/);
  const evidence = compactTool({...tool, name: "piccolo_evidence"});
  const text = evidence.renderResult!({content:[{type:"text",text:"Denied"}],details:undefined},{expanded:false,isPartial:false},theme,{isError:true} as any).render(120).join("\n");
  assert.match(text, /Tool failed/); assert.doesNotMatch(text, /Evidence recorded/);
});
