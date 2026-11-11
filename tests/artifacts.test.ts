import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { requireIgnoredArtifacts } from "../src/durable/artifacts.ts";

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-artifacts-")));
  execFileSync("git", ["init", "-q", root]);
  fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n");
  return root;
}

// #38 C1: an outer ignore rule cannot authorize writes in a nested repository.
test("private artifact admission rejects nested repositories and Git files before writes", () => {
  for (const marker of ["directory", "file"]) {
    const root = fixture();
    try {
      const nested = path.join(root, ".cache", "nested"); fs.mkdirSync(nested, { recursive: true });
      if (marker === "directory") execFileSync("git", ["init", "-q", nested]);
      else fs.writeFileSync(path.join(nested, ".git"), "gitdir: /unavailable/owned-fixture\n");
      const artifact = path.join(nested, "worker.sqlite");
      assert.throws(() => requireIgnoredArtifacts(root, [artifact]), /nested Git repository/);
      assert.equal(fs.existsSync(artifact), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("artifact admission distinguishes non-Git roots and rejects aliases or metadata", () => {
  const root = fixture();
  try {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-artifact-outside-"));
    try {
      assert.throws(() => requireIgnoredArtifacts(outside, ["worker.sqlite"]), /require a Git workspace/);
      fs.symlinkSync(outside, path.join(root, ".cache"));
      assert.throws(() => requireIgnoredArtifacts(root, [".cache/worker.sqlite"]), /real directories/);
      assert.throws(() => requireIgnoredArtifacts(root, [path.join(outside, "worker.sqlite")]), /outside its owning workspace/);
      assert.throws(() => requireIgnoredArtifacts(root, [".git/worker.sqlite"]), /Git metadata/);
      assert.equal(fs.existsSync(path.join(outside, "worker.sqlite")), false);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("ordinary ignored artifacts are admitted but tracked artifacts remain refused", () => {
  const root = fixture();
  try {
    const artifact = path.join(root, ".cache", "worker.sqlite");
    requireIgnoredArtifacts(root, [artifact, ".cache/workspace.json"]);
    assert.equal(fs.existsSync(path.join(root, ".cache")), false);
    fs.mkdirSync(path.dirname(artifact)); fs.writeFileSync(artifact, "fixture");
    execFileSync("git", ["-C", root, "add", "-f", ".cache/worker.sqlite"]);
    assert.throws(() => requireIgnoredArtifacts(root, [artifact]), /Ignore.*artifact paths/);
    assert.equal(fs.readFileSync(artifact, "utf8"), "fixture");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
