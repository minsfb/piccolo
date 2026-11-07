import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, runWorkflow } from "../src/workflow.ts";
import { loadConfig } from "../src/config.ts";
import { checkpointWorkflow, restoreCheckpoint } from "../src/worktree-checkpoint.ts";

test("terminal dirty attempt checkpoint restores index, binaries, deletions and untracked/ignored artifacts", async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-checkpoint-")));
  const root = path.join(directory, "project"), worktree = path.join(directory, "work"); fs.mkdirSync(root);
  try {
    git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid");
    fs.writeFileSync(path.join(root, ".gitignore"), ".cache/\n.pi/\n");
    fs.writeFileSync(path.join(root, "deleted"), "old"); fs.writeFileSync(path.join(root, "staged"), "old");
    git(root, "add", "."); git(root, "commit", "-m", "Fixture");
    const result = await runWorkflow({ root, worktree, branch: "attempt/one", task: "Fixture", job: "implementation", resolved: loadConfig(root, { userFile: path.join(directory, "absent") }), maxRevisions: 0 }, async () => {
      fs.unlinkSync(path.join(worktree, "deleted"));
      fs.writeFileSync(path.join(worktree, "staged"), "staged version"); git(worktree, "add", "staged");
      fs.writeFileSync(path.join(worktree, "staged"), "unstaged version");
      fs.writeFileSync(path.join(worktree, "binary"), Buffer.from([0, 255, 1]));
      fs.mkdirSync(path.join(worktree, ".cache")); fs.writeFileSync(path.join(worktree, ".cache/evidence"), "retained");
      fs.symlinkSync("staged", path.join(worktree, "link"));
      return { status: "blocked", summary: "Retain interrupted work", evidence: [] };
    }, () => {});
    const before = git(worktree, "status", "--porcelain");
    const checkpoint = path.join(directory, "snapshot");
    const receipt = checkpointWorkflow(root, result.id, checkpoint);
    assert.equal(receipt.restore_verified, false);
    const restored = path.join(directory, "restored");
    assert.equal(restoreCheckpoint(root, checkpoint, restored, "attempt/restored").restore_verified, true);
    assert.equal(git(restored, "status", "--porcelain"), before);
    assert.equal(git(restored, "show", ":staged"), "staged version");
    assert.equal(fs.readFileSync(path.join(restored, "staged"), "utf8"), "unstaged version");
    assert.deepEqual(fs.readFileSync(path.join(restored, "binary")), Buffer.from([0, 255, 1]));
    assert.equal(fs.readFileSync(path.join(restored, ".cache/evidence"), "utf8"), "retained");
    assert.equal(git(worktree, "status", "--porcelain"), before);
    assert.throws(() => restoreCheckpoint(root, checkpoint, restored, "attempt/second"), /already exists/);
    assert.throws(() => restoreCheckpoint(root, checkpoint, path.join(checkpoint, "files/nested"), "attempt/overlap"), /overlap/);
    assert.equal(fs.existsSync(path.join(checkpoint, "files/nested")), false);
    assert.equal(git(root, "branch", "--list", "attempt/overlap"), "");
    git(worktree, "update-index", "--split-index");
    assert.throws(() => checkpointWorkflow(root, result.id, path.join(directory, "split")), /Split-index/);
    assert.equal(fs.existsSync(path.join(directory, "split")), false);
    fs.appendFileSync(path.join(checkpoint, "files/binary"), "tampered");
    assert.throws(() => restoreCheckpoint(root, checkpoint, path.join(directory, "bad"), "attempt/bad"), /integrity mismatch/);
    assert.equal(git(root, "branch", "--list", "attempt/bad"), "");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
