import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { SessionJobs } from "../src/session-jobs.ts";
import { git, runWorkflow, parseReport, requireCandidate } from "../src/workflow.ts";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-workflow-"));
  const root = path.join(dir, "repo"); fs.mkdirSync(root);
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Piccolo Test"); git(root, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(root, ".gitignore"), ".pi/\n.cache/\n"); git(root, "add", "."); git(root, "commit", "-m", "Initial fixture");
  return { dir, root, worktree: path.join(dir, "worker"), branch: "task/test", task: "Implement", job: "implementation", resolved: loadConfig(root, { userFile: path.join(dir, "absent.toml"), invocation: { jobs: { implementation: { validation: { mode: "reported" } } } } }), maxRevisions: 2 };
}
test("recipe revises then binds all final review and QA to a clean descendant", async () => {
  const input = fixture(); const calls: string[] = [];
  try {
    const result = await runWorkflow(input, async ({ cwd, stage, round }) => {
      calls.push(`${stage}:${round}`);
      if (stage === "implement") { fs.writeFileSync(path.join(cwd, "code.txt"), String(round)); git(cwd, "add", "code.txt"); git(cwd, "commit", "-m", `Implementation ${round}`); }
      return { status: stage === "review" && round === 0 ? "changes_requested" : "complete", summary: "Evidence", commit: git(cwd, "rev-parse", "HEAD"), evidence: ["Fixture check"] };
    }, () => {});
    assert.equal(result.status, "complete");
    assert.deepEqual(calls, ["implement:0", "review:0", "implement:1", "review:1", "qa:1"]);
    assert.equal(git(input.root, "rev-parse", "HEAD"), result.base);
    requireCandidate(input.worktree, result.candidate);
    git(input.worktree, "switch", "--detach", result.candidate);
    assert.throws(() => requireCandidate(input.worktree, result.candidate, input.branch), /detached/);
    assert.ok(fs.existsSync(path.join(result.record, "outcome.json")));
  } finally { fs.rmSync(input.dir, { recursive: true, force: true }); }
});

for (const uncertain of [false, true]) test(`session-owned workflow stop preserves ${uncertain ? "uncertainty" : "confirmed cancellation"}`, async () => {
  const input = fixture(); const jobs = new SessionJobs(input.root, "parent");
  const calls: string[] = [];
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  try {
    const id = jobs.submit("workflow", {}, execution => runWorkflow(input, async ({ stage }) => {
      calls.push(stage); started();
      await new Promise<void>(resolve => execution.signal.addEventListener("abort", () => resolve(), { once: true }));
      if (uncertain) execution.event({ kind: "cancellation_unacknowledged" });
      return { status: "blocked", summary: "Worker cancellation report", evidence: [] };
    }, () => {}, execution.signal));
    await running; jobs.stop(id); await jobs.wait(id);
    const result = jobs.result(id);
    assert.equal(result.state, uncertain ? "unresolved" : "cancelled");
    assert.equal((result.result as any).status, "interrupted");
    assert.deepEqual(calls, ["implement"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(input.root, result.record, "outcome.json"), "utf8")).state, result.state);
  } finally { await jobs.close("quit"); fs.rmSync(input.dir, { recursive: true, force: true }); }
});
test("source drift blocks completion, while a challenge remains an explicit outcome", async () => {
  for (const challenge of [false, true]) {
    const input = fixture();
    try {
      const result = await runWorkflow(input, async ({ cwd, stage }) => {
        if (challenge) return { status: "challenge", summary: "Contradictory requirements", evidence: [] };
        fs.writeFileSync(path.join(cwd, "code.txt"), stage);
        if (stage === "implement") { git(cwd, "add", "code.txt"); git(cwd, "commit", "-m", "Candidate"); }
        return { status: "complete", summary: "Evidence", commit: git(cwd, "rev-parse", "HEAD"), evidence: ["Check"] };
      }, () => {});
      assert.equal(result.status, challenge ? "challenge" : "blocked");
      if (!challenge) assert.match(result.summary, /uncommitted/);
    } finally { fs.rmSync(input.dir, { recursive: true, force: true }); }
  }
});
test("malformed success cannot become a workflow verdict", () => {
  assert.throws(() => parseReport("PASS"));
  assert.throws(() => parseReport('{"status":"success","summary":"done"}'));
  assert.equal(parseReport('```json\n{"status":"blocked","summary":"Need input"}\n```').status, "blocked");
});


