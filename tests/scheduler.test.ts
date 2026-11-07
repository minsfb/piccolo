import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runSchedule, inspectSchedule, type Execution, type ExecutionResult } from "../src/scheduler.ts";
import { digest } from "../src/config.ts";

function fixture(deps: Record<string, string[]> = { A: [], C: [], B: ["A"], D: ["C"], E: ["B", "D"] }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-schedule-")));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  fs.mkdirSync(path.join(root, ".piccolo")); fs.writeFileSync(path.join(root, ".gitignore"), ".cache/\n");
  const file = path.join(root, ".piccolo/roadmap.json");
  fs.writeFileSync(file, JSON.stringify({ format: 1, tasks: Object.entries(deps).map(([id, needs]) => ({ id, title: id, status: "planned", needs: needs.map(task => ({ task })) })) }));
  const plan = path.join(root, ".piccolo/schedule.toml");
  fs.writeFileSync(plan, 'format = 1\nmax_active = 2\n' + Object.keys(deps).map(id => `[tasks.${id}]\ntask = "${id}"\nbranch = "task-${id}"\nworktree = ${JSON.stringify(path.join(root, '.cache', id))}\n`).join('\n'));
  git(root, "add", "."); git(root, "commit", "-m", "base");
  const execute = async (task: Execution): Promise<ExecutionResult> => {
    git(root, "worktree", "add", "-b", task.branch, task.worktree, task.base);
    fs.writeFileSync(path.join(task.worktree, task.task + ".txt"), task.task);
    git(task.worktree, "add", task.task + ".txt"); git(task.worktree, "commit", "-m", task.task);
    return { status: "complete", candidate: git(task.worktree, "rev-parse", "HEAD"), branch: task.branch, worktree: task.worktree, record: "fixture" };
  };
  return { root, git, file, plan, execute, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test("bounded DAG joins integrate both unmerged paths and launch E once", async () => {
  const f = fixture(); let active = 0, peak = 0; const starts: string[] = [], finishes: string[] = [];
  try {
    const result = await runSchedule(f.root, "config", async task => {
      if (task.task === "E") assert.ok(finishes.includes("B") && finishes.includes("D"));
      starts.push(task.task); peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 25)); const result = await f.execute(task); active--; finishes.push(task.task); return result;
    });
    assert.equal(result.status, "idle"); assert.equal(result.launched, 5); assert.equal(peak, 2);
    assert.deepEqual(result.readiness.tasks.map(t => t.status), Array(5).fill("complete"));
    for (const id of ["A", "B", "C", "D", "E"]) assert.equal(fs.readFileSync(path.join(f.root, ".cache/E", `${id}.txt`), "utf8"), id);
    assert.equal(starts.filter(id => id === "E").length, 1);
    assert.equal((await runSchedule(f.root, "config", f.execute)).launched, 0);
    assert.equal(inspectSchedule(f.root).claims.length, 5);
  } finally { f.close(); }
});
test("retained claims never replay even if roadmap or task inputs are changed", async () => {
  const f = fixture({ A: [] });
  try {
    const claim = digest({ task: "A", attempt: 1 }); const dir = path.join(f.root, ".piccolo/schedules", claim); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "launch.json"), JSON.stringify({ format: 1, task_id: "A", attempt: 1 }));
    const result = await runSchedule(f.root, "changed-config", async () => { throw new Error("MUST NOT EXECUTE"); });
    assert.equal(result.launched, 0); assert.equal(result.status, "needs_parent"); assert.match(result.error!, /Unresolved retained claims/);
    assert.equal(inspectSchedule(f.root).claims[0].status, "unresolved");
  } finally { f.close(); }
});
test("concurrent coordinators cannot both own a roadmap", async () => {
  const f = fixture({ A: [] }); let started!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { finish = resolve; });
  try {
    const first = runSchedule(f.root, "config", async task => { started(); await gate; return f.execute(task); }); await ready;
    await assert.rejects(runSchedule(f.root, "config", f.execute), /already owned|lock unavailable/);
    finish(); assert.equal((await first).launched, 1);
  } finally { finish?.(); f.close(); }
});
test("external roadmap edits preserve worker evidence and stop downstream admission", async () => {
  const f = fixture({ A: [], B: ["A"] });
  try {
    const result = await runSchedule(f.root, "config", async task => {
      const result = await f.execute(task); const document = JSON.parse(fs.readFileSync(f.file, "utf8")); document.tasks[1].title = "operator edit"; fs.writeFileSync(f.file, JSON.stringify(document)); return result;
    });
    assert.equal(result.status, "needs_parent"); assert.equal(result.launched, 1); assert.match(result.error!, /documents changed/);
    assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).tasks[1].title, "operator edit");
    assert.ok(fs.existsSync(path.join(f.root, ".piccolo/schedules", result.outcomes[0].claim, "worker-result.json")));
  } finally { f.close(); }
});
test("cancellation prevents successors and keeps the interrupted claim", async () => {
  const f = fixture({ A: [], B: ["A"] }); const controller = new AbortController();
  try {
    const result = await runSchedule(f.root, "config", async task => { controller.abort(new Error("fixture cancel")); return { status: "interrupted", candidate: "", branch: task.branch, worktree: task.worktree, record: "fixture" }; }, controller.signal);
    assert.equal(result.status, "needs_parent"); assert.equal(result.launched, 1);
    assert.equal(inspectSchedule(f.root).claims[0].status, "needs_parent");
  } finally { f.close(); }
});
test("merge prerequisites and revised upstream candidates hold downstream work", async () => {
  const f = fixture({ A: [], B: ["A"] });
  try {
    let document = JSON.parse(fs.readFileSync(f.file, "utf8")); document.tasks[1].needs[0] = { task: "A", requires: "merge", merged_into: "main" }; fs.writeFileSync(f.file, JSON.stringify(document));
    assert.equal((await runSchedule(f.root, "config", f.execute)).launched, 1);
    assert.deepEqual(inspectSchedule(f.root).readiness.ready, []);
    const a = inspectSchedule(f.root).readiness.tasks[0]; f.git(f.root, "merge", "--no-ff", "--no-edit", a.candidate!);
    assert.equal((await runSchedule(f.root, "config", f.execute)).launched, 1);
    // An additional commit on A invalidates its recorded candidate and its dependent.
    const aPath = path.join(f.root, ".cache/A"); fs.writeFileSync(path.join(aPath, "revision"), "drift"); f.git(aPath, "add", "revision"); f.git(aPath, "commit", "-m", "revision");
    const state = inspectSchedule(f.root).readiness; assert.ok(state.stale.A); assert.ok(state.waiting.B);
  } finally { f.close(); }
});
test("launch budget and blocked outcomes hold successors", async () => {
  const f = fixture({ A: [], B: ["A"], C: [] });
  try {
    fs.appendFileSync(f.plan, '\n');
    fs.writeFileSync(f.plan, fs.readFileSync(f.plan, "utf8").replace('max_active = 2', 'max_active = 2\nmax_launches = 1'));
    const result = await runSchedule(f.root, "config", async task => ({ status: "challenge", candidate: "", branch: task.branch, worktree: task.worktree, record: "fixture" }));
    assert.equal(result.launched, 1); assert.equal(result.readiness.tasks[0].status, "challenge"); assert.ok(result.readiness.waiting.B); assert.ok(result.readiness.ready.includes("C"));
  } finally { f.close(); }
});
test("killed coordinator leaves a retained claim and releases its OS lock", async () => {
  const f = fixture({ A: [], C: [] });
  const { spawn } = await import("node:child_process");
  const source = new URL("../src/scheduler.ts", import.meta.url).href;
  const script = `import {runSchedule} from ${JSON.stringify(source)}; await runSchedule(process.argv[1],"config",async()=>{console.log("ADMITTED"); await new Promise(()=>{});});`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, f.root], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Child admission timed out")), 10000);
      // Wait for both durable admissions: killing after the first can catch the
      // second claim between directory creation and its launch-record write.
      let output = "";
      child.stdout.on("data", data => {
        output += data.toString();
        if (output.split("ADMITTED\n").length - 1 === 2) { clearTimeout(timer); resolve(); }
      }); child.once("error", reject);
    });
    const exit = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exit;
    // EOF to the lock helper releases its lock; allow that child to observe EOF.
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = await runSchedule(f.root, "config", async () => { throw new Error("MUST NOT REPLAY"); });
    assert.equal(result.launched, 0); assert.match(result.error!, /Unresolved retained claims/);
    assert.ok(inspectSchedule(f.root).claims.some(claim => claim.status === "unresolved"));
  } finally { child.kill("SIGKILL"); f.close(); }
});
test("conflicting prerequisite branches retain integration work and block the join", async () => {
  const f = fixture({ A: [], C: [], E: ["A", "C"] });
  try {
    const result = await runSchedule(f.root, "config", async task => {
      const out = await f.execute(task);
      fs.writeFileSync(path.join(task.worktree, "shared.txt"), task.task); f.git(task.worktree, "add", "shared.txt"); f.git(task.worktree, "commit", "-m", "conflicting addition");
      return { ...out, candidate: f.git(task.worktree, "rev-parse", "HEAD") };
    });
    assert.equal(result.launched, 3); assert.equal(result.readiness.tasks.find(t => t.id === "E")!.status, "blocked");
    const join = result.outcomes.find(t => t.task === "E")!; assert.equal(join.status, "needs_parent");
    const integration = path.join(f.root, ".worktrees", `piccolo-integration-${join.claim}`);
    assert.match(f.git(integration, "status", "--porcelain"), /AA shared.txt/);
    assert.ok(!fs.existsSync(path.join(f.root, ".cache/E")));
    assert.equal((await runSchedule(f.root, "config", f.execute)).launched, 0);
  } finally { f.close(); }
});
test("malformed retained outcomes cannot authorize new work", async () => {
  const f = fixture({ A: [], C: [] });
  try {
    const claim = digest({ task: "A", attempt: 1 }); const dir = path.join(f.root, ".piccolo/schedules", claim); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "launch.json"), JSON.stringify({ format: 1, task_id: "A", attempt: 1 }));
    fs.writeFileSync(path.join(dir, "outcome.json"), '{}');
    const result = await runSchedule(f.root, "config", async () => { throw new Error("MUST NOT EXECUTE"); });
    assert.equal(result.launched, 0); assert.match(result.error!, /Invalid retained schedule outcome/);
  } finally { f.close(); }
});
