import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "../src/workflow.ts";
import { boundNative, evidence, navigation } from "../src/evidence.ts";

test("large native results are retained outside Git and bounded in parent records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-evidence-"));
  try {
    git(root, "init"); fs.writeFileSync(path.join(root, ".gitignore"), ".cache/\n");
    const result = boundNative(root, "test", { requestId: "a", status: "completed", result: { kind: "text", text: "x".repeat(15000) } }, 2000);
    assert.ok(result.result!.text!.length < 2100);
    const artifact = result.raw_artifact as any;
    assert.equal(JSON.parse(fs.readFileSync(artifact.path, "utf8")).result.text.length, 15000);
    assert.equal(git(root, "check-ignore", artifact.path), artifact.path);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("artifact records hash actual bytes and encode navigation without executing commands", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-evidence-"));
  try {
    fs.writeFileSync(path.join(root, "space # file.txt"), "abc");
    const result = await evidence(root, { file: "space # file.txt", summary: "Synthetic evidence", preview: "http://localhost:8080/" });
    assert.equal(result.artifact.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.match(result.artifact.code_url, /space%20%23%20file.txt/);
    assert.equal(result.artifact.reveal_argv, null);
    assert.throws(() => navigation("/tmp/x", "host;echo"));
    await assert.rejects(evidence(root, { file: "space # file.txt", summary: "x", preview: "https://user:secret@example.invalid/" }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