test("worktree destination preflight fails before branch creation and retains collisions", async () => {
  const input = fixture();
  try {
    const blocked = await runWorkflow({ ...input, worktree: path.join(input.dir, "missing", "child") }, async () => { throw new Error("must not launch"); }, () => {});
    assert.equal(blocked.status, "blocked"); assert.match(blocked.summary, /explicit location needs an existing parent/);
    assert.equal(git(input.root, "branch", "--list", input.branch), "");
    assert.equal(fs.existsSync(path.join(input.dir, "missing")), false);
    git(input.root, "branch", input.branch);
    const collision = await runWorkflow(input, async () => { throw new Error("must not launch"); }, () => {});
    assert.equal(collision.status, "blocked"); assert.match(collision.summary, /branch already exists/);
    assert.equal(git(input.root, "rev-parse", input.branch), git(input.root, "rev-parse", "HEAD"));
    assert.equal(fs.existsSync(input.worktree), false);
  } finally { fs.rmSync(input.dir, { recursive: true, force: true }); }
});

for (const stopped of ["implement", "review", "qa"] as const) test(`cancellation after ${stopped} report remains interrupted and admits no later stage`, async () => {
  const input = fixture(); const controller = new AbortController(); const calls: string[] = [];
  try {
    const result = await runWorkflow(input, async ({ cwd, stage }) => {
      calls.push(stage);
      if (stage === "implement" && stopped !== "implement") {
        fs.writeFileSync(path.join(cwd, "code.txt"), "candidate"); git(cwd, "add", "code.txt"); git(cwd, "commit", "-m", "Candidate");
      }
      if (stage === stopped) controller.abort();
      return { status: stage === stopped ? "blocked" : "complete", summary: stage === stopped ? "Native worker cancelled" : "Evidence", commit: git(cwd, "rev-parse", "HEAD"), evidence: ["Fixture report"] };
    }, () => {}, controller.signal);
    assert.equal(result.status, "interrupted");
    assert.deepEqual(calls, ["implement", "review", "qa"].slice(0, ["implement", "review", "qa"].indexOf(stopped) + 1));
    const records = fs.readdirSync(result.record).filter(name => /^[0-9]+\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(result.record, name), "utf8")));
    assert.ok(records.some(record => record.stage === stopped && record.report.status === "blocked"), "preserve exact worker report separately from cancellation disposition");
  } finally { fs.rmSync(input.dir, { recursive: true, force: true }); }
});

for (const revision of [false, true]) test(`existing candidate continuation starts at review, revision=${revision}`, async () => {
  const input = fixture(); const calls: string[] = [];
  try {
    const base = git(input.root, "rev-parse", "HEAD");
    git(input.root, "worktree", "add", "-b", input.branch, input.worktree, base);
    fs.writeFileSync(path.join(input.worktree, "code.txt"), "candidate");
    git(input.worktree, "add", "code.txt"); git(input.worktree, "commit", "-m", "Existing candidate");
    const head = git(input.worktree, "rev-parse", "HEAD");
    const result = await runWorkflow({ ...input, base, candidate: head }, async ({ cwd, stage, round }) => {
      calls.push(`${stage}:${round}`);
      if (stage === "implement") { fs.writeFileSync(path.join(cwd, "code.txt"), "revised"); git(cwd, "commit", "-am", "Revise"); }
      return { status: revision && stage === "review" && round === 0 ? "changes_requested" : "complete", summary: "Reviewed", commit: git(cwd, "rev-parse", "HEAD"), evidence: ["Exact candidate inspected"] };
    }, (_cwd, continuing) => assert.equal(continuing, true));
    assert.equal(result.status, "complete");
    assert.deepEqual(calls, revision ? ["review:0", "implement:1", "review:1", "qa:1"] : ["review:0", "qa:0"]);
    if (!revision) assert.equal(result.candidate, head);
    assert.equal(git(input.root, "rev-parse", "HEAD"), base);
  } finally { fs.rmSync(input.dir, { recursive: true, force: true }); }
});

