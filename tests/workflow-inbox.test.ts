import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { projectSessionsDirectory } from "pi-extensible-workflows/persistence";
import { reconcileWorkflows, acknowledgeWorkflow, verifyWorkflowCandidate, workflowNotice, workflowHome } from "../src/workflow-inbox.ts";

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-inbox-")));
  const session = randomUUID(), run = randomUUID();
  const directory = path.join(projectSessionsDirectory(root, workflowHome(root)), session, "runs", run);
  const value = { id: run, sessionId: session, cwd: root, state: "running", agents: [{ state: "running", model: { provider: "test", model: "fixture" }, systemPrompt: "PRIVATE_RAW_PROMPT" }] };
  const write = () => { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify(value)); };
  return { root, value, directory, write, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test("reconciliation recovers missed callbacks and stale acknowledgments cannot consume new state", () => {
  const f = fixture();
  try {
    assert.deepEqual(reconcileWorkflows(f.root).observations, []);
    assert.deepEqual(fs.readdirSync(f.root), []);
    f.write();
    const running = reconcileWorkflows(f.root);
    assert.equal(running.unresolved.length, 1);
    assert.equal(running.pending.length, 0);
    assert.ok(!JSON.stringify(running).includes("PRIVATE_RAW_PROMPT"));
    acknowledgeWorkflow(f.root, running.observations[0].id, "Observed; not evidence of liveness");
    f.value.state = "completed"; f.value.agents[0].state = "completed"; f.write();
    const completed = reconcileWorkflows(f.root);
    assert.equal(completed.pending.length, 1);
    assert.throws(() => acknowledgeWorkflow(f.root, running.observations[0].id, "old"), /stale/);
    acknowledgeWorkflow(f.root, completed.pending[0], "Reviewed exact observation");
    assert.equal(reconcileWorkflows(f.root).pending.length, 0);
    fs.unlinkSync(path.join(f.directory, "state.json"));
    assert.equal(reconcileWorkflows(f.root).missing_sources.length, 2);
  } finally { f.close(); }
});
test("independent processes acknowledge the same revision atomically", async () => {
  const f = fixture();
  try {
    f.value.state = "completed"; f.write();
    const receipt = reconcileWorkflows(f.root).pending[0];
    const source = new URL("../src/workflow-inbox.ts", import.meta.url).href;
    const script = `import {acknowledgeWorkflow} from ${JSON.stringify(source)}; acknowledgeWorkflow(process.argv[1],process.argv[2],"same acknowledgment");`;
    await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, f.root, receipt], { timeout: 15000 })));
    assert.equal(reconcileWorkflows(f.root).pending.length, 0);
    assert.throws(() => acknowledgeWorkflow(f.root, receipt, "different acknowledgment"), /Conflicting immutable/);
  } finally { f.close(); }
});
test("identity drift and symlinked evidence fail closed", () => {
  const f = fixture();
  try {
    f.value.cwd = path.dirname(f.root); f.write();
    assert.throws(() => reconcileWorkflows(f.root), /identity mismatch/);
    assert.match(workflowNotice(f.root) ?? "", /coordinator remains available/);
    f.value.cwd = f.root; f.write();
    const original = path.join(f.directory, "state.json");
    fs.renameSync(original, original + ".retained"); fs.symlinkSync(original + ".retained", original);
    assert.throws(() => reconcileWorkflows(f.root), /symlink/);
    fs.unlinkSync(original); fs.renameSync(original + ".retained", original);
    fs.mkdirSync(path.join(f.root, "elsewhere")); fs.symlinkSync(path.join(f.root, "elsewhere"), path.join(f.root, ".piccolo"));
    assert.throws(() => reconcileWorkflows(f.root), /symlink/);
  } finally { f.close(); }
});

test("candidate verification binds stage evidence to the owned clean branch and rejects drift", () => {
  const f = fixture();
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git(f.root, "init"); fs.writeFileSync(path.join(f.root, ".gitignore"), ".cache/\n");
    git(f.root, "add", ".gitignore"); git(f.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base");
    f.value.state = "completed"; f.value.agents = Array.from({ length: 4 }, () => ({ ...f.value.agents[0], state: "completed" })); f.write();
    const worktree = path.join(f.directory, "worktrees", "candidate");
    git(f.root, "worktree", "add", "-b", "fixture-candidate", worktree);
    const candidate = git(worktree, "rev-parse", "HEAD");
    const report = { status: "complete", commit: candidate, summary: "Fixture report", evidence: ["fixture check"] };
    fs.writeFileSync(path.join(f.directory, "result.json"), JSON.stringify({ status: "review_ready", workspace: { path: worktree, branch: "fixture-candidate" }, implementation: report, reviews: { correctness: report, architecture: report }, qa: report }));
    const id = reconcileWorkflows(f.root).pending[0];
    assert.equal(verifyWorkflowCandidate(f.root, id).candidate, candidate);
    fs.writeFileSync(path.join(worktree, "drift.txt"), "uncommitted change");
    assert.throws(() => verifyWorkflowCandidate(f.root, id), /uncommitted/);
    fs.unlinkSync(path.join(worktree, "drift.txt"));
    git(worktree, "checkout", "--detach");
    assert.throws(() => verifyWorkflowCandidate(f.root, id), /detached/);
    const resultPath = path.join(f.directory, "result.json");
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    result.workspace.branch = ""; fs.writeFileSync(resultPath, JSON.stringify(result));
    assert.throws(() => verifyWorkflowCandidate(f.root, id), /qualified implementation/);
  } finally { f.close(); }
});

test("FIFO records cannot block coordinator startup or explicit inspection", () => {
  const f = fixture();
  try {
    f.write(); const file = path.join(f.directory, "state.json"); fs.unlinkSync(file);
    execFileSync("mkfifo", [file]);
    const source = new URL("../src/workflow-inbox.ts", import.meta.url).href;
    const script = `import {workflowNotice,reconcileWorkflows} from ${JSON.stringify(source)}; import assert from 'node:assert/strict'; assert.match(workflowNotice(process.argv[1]), /regular file/); assert.throws(()=>reconcileWorkflows(process.argv[1]), /regular file/);`;
    execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, f.root], { timeout: 5000 });
  } finally { f.close(); }
});
