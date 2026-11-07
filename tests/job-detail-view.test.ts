import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { JobDetailView, detailText } from "../src/job-detail-view.ts";

test("job details wrap and scroll within the viewport, sanitize terminal escapes, and dismiss explicitly", () => {
  let closed = 0; let redraws = 0; let height = 12;
  const value = { result: { result: { kind: "text", text: Array.from({ length: 80 }, (_, i) => `Line ${i}: 界 readable output`).join("\n") + "\n\x1b]52;c;unsafe\x07\x1b[31mEND" } } };
  const view = new JobDetailView("Result", value, () => height, () => redraws++, () => closed++);
  const first = view.render(35); assert.ok(first.join("\n").includes("Line 0"));
  assert.ok(first.length <= height); assert.ok(first.every(l => visibleWidth(l) <= 35));
  view.handleInput("\x1b[6~"); const second = view.render(35);
  assert.notDeepEqual(first, second); assert.equal(closed, 0); assert.equal(redraws, 1);
  view.handleInput("\x1b[F"); assert.notDeepEqual(view.render(35), second);
  height = 20; view.invalidate(); assert.ok(view.render(20).every(l => visibleWidth(l) <= 20));
  view.handleInput("\x1b[H"); assert.ok(view.render(35).join("\n").includes("Line 0"));
  assert.ok(!detailText(value).includes("\x1b"));
  view.handleInput("\x1b"); assert.equal(closed, 1);
  assert.match(detailText({ result: "x".repeat(150000) }), /Display truncated/);
});
