import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { git, runWorkflow } from "../src/workflow.ts";
import { loadConfig } from "../src/config.ts";
import { planWorktreeArea, prepareWorktreeArea, selectWorktreePath } from "../src/worktree-placement.ts";
import { preflightWorktree } from "../src/worktree-preflight.ts";
import { prepareProject, planProject } from "../src/onboarding.ts";

function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-placement-")));
  const root = path.join(directory, "repo with spaces"); fs.mkdirSync(root);
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(root, ".gitignore"), "/.pi/\n/.cache/\n# preserve me\n");
  git(root, "add", "."); git(root, "commit", "-m", "base");
  return { directory, root };
}

test("default selection is read-only and preflight prepares only the owning parent", () => {
  const { directory, root } = fixture();
  try {
    const target = selectWorktreePath(root, "feature/add");
    assert.equal(target, path.join(root, ".worktrees/feature-add"));
    assert.equal(planWorktreeArea(root).areaMissing, true);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.throws(() => preflightWorktree(root, target, "bad..branch"));
    assert.equal(fs.existsSync(path.dirname(target)), false);
    const receipt = preflightWorktree(root, target, "feature/add");
    assert.equal(receipt.worktree, target);
    assert.equal(fs.existsSync(target), false);
    assert.equal(git(root, "branch", "--list", "feature/add"), "");
    assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), "/.pi/\n/.cache/\n# preserve me\n/.worktrees/\n");
    preflightWorktree(root, target, "feature/add");
    assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8").match(/\/\.worktrees\//g)?.length, 1);
    const alias = path.join(directory, "area-alias"); fs.symlinkSync(path.dirname(target), alias);
    assert.equal(preflightWorktree(root, path.join(alias, "another"), "another").worktree, path.join(root, ".worktrees/another"));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("linked worktree onboarding and default launches reuse the primary area", () => {
  const { directory, root } = fixture();
  try {
    const first = path.join(root, ".worktrees/task-a");
    prepareWorktreeArea(root); git(root, "add", ".gitignore"); git(root, "commit", "-m", "isolation");
    git(root, "worktree", "add", "-b", "task-a", first, "HEAD");
    const plan = planProject(first);
    assert.equal(plan.worktreePlacement?.ownerRoot, root);
    prepareProject(first);
    assert.equal(selectWorktreePath(first, "task-b"), path.join(root, ".worktrees/task-b"));
    assert.equal(fs.existsSync(path.join(first, ".worktrees")), false);
    for (const cwd of [root, first]) {
      assert.throws(() => selectWorktreePath(cwd, "task-b", path.join(first, ".worktrees/task-b")), /Nested/);
      assert.equal(fs.existsSync(path.join(first, ".worktrees")), false);
    }
    assert.throws(() => selectWorktreePath(first, "task-b", undefined, git(first, "rev-parse", "HEAD")), /explicit existing worktree/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("explicit destinations retain placement and inaccessible parents create no branch or directories", () => {
  const { directory, root } = fixture();
  try {
    const explicit = path.join(directory, "sibling");
    assert.equal(preflightWorktree(root, explicit, "task-a").worktree, explicit);
    assert.equal(fs.existsSync(path.join(root, ".worktrees")), false);
    assert.throws(() => preflightWorktree(root, path.join(directory, "missing/task-b"), "task-b"), /existing parent/);
    assert.equal(fs.existsSync(path.join(directory, "missing")), false);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(git(root, "branch", "--list", "task-b"), "");
    assert.throws(() => preflightWorktree(root, path.join(root, ".git/.worktrees/task-b"), "task-b"), /administrative metadata/);
    assert.equal(fs.existsSync(path.join(root, ".git/.worktrees")), false);
    const metadataAlias = path.join(directory, "metadata-alias"); fs.symlinkSync(path.join(root, ".git"), metadataAlias);
    assert.throws(() => preflightWorktree(root, path.join(metadataAlias, "task-b"), "task-b"), /administrative metadata/);
    const foreign = path.join(directory, "foreign"); fs.mkdirSync(foreign);
    fs.symlinkSync(foreign, path.join(root, ".worktrees"));
    assert.throws(() => selectWorktreePath(root, "task-b"), /real directory/);
    assert.deepEqual(fs.readdirSync(foreign), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("foreground workflow uses default placement and runs required Python validation", async () => {
  const { directory, root } = fixture();
  try {
    const resolved = loadConfig(root, { userFile: path.join(directory, "absent.toml"), invocation: { jobs: { implementation: { validation: {
      mode: "required", checks: { unittest: { command: "python3 -m unittest discover -s tests", cwd: ".", boundary: "isolated", scope: "Owned temporary arithmetic fixture", timeout_ms: 30000 } },
    } } } } });
    const result = await runWorkflow({ root, branch: "feature/add", task: "Add arithmetic with unit tests", job: "implementation", resolved, maxRevisions: 0 },
      async ({ cwd, stage }) => {
        assert.equal(cwd, path.join(root, ".worktrees/feature-add"));
        if (stage === "implement") {
          fs.writeFileSync(path.join(cwd, "arithmetic.py"), "def add(a, b):\n    return a + b\n");
          fs.mkdirSync(path.join(cwd, "tests"));
          fs.writeFileSync(path.join(cwd, "tests/test_arithmetic.py"), "import unittest\nfrom arithmetic import add\n\nclass AddTest(unittest.TestCase):\n    def test_add(self):\n        for a, b, expected in [(2, 3, 5), (-2, 3, 1), (0, 0, 0), (1.5, 2.5, 4.0)]:\n            with self.subTest(a=a, b=b):\n                self.assertEqual(add(a, b), expected)\n");
          git(cwd, "add", "."); git(cwd, "commit", "-m", "Add arithmetic and tests");
        }
        return { status: "complete", summary: "Exact candidate inspected", commit: git(cwd, "rev-parse", "HEAD"), evidence: ["Scoped arithmetic fixture inspected"] };
      }, () => {});
    assert.equal(result.status, "complete", JSON.stringify(result));
    assert.equal(result.qualification, "checks_passed");
    assert.equal(result.worktree, path.join(root, ".worktrees/feature-add"));
    assert.equal(git(result.worktree, "status", "--porcelain"), "");
    assert.equal(git(root, "rev-parse", "HEAD"), result.base);
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.record, "launch.json"), "utf8")).worktree, result.worktree);
    const cli = JSON.parse(execFileSync(process.execPath, ["bin/piccolo.mjs", "worktree", "plan", "--cwd", result.worktree, "--branch", "task-b"], { encoding: "utf8" }));
    assert.equal(cli.worktree, path.join(root, ".worktrees/task-b"));
    assert.equal(fs.existsSync(path.join(result.worktree, ".worktrees")), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a denied owning area is never replaced with a nested or sibling fallback", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const { directory, root } = fixture();
  const ignore = path.join(root, ".gitignore");
  try {
    fs.chmodSync(ignore, 0o444); fs.chmodSync(root, 0o500);
    assert.throws(() => preflightWorktree(root, path.join(root, ".worktrees/task"), "task"), /EACCES|EPERM|writable/);
    assert.equal(fs.existsSync(path.join(root, ".worktrees")), false);
    assert.equal(git(root, "branch", "--list", "task"), "");
    assert.equal(fs.readFileSync(ignore, "utf8"), "/.pi/\n/.cache/\n# preserve me\n");
  } finally { fs.chmodSync(root, 0o700); fs.chmodSync(ignore, 0o644); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("bare layouts require an explicit existing external parent", () => {
  const { directory, root } = fixture();
  try {
    const bare = path.join(directory, "bare.git"); git(root, "clone", "--bare", "-q", root, bare);
    assert.throws(() => selectWorktreePath(bare, "task"), /explicit worktree destination/);
    const parent = path.join(directory, "explicit/.worktrees"); fs.mkdirSync(parent, { recursive: true });
    assert.equal(preflightWorktree(bare, path.join(parent, "task"), "task").worktree, path.join(parent, "task"));
    assert.throws(() => preflightWorktree(bare, path.join(bare, ".worktrees/task"), "task"), /administrative metadata/);
    assert.equal(git(bare, "branch", "--list", "task"), "");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
