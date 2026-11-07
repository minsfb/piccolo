import test from "node:test";
import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { JobListView } from "../src/job-list-view.ts";
const identity = (text: string) => text;
const theme = { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity };

test("open list updates terminal state, retains selected ID and disposes refresh on dismissal", async () => {
  const rows = ["first", "second"].map(id => ({ id, kind: "delegate", state: "running", stopping: true, parent_review: { disposition: "not_ready" } }));
  let selected: string | undefined, redraws = 0;
  const view = new JobListView(() => rows, () => 20, theme, () => redraws++, id => { selected = id; });
  try {
    view.handleInput("\x1b[B");
    assert.match(view.render(100).join("\n"), /stopping/);
    rows[1].state = "cancelled"; rows[1].stopping = false; rows[1].parent_review.disposition = "pending";
    const before = redraws;
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.ok(redraws > before, "timer refreshes while the menu is idle");
    assert.match(view.render(100).join("\n"), /second delegate cancelled \[pending\]/);
    assert.doesNotMatch(view.render(100).join("\n"), /second.*stopping/);
    view.handleInput("\r"); assert.equal(selected, "second");
    const closed = redraws; rows[1].state = "completed";
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(redraws, closed, "closing removes the polling timer");
  } finally { view.dispose(); }
});

test("Escape only closes the list and an empty list remains dismissible", () => {
  let closed = 0;
  const view = new JobListView(() => [], () => 20, theme, () => {}, id => { assert.equal(id, undefined); closed++; });
  try { view.render(40); view.handleInput("\x1b"); assert.equal(closed, 1); }
  finally { view.dispose(); }
});

test("refresh failure is visible and remains dismissible instead of escaping a timer", async () => {
  let fail = false, closed = false, redraws = 0;
  const view = new JobListView(() => { if (fail) throw new Error("private-path"); return []; }, () => 20, theme, () => redraws++, () => { closed = true; });
  try {
    fail = true; await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(redraws, 1, "empty-to-error must repaint without input or an external render");
    const text = view.render(100).join("\n");
    assert.match(text, /refresh failed/); assert.doesNotMatch(text, /private-path/);
    view.handleInput("\x1b"); assert.equal(closed, true);
  } finally { view.dispose(); }
});

test("native extension selector j/k, boundary navigation and tool expansion remain available", () => {
  const previous = getKeybindings(); setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS,
    "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } }));
  const rows = ["first", "second"].map(id => ({ id, kind: "delegate", state: "completed", stopping: false, parent_review: { disposition: "pending" } }));
  let selected: string | undefined, expanded = 0;
  const view = new JobListView(() => rows, () => 20, theme, () => {}, id => { selected = id; }, () => expanded++);
  try {
    view.handleInput("\x1b[A"); // clamp at first, not wrap
    view.handleInput("j"); view.handleInput("\x1b[B"); // clamp at second
    view.handleInput("k"); view.handleInput("j");
    view.handleInput("\x0f"); assert.equal(expanded, 1);
    view.handleInput("\n"); assert.equal(selected, "second");
  } finally { view.dispose(); setKeybindings(previous); }
});