test("candidate continuation rejects drift and wrong ownership before any worker", async () => {
  const input = fixture();
  try {
    const base = git(input.root, "rev-parse", "HEAD");
    git(input.root, "worktree", "add", "-b", input.branch, input.worktree, base);
    fs.writeFileSync(path.join(input.worktree, "code.txt"), "candidate"); git(input.worktree, "add", "code.txt"); git(input.worktree, "commit", "-m", "Existing candidate");
    const head = git(input.worktree, "rev-parse", "HEAD");
    const worker = async (): Promise<any> => { assert.fail("must not launch"); };
    const wrong = await runWorkflow({ ...input, branch: "other", base, candidate: head }, worker, () => assert.fail("must not prepare"));
    assert.equal(wrong.status, "blocked"); assert.match(wrong.summary, /owning branch/);
    fs.writeFileSync(path.join(input.worktree, "code.txt"), "dirty");
    const dirty = await runWorkflow({ ...input, base, candidate: head }, worker, () => assert.fail("must not prepare"));
    assert.equal(dirty.status, "blocked"); assert.match(dirty.summary, /uncommitted/);
    assert.equal(fs.readFileSync(path.join(input.worktree, "code.txt"), "utf8"), "dirty");
  } finally { fs.rmSync(input.dir, { recursive: true, force: true }); }
});

test("base ignore preflight inspects chosen commit and fails before branch creation", async () => {
  const input = fixture();
  try {
    fs.writeFileSync(path.join(input.root, ".gitignore"), ".cache/\n"); git(input.root, "commit", "-am", "Missing runtime ignore");
    const badBase = git(input.root, "rev-parse", "HEAD");
    fs.appendFileSync(path.join(input.root, ".gitignore"), ".pi/\n"); git(input.root, "commit", "-am", "Fix current checkout only");
    const result = await runWorkflow({ ...input, base: badBase }, async () => { assert.fail("no worker"); }, () => assert.fail("no preparation"));
    assert.equal(result.status, "blocked"); assert.match(result.summary, /Selected upstream base does not ignore/);
    assert.equal(git(input.root, "branch", "--list", input.branch), "");
    assert.equal(fs.existsSync(input.worktree), false);
    fs.appendFileSync(path.join(input.root, ".git/info/exclude"), "\n/.pi/\n");
    const allowed = await runWorkflow({ ...input, base: badBase }, async () => ({ status: "challenge", summary: "Reached worker", evidence: [] }), () => {});
    assert.equal(allowed.status, "challenge");
  } finally { fs.rmSync(input.dir, { recursive: true, force: true }); }
});

test("rejected parallel review drains siblings before the workflow settles", async () => {
  const input=fixture();
  input.resolved.config.agents!.second={...input.resolved.config.agents!.reviewer};
  input.resolved.config.jobs!.implementation.stages!.review.agents=["reviewer","second"];
  let release!:()=>void; const hold=new Promise<void>(r=>{release=r;});
  let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
  let settled=false, drained=false;
  try {
    const running=runWorkflow(input,async ({cwd,stage,type})=>{
      if(stage==="implement") {fs.writeFileSync(path.join(cwd,"code.txt"),"candidate");git(cwd,"add","code.txt");git(cwd,"commit","-m","candidate");}
      if(stage==="review" && type==="reviewer") throw new Error("invalid final report");
      if(stage==="review" && type==="second") {started();await hold;drained=true;}
      return {status:"complete",summary:"evidence",commit:git(cwd,"rev-parse","HEAD"),evidence:["fixture"]};
    },()=>{}).then(r=>{settled=true;return r;});
    await ready;await new Promise(r=>setTimeout(r,20));assert.equal(settled,false);
    release();const result=await running;assert.equal(drained,true);assert.equal(result.status,"blocked");
  } finally {release?.();fs.rmSync(input.dir,{recursive:true,force:true});}
});
