import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runWorkflow as execute } from "pi-extensible-workflows";
import { assertUpstream } from "../src/extensible.ts";
import { packageRoot } from "../src/config.ts";

test("upstream DSL executes joins through the public bridge and propagates failures", async () => {
  const calls: string[] = [];
  const job = execute('const r = await parallel("join", {a: async () => await agent("a"), b: async () => await agent("b")}); return await agent(r.a + r.b);', null,
    { agent: async (prompt) => { calls.push(prompt); return prompt; } });
  assert.equal(await job.result, "ab");
  assert.deepEqual(calls.slice(0, 2).sort(), ["a", "b"]);
  assert.equal(calls.at(-1), "ab");
  await assert.rejects(execute('return await agent("fail");', null, { agent: async () => { throw new Error("fixture failure"); } }).result, /fixture failure/);
});

test("upstream DSL cancellation terminates a nonresponsive owned worker", async () => {
  const job = execute('while (true) {}');
  setTimeout(() => job.cancel(), 100);
  await assert.rejects(job.result, /cancel/i);
});

test("pinned workflow interpreter patch retains Node permission boundaries", () => {
  assertUpstream();
  const patch = fs.readFileSync(path.join(packageRoot, "scripts/patch-workflows.py"), "utf8");
  const expected = patch.match(/^PATCHED = "([a-f0-9]+)"$/m)![1];
  const source = fs.readFileSync(path.join(packageRoot, "node_modules/pi-extensible-workflows/dist/src/index.js"));
  assert.equal(createHash("sha256").update(source).digest("hex"), expected, "Run the exact-hash patch helper after dependency install");
  const text = source.toString();
  assert.ok(text.includes('"--permission", `--allow-fs-read=${childDir}`'));
  assert.ok(text.includes('execPath: process.versions.bun ? "node" : process.execPath'));
  assert.ok(!text.includes('BUN_BE_BUN: "1"'));
});
