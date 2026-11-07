import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { executeCheck, assessChecks, readCheck } from "../src/validation.ts";
import { git, runWorkflow } from "../src/workflow.ts";
import { loadConfig } from "../src/config.ts";
function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-validation-")));
  const root = path.join(directory, "project"); fs.mkdirSync(root);
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(root, ".gitignore"), "/.cache/\n/.pi/\n");
  fs.writeFileSync(path.join(root, "source"), "original"); git(root, "add", "."); git(root, "commit", "-m", "Fixture");
  return { directory, root, candidate: git(root, "rev-parse", "HEAD") };
}
const spec = { check: "focused", command: "printf evidence", boundary: "isolated" as const, scope: "Synthetic output only", timeout_ms: 1000 };

test("real unittest validation suppresses bytecode without ignore rules and records its execution environment", async () => {
  const { root, directory } = fixture();
  try {
    fs.writeFileSync(path.join(root, "arithmetic.py"), "def add(a, b):\n    return a + b\n");
    fs.mkdirSync(path.join(root, "tests"));
    fs.writeFileSync(path.join(root, "tests/test_arithmetic.py"), "import unittest\nfrom arithmetic import add\nclass AddTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n");
    git(root, "add", "."); git(root, "commit", "-m", "Python candidate");
    const candidate = git(root, "rev-parse", "HEAD"), command = "python3 -m unittest discover -s tests";
    const result = await executeCheck(root, { ...spec, command, candidate });
    assert.equal(result.status, "pass");
    const receipt = readCheck(root, result.id);
    assert.equal(receipt.command, command);
    assert.deepEqual(receipt.environment_overrides, { PYTHONDONTWRITEBYTECODE: "1" });
    assert.equal(fs.existsSync(path.join(root, "__pycache__")), false);
    assert.equal(fs.existsSync(path.join(root, "tests/__pycache__")), false);
    assert.equal(git(root, "status", "--porcelain"), "");
    // Old receipts did not record environment overrides and remain readable.
    const legacy: any = { ...receipt }; delete legacy.environment_overrides;
    fs.writeFileSync(path.join(root, result.record), JSON.stringify(legacy));
    assert.equal(readCheck(root, result.id).status, "pass");
    const changed = await executeCheck(root, { ...spec, command: "printf generated > unexpected.txt", candidate });
    assert.equal(changed.status, "stale");
    assert.equal(fs.readFileSync(path.join(root, "unexpected.txt"), "utf8"), "generated");
  } finally { fs.rmSync(directory, { recursive: true }); }
});
test("candidate checks retain actual output/status and failed latest attempts defeat an earlier pass", async () => {
  const { root, directory, candidate } = fixture();
  try {
    const pass = await executeCheck(root, spec);
    assert.equal(pass.status, "pass"); assert.equal(readCheck(root, pass.id).exit_code, 0);
    assert.equal(fs.readFileSync(path.join(root, pass.output), "utf8"), "evidence");
    assert.equal(assessChecks(root, candidate, ["focused"], [pass.id]).status, "complete");
    const fail = await executeCheck(root, { ...spec, command: "exit 7", retry_of: pass.id, retry_reason: "Independent negative-fixture verification" });
    assert.equal(fail.status, "fail"); assert.equal(readCheck(root, fail.id).exit_code, 7);
    const file = path.join(root, fail.record), retained = fs.readFileSync(file, "utf8"), tampered = JSON.parse(retained);
    tampered.status = "pass"; fs.writeFileSync(file, JSON.stringify(tampered));
    assert.throws(() => readCheck(root, fail.id), /exit 0/);
    fs.writeFileSync(file, retained);
    assert.equal(assessChecks(root, candidate, ["focused"], [pass.id, fail.id]).status, "incomplete");
    assert.deepEqual(assessChecks(root, candidate, ["missing"], [pass.id]).missing, ["missing"]);
    await assert.rejects(executeCheck(root, { ...spec, retry_of: fail.id }), /Retry/);
    const timeout = await executeCheck(root, { ...spec, command: "sleep 20", timeout_ms: 50 });
    assert.equal(timeout.status, "timed_out"); assert.match(readCheck(root, timeout.id).error!, /timeout/);
    const abort = new AbortController(); abort.abort();
    assert.equal((await executeCheck(root, spec, abort.signal)).status, "cancelled");
    fs.writeFileSync(path.join(root, "source"), "changed");
    assert.equal(assessChecks(root, candidate, ["focused"], [pass.id]).status, "stale");
    await assert.rejects(executeCheck(root, spec), /clean candidate/);
    fs.appendFileSync(path.join(root, pass.output), "corrupt");
    assert.throws(() => readCheck(root, pass.id), /integrity/);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
test("workflow reports do not mask failed required harness validation", async () => {
  const { root, directory } = fixture();
  try {
    const resolved = loadConfig(root, { userFile: path.join(directory, "absent"), invocation: { jobs: { implementation: { validation: { checks: {
      focused: { command: "printf retained; exit 3", cwd: "agent", scope: "Intentional failed nested fixture", boundary: "isolated", timeout_ms: 1000 },
      later: { command: "cat marker", cwd: "agent", scope: "Later required check still runs", boundary: "isolated", timeout_ms: 1000 },
    } } } } } });
    const worktree = path.join(directory, "work");
    const outcome = await runWorkflow({ root, worktree, branch: "attempt", task: "Fixture", job: "implementation", resolved, maxRevisions: 1 }, async input => {
      if (input.stage === "implement") {
        fs.writeFileSync(path.join(input.cwd, "source"), "updated");
        fs.mkdirSync(path.join(input.cwd, "agent")); fs.writeFileSync(path.join(input.cwd, "agent/marker"), "nested");
        git(input.cwd, "add", "source", "agent"); git(input.cwd, "commit", "-m", "Candidate");
      }
      return { status: "complete", summary: "Worker says all passed", commit: git(input.cwd, "rev-parse", "HEAD"), evidence: ["Worker-reported test"] };
    }, () => {});
    assert.equal(outcome.status, "partial"); assert.equal(outcome.validation.status, "incomplete");
    assert.match(outcome.summary, /incomplete or stale/);
    const checks = fs.readdirSync(path.join(worktree, ".cache/piccolo/checks")); assert.equal(checks.length, 2, "each check runs once; no automatic retry");
    const receipts = checks.map(id => readCheck(worktree, id));
    assert.equal(receipts.find(r => r.check === "focused")!.status, "fail");
    assert.equal(receipts.find(r => r.check === "later")!.status, "pass");
    assert.equal(git(worktree, "status", "--porcelain"), "");
  } finally { fs.rmSync(directory, { recursive: true }); }
});

for (const mode of ["detach", "cancel"] as const) test(`post-QA ${mode} cannot produce workflow completion`, async () => {
  const { root, directory } = fixture(); const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolved = loadConfig(root, { userFile: path.join(directory, "absent"), invocation: { jobs: { implementation: { validation: { checks: {
      boundary: { command: mode === "detach" ? "git checkout --detach HEAD" : "sleep 20", scope: "Negative boundary fixture", boundary: "isolated", timeout_ms: 30000, required: mode === "detach" },
    } } } } } });
    const worktree = path.join(directory, "work");
    const outcome = await runWorkflow({ root, worktree, branch: "attempt", task: "Fixture", job: "implementation", resolved, maxRevisions: 0 }, async input => {
      if (input.stage === "implement") { fs.writeFileSync(path.join(input.cwd, "source"), "updated"); git(input.cwd, "add", "source"); git(input.cwd, "commit", "-m", "Candidate"); }
      if (mode === "cancel" && input.stage === "qa") timer = setTimeout(() => controller.abort(), 200);
      return { status: "complete", summary: "Worker report", commit: git(input.cwd, "rev-parse", "HEAD"), evidence: ["fixture"] };
    }, () => {}, controller.signal);
    assert.notEqual(outcome.status, "complete");
    assert.equal(outcome.status, mode === "cancel" ? "interrupted" : "blocked");
    const checks = fs.readdirSync(path.join(worktree, ".cache/piccolo/checks"));
    assert.equal(readCheck(worktree, checks[0]).status, mode === "cancel" ? "cancelled" : "stale");
  } finally { clearTimeout(timer); fs.rmSync(directory, { recursive: true }); }
});


test("default required validation stays partial until candidate continuation has passing receipts", async () => {
  const { root, directory, candidate: base } = fixture();
  try {
    const resolved = loadConfig(root, { userFile: path.join(directory, "absent") });
    const input = { root, worktree: path.join(directory, "work"), branch: "attempt", task: "Fixture", job: "implementation", resolved, maxRevisions: 0 };
    const calls: string[] = [];
    const worker = async ({ cwd, stage }: any) => {
      calls.push(stage);
      if (stage === "implement") { fs.writeFileSync(path.join(cwd, "source"), "updated"); git(cwd, "commit", "-am", "Candidate"); }
      return { status: "complete" as const, summary: "Evidence", commit: git(cwd, "rev-parse", "HEAD"), evidence: ["Inspected exact candidate"] };
    };
    const first = await runWorkflow(input, worker, () => {});
    assert.equal(first.status, "partial"); assert.equal(first.qualification, "unqualified");
    assert.equal(first.validation.status, "not_configured");
    const configured = loadConfig(root, { userFile: path.join(directory, "absent"), invocation: { jobs: { implementation: { validation: { checks: {
      focused: { command: "test \"$(cat source)\" = updated", scope: "Check fixture content", boundary: "isolated", timeout_ms: 1000 },
    } } } } } });
    calls.length = 0;
    const continued = await runWorkflow({ ...input, resolved: configured, base, candidate: first.candidate }, worker, () => {});
    assert.equal(continued.status, "complete"); assert.equal(continued.qualification, "checks_passed");
    assert.equal(continued.candidate, first.candidate); assert.deepEqual(calls, ["review", "qa"]);
  } finally { fs.rmSync(directory, { recursive: true }); }
});


test("nested validation preserves cwd and failed receipts without dirtying the candidate", async () => {
  const { root, directory } = fixture();
  try {
    fs.mkdirSync(path.join(root, "agent"));
    fs.writeFileSync(path.join(root, "agent/marker"), "nested");
    git(root, "add", "agent"); git(root, "commit", "-m", "Nested package");
    const candidate = git(root, "rev-parse", "HEAD");
    const failed = await executeCheck(root, { ...spec, cwd: "agent", command: "cat marker; exit 7" });
    assert.equal(failed.status, "fail");
    assert.equal(readCheck(root, failed.id).exit_code, 7);
    assert.equal(readCheck(root, failed.id).cwd, path.join(root, "agent"));
    assert.equal(fs.readFileSync(path.join(root, failed.output), "utf8"), "nested");
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(fs.existsSync(path.join(root, "agent/.cache")), false);
    const shells = fs.readdirSync(path.join(root, ".cache/piccolo/shell"));
    assert.equal(shells.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".cache/piccolo/shell", shells[0], "receipt.json"), "utf8")).exitCode, 7);
    const later = await executeCheck(root, { ...spec, check: "later", cwd: "agent", command: "cat marker" });
    assert.equal(later.status, "pass");
    assert.equal(assessChecks(root, candidate, ["focused", "later"], [failed.id, later.id]).status, "incomplete");
    const dirty = await executeCheck(root, { ...spec, cwd: "agent", command: "printf changed > marker" });
    assert.equal(dirty.status, "stale", "real candidate changes still invalidate validation");
  } finally { fs.rmSync(directory, { recursive: true }); }
});
