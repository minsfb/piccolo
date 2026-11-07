import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeRecords, startRun } from "../src/records.ts";
import { loadConfig } from "../src/config.ts";

test("new sessions can inspect immutable run inputs and outcomes; initialization preserves edits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-record-test-"));
  try {
    assert.ok(initializeRecords(root).length >= 6);
    const design = path.join(root, ".piccolo/design.md"); fs.writeFileSync(design, "Accepted project design");
    assert.deepEqual(initializeRecords(root), []); assert.equal(fs.readFileSync(design, "utf8"), "Accepted project design");
    const resolved = loadConfig(root, { userFile: path.join(root, "missing") });
    const run = startRun(root, { type: "reviewer", task: "Review candidate abc", resolved, agent: {}, parent: { model: "p/m" } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(run.directory, "launch.json"), "utf8")).resolved.digest, resolved.digest);
    const output = run.finish({ status: "challenged", summary: "Specification conflicts with accepted design" });
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).status, "challenged");
    assert.throws(() => run.finish({ status: "complete" }), /EEXIST/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("refuse symlinked execution storage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-record-link-test-"));
  try { fs.mkdirSync(path.join(root, "other")); fs.symlinkSync(path.join(root, "other"), path.join(root, ".piccolo")); assert.throws(() => initializeRecords(root), /symlink/); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});
