import test from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "../src/workflow.ts";
import { planExperiment, runExperiment, reportExperiment, assessExperiment, compareExperiments, experimentTrialArguments, sumUsage, exactText, experimentMetrics } from "../src/experiments.ts";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-experiment-"));
  git(root, "init"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
  fs.writeFileSync(path.join(root, ".gitignore"), ".cache/\n.pi/\n/.worktrees/\n"); fs.writeFileSync(path.join(root, "input.txt"), "fixture\n");
  git(root, "add", "."); git(root, "commit", "-m", "fixture"); return root;
}
const manifest = () => ({ format: 1, name: "baseline", repetitions: 2,
  tasks: { read: { kind: "delegate", type: "summarizer", task: "Read input", criterion: { kind: "exact_text", expected: "fixture" } } }, variants: { a: {}, b: {} } });
const good = async () => ({ status: "completed", result: { result: { kind: "text", text: "fixture" } }, provenance: { model: "test/model" } });
test("strict manifest fixes criteria and balances repeated variant order", () => {
  const plan = planExperiment(manifest()); assert.deepEqual(plan.trials.map(t => t.variant), ["a", "b", "b", "a"]);
  assert.throws(() => planExperiment({ ...manifest(), surprise: true }));
  assert.throws(() => planExperiment({ ...manifest(), repetitions: 1 }));
  assert.throws(() => planExperiment({ ...manifest(), variants: {} }));
  const m: any = manifest(); m.tasks.read.kind = "workflow"; assert.throws(() => planExperiment(m));
  assert.equal(experimentTrialArguments(plan, plan.trials[0], "/work", "b", "sha").task, "Read input");
});
test("all planned trials remain denominators; command completion is not quality", async () => {
  const root = fixture();
  try {
    let calls = 0;
    const run = await runExperiment(root, planExperiment(manifest()), {}, async () => {
      calls++; return calls === 2 ? { status: "execution_error", result: { error: "unavailable" }, provenance: {} } : calls === 3 ? { status: "completed", result: { result: { text: "wrong" } }, provenance: {} } : good();
    });
    assert.equal(calls, 4); assert.equal(run.report.groups.reduce((n,g)=>n+g.correctness_pass,0),2);
    assert.equal(run.report.groups.reduce((n,g)=>n+g.correctness_fail,0),2);
    assert.equal(run.report.groups[0].usage,null); assert.equal(run.report.qualification,"comparison_only");
    assert.equal(git(root,"status","--porcelain"),"");
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test("cancellation stops admission without dropping unstarted trials or reusing IDs", async () => {
  const root = fixture();
  try {
    const control = new AbortController();
    const first = await runExperiment(root,planExperiment(manifest()),{},async()=>{control.abort();return good();},control.signal);
    assert.equal(first.status,"interrupted"); assert.equal(first.report.trials.filter(t=>t.status==="not_started").length,3);
    const second = await runExperiment(root,planExperiment(manifest()),{},good); assert.notEqual(first.id,second.id);
    const comparison=compareExperiments(root,[first.id,second.id]);assert.equal(comparison.comparable_inputs,true);
    const m=manifest();m.tasks.read.task="Different input";
    const different=await runExperiment(root,planExperiment(m),{},good);
    assert.throws(()=>compareExperiments(root,[first.id,different.id]),/identical/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test("rubric assessments bind exact outcome and cannot waive deterministic failures", async () => {
  const root=fixture();
  try {
    const m:any=manifest();m.tasks.read.criterion={kind:"rubric",description:"An independent reviewer checks accuracy"};
    const run=await runExperiment(root,planExperiment(m),{},good);
    assert.equal(run.report.groups[0].correctness_unassessed,2);
    const input={trial:"001",outcome_digest:run.report.trials[0].outcome_digest,verdict:"pass",assessor:"human",provenance:"human_reported",evidence:["review.md"],note:"Reviewed output"};
    assert.throws(()=>assessExperiment(root,run.id,{...input,outcome_digest:"a".repeat(64)}),/different outcome/);
    assessExperiment(root,run.id,input);const report=reportExperiment(root,run.id);
    assert.equal(report.groups[0].reported_pass,1);assert.equal(report.groups[0].correctness_pass,0);
    assert.throws(()=>assessExperiment(root,run.id,input),/EEXIST/);
    const exact=await runExperiment(root,planExperiment(manifest()),{},good);
    assert.throws(()=>assessExperiment(root,exact.id,{...input,outcome_digest:exact.report.trials[0].outcome_digest}),/rubric/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test("source drift and untrusted paths never launch further trials", async () => {
  const root=fixture();
  try {
    await assert.rejects(runExperiment(root,planExperiment(manifest()),{},good,undefined,"a".repeat(40)),/Source changed/);
    let count=0;
    const run=await runExperiment(root,planExperiment(manifest()),{},async()=>{count++;fs.writeFileSync(path.join(root,"input.txt"),"changed");return good();});
    assert.equal(count,1);assert.equal(run.report.trials.filter(t=>t.status==="not_started").length,3);
    assert.throws(()=>reportExperiment(root,"../escape"));
    git(root,"checkout","--","input.txt");
    const dir=path.join(root,".cache/piccolo/experiments",run.id,"001");
    const file=path.join(dir,"outcome.json");fs.renameSync(file,file+".saved");fs.symlinkSync(file+".saved",file);
    assert.throws(()=>reportExperiment(root,run.id),/Invalid/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("reported usage totals preserve missing measurements instead of zero filling", () => {
  const all=sumUsage([{input:10,output:2},{input:20,output:3}]);assert.equal(all.input,30);assert.equal(all.output,5);assert.equal(all.cost,null);
  assert.equal(sumUsage([{input:10},{input:null}]).input,null);
  assert.equal(sumUsage([{input:-1}]).input,null);
});

test("exact criteria use full retained output, not presentation truncation", async () => {
  const root=fixture();
  try {
    const native={result:{text:"x".repeat(13000)}};
    const file=path.join(root,".cache","full.json");fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,JSON.stringify(native));
    const {createHash}=await import("node:crypto");
    const artifact={path:file,sha256:createHash("sha256").update(fs.readFileSync(file)).digest("hex")};
    assert.equal(exactText({result:{text:"truncated"},artifact}),native.result.text);
    assert.throws(()=>exactText({artifact:{...artifact,sha256:"a".repeat(64)}}),/hash/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test("workflow usage includes transitively owned report repair runs", () => {
  const root=fixture();
  try {
    const parent="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", child="bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    for (const [id,owner] of [[parent,"workflow"],[child,parent]]) {
      const dir=path.join(root,".piccolo/runs",id);fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,"launch.json"),JSON.stringify({parent_run_id:owner}));
      fs.writeFileSync(path.join(dir,"outcome.json"),JSON.stringify({native:{usage:{input:10},pool_wait_ms:2}}));
    }
    const metrics=experimentMetrics(root,{id:"workflow"},"workflow");
    assert.equal(metrics.run_count,2);assert.equal(metrics.usage?.input,20);assert.equal(metrics.pool_wait_ms,4);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("unresolved cancellation prevents admission even without parent abort", async () => {
  const root=fixture();
  try {
    let calls=0;
    const result=await runExperiment(root,planExperiment(manifest()),{},async()=>{calls++;return {status:"unresolved",result:{status:"blocked"},provenance:{}};});
    assert.equal(calls,1);assert.equal(result.status,"interrupted");assert.equal(result.report.trials.filter(t=>t.status==="not_started").length,3);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

 test("CLI drains large reports through a pipe before exiting", async () => {
  const root=fixture();
  try {
    const run=await runExperiment(root,planExperiment(manifest()),{large:"x".repeat(200000)},good);
    const output=execFileSync(process.execPath,[path.resolve("bin/piccolo.mjs"),"experiment","report","--id",run.id,"--cwd",root],{encoding:"utf8",maxBuffer:2000000});
    const report=JSON.parse(output);assert.equal(report.provenance.large.length,200000);assert.equal(report.trials.length,4);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
