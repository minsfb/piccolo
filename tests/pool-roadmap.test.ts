import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { acquireSlot } from "../src/pool.ts";
import { evaluateRoadmap } from "../src/roadmap.ts";
import { git } from "../src/workflow.ts";

test("worker slots coordinate across processes and queue until released", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-pool-"));
  try {
    const first = await acquireSlot("first", "session1", { capacity: 1 }, undefined, dir);
    const module = new URL("../src/pool.ts", import.meta.url).href;
    const program = `import {acquireSlot} from ${JSON.stringify(module)}; const lease=await acquireSlot('second','session2',{capacity:1,queue_timeout_ms:5000},undefined,${JSON.stringify(dir)}); console.log('acquired'); lease.release();`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program]);
    let output = ""; child.stdout.on("data", d => output += d);
    const exit = new Promise<number|null>(resolve => child.on("exit", resolve));
    await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(output, "");
    first.release(); assert.equal(await exit, 0); assert.equal(output.trim(), "acquired");
    assert.ok(!fs.existsSync(path.join(dir, "slot-0.json")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("queue cancellation, capacity disagreement and session launch guideline fail explicitly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-pool-"));
  try {
    const first = await acquireSlot("first", dir, { capacity: 1, max_launches_per_session: 1 }, undefined, dir);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(acquireSlot("second", "abort", { capacity: 1 }, abort.signal, dir), /Cancelled/);
    await assert.rejects(acquireSlot("second", "mismatch", { capacity: 2 }, undefined, dir), /capacity differs/);
    first.release();
    await assert.rejects(acquireSlot("second", dir, { capacity: 1, max_launches_per_session: 1 }, undefined, dir), /launch guideline/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("dependency joins allow stacked commits, require real merges, and propagate drift", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-roadmap-"));
  try {
    git(root, "init", "-b", "main"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
    git(root, "commit", "--allow-empty", "-m", "Base"); const base = git(root, "rev-parse", "HEAD");
    git(root, "switch", "-c", "task/a"); git(root, "commit", "--allow-empty", "-m", "A"); const a = git(root, "rev-parse", "HEAD");
    const tasks = [{ id: "A", title: "A", status: "complete", candidate: a }, { id: "B", title: "B", status: "planned", needs: [{ task: "A" }] }, { id: "C", title: "C", status: "planned", needs: [{ task: "A", requires: "merge", merged_into: "main" }] }];
    let result = evaluateRoadmap(root, { format: 1, tasks }); assert.deepEqual(result.ready, ["B"]); assert.ok(result.waiting.C);
    git(root, "branch", "-f", "main", a); result = evaluateRoadmap(root, { format: 1, tasks }); assert.deepEqual(result.ready, ["B", "C"]);
    const dependent = { id: "D", title: "D", status: "complete", candidate: a, needs: [{ task: "A" }], recorded_dependencies: { A: base } };
    result = evaluateRoadmap(root, { format: 1, tasks: [...tasks, dependent, { id: "E", title: "E", status: "planned", needs: [{ task: "D" }, { task: "A" }] }] });
    assert.ok(result.stale.D); assert.ok(result.waiting.E); assert.ok(!result.ready.includes("E"));
    assert.throws(() => evaluateRoadmap(root, { format: 1, tasks: [{ id: "X", title: "X", status: "planned", needs: [{ task: "X" }] }] }), /cycle/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
