import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parse } from "smol-toml";
import { digest, packageRoot } from "./config.ts";
import { evaluateRoadmap } from "./roadmap.ts";
import { git, requireCandidate } from "./workflow.ts";
import { selectWorktreePath } from "./worktree-placement.ts";
import { preflightWorktree } from "./worktree-preflight.ts";

const name = z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const scheduleSchema = z.strictObject({
  format: z.literal(1), max_active: z.number().int().min(1).max(8).default(2),
  max_launches: z.number().int().min(1).max(10000).default(1000),
  timeout_ms: z.number().int().min(1000).max(86400000).default(3600000),
  tasks: z.record(name, z.strictObject({ task: z.string().min(1).max(32000), worktree: z.string().min(1), branch: z.string().min(1),
    job: z.string().default("implementation"), attempt: z.number().int().min(1).default(1), base: z.string().optional(),
    max_revisions: z.number().int().min(0).max(20).default(3), overrides_toml: z.string().max(32000).optional(),
  })),
});
export type Schedule = z.infer<typeof scheduleSchema>;
type Task = Schedule["tasks"][string];
export type Execution = Task & { base: string };
export type ExecutionResult = { status: string; candidate: string; branch: string; worktree: string; record: string };
export type Executor = (task: Execution, signal: AbortSignal) => Promise<ExecutionResult>;

function safe(root: string, relative: string, create = false) {
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (!part || part === "." || part === "..") throw new Error("Invalid scheduler record path");
    current = path.join(current, part);
    if (create) { try { fs.mkdirSync(current); } catch (e: any) { if (e.code !== "EEXIST") throw e; } }
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Scheduler paths must not be symlinked"); }
    catch (e: any) { if (e.code !== "ENOENT") throw e; }
  }
  return current;
}
function read(file: string) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Scheduler record must be a bounded regular file");
    const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 8 * 1024 * 1024) throw new Error("Scheduler record grew past limit");
    return buffer.subarray(0, length).toString("utf8");
  } finally { fs.closeSync(fd); }
}
function writeNew(file: string, value: unknown) {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); fs.linkSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function readSchedule(root: string) {
  root = fs.realpathSync(root);
  return scheduleSchema.parse(parse(read(safe(root, ".piccolo/schedule.toml"))));
}
function roadmap(root: string) {
  const bytes = read(safe(root, ".piccolo/roadmap.json"));
  return { bytes, value: evaluateRoadmap(root, JSON.parse(bytes)) };
}
export function inspectSchedule(root: string) {
  root = fs.realpathSync(root); const plan = readSchedule(root); const current = roadmap(root);
  const records = safe(root, ".piccolo/schedules"); const claims = [];
  if (fs.existsSync(records)) {
    const names = fs.readdirSync(records).filter(name => /^[a-f0-9]{64}$/.test(name));
    if (names.length > 10000) throw new Error("Scheduler history limit; archive explicitly");
    for (const id of names) {
      const dir = safe(root, `.piccolo/schedules/${id}`);
      const launch = JSON.parse(read(path.join(dir, "launch.json")));
      if (launch.format !== 1 || !name.safeParse(launch.task_id).success || !Number.isInteger(launch.attempt) || launch.attempt < 1 || digest({ task: launch.task_id, attempt: launch.attempt }) !== id) throw new Error("Invalid retained schedule claim identity");
      const outcome = path.join(dir, "outcome.json"); let status = "unresolved";
      if (fs.existsSync(outcome)) {
        const value = JSON.parse(read(outcome));
        if (value.format !== 1 || value.task !== launch.task_id || !["complete", "blocked", "challenge", "needs_parent"].includes(value.status)) throw new Error("Invalid retained schedule outcome; reconcile before admission");
        status = value.status;
      }
      claims.push({ id, task: launch.task_id, attempt: launch.attempt, status });
    }
  }
  return { plan_digest: digest(plan), readiness: current.value, claims, note: "Unresolved claims are never automatically retried. The parent must reconcile them before choosing a new attempt." };
}
export async function acquireScheduleLock(root: string, controller: AbortController) {
  const directory = safe(root, ".piccolo/schedules", true);
  const child = spawn("python3", [path.join(packageRoot, "scripts/schedule-lock.py"), path.join(directory, "coordinator.lock")], { stdio: ["pipe", "pipe", "pipe"] });
  let closing = false;
  child.once("exit", () => { if (!closing) controller.abort(new Error("Scheduler coordinator lock lost")); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ""; let diagnostic = "";
      const timer = setTimeout(() => reject(new Error("Scheduler lock handshake timed out")), 5000);
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.once("error", finish); child.once("exit", () => finish(new Error(`Scheduler already owned or lock unavailable: ${diagnostic.slice(0, 500)}`)));
      child.stderr.on("data", data => { diagnostic = (diagnostic + data.toString()).slice(-1000); });
      child.stdout.on("data", data => { output += data.toString(); if (output === "READY\n") finish(); else if (output.length > 100) finish(new Error("Invalid lock helper response")); });
    });
  } catch (error) { closing = true; child.stdin.end(); child.kill("SIGTERM"); throw error; }
  return async () => { closing = true; child.stdin.end(); await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 2000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  }); };
}

export async function runSchedule(root: string, configDigest: string, execute: Executor, signal?: AbortSignal, currentConfigDigest?: () => string) {
  root = fs.realpathSync(root);
  const plan = readSchedule(root); const initial = roadmap(root);
  if (initial.value.tasks.length > 1000) throw new Error("Schedule supports at most 1000 roadmap tasks");
  for (const [id, task] of Object.entries(plan.tasks)) {
    if (!initial.value.tasks.some(t => t.id === id)) throw new Error(`Unknown scheduled task ${id}`);
    if (!path.isAbsolute(task.worktree)) throw new Error("Scheduled worktree paths must be absolute");
    git(root, "check-ref-format", `refs/heads/${task.branch}`);
  }
  if (new Set(Object.values(plan.tasks).map(t => path.resolve(t.worktree))).size !== Object.keys(plan.tasks).length || new Set(Object.values(plan.tasks).map(t => t.branch)).size !== Object.keys(plan.tasks).length) throw new Error("Each scheduled implementation requires a distinct branch/worktree");
  const controller = new AbortController(); const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
  let release: () => Promise<void>;
  try { release = await acquireScheduleLock(root, controller); }
  catch (error) { signal?.removeEventListener("abort", cancel); throw error; }
  const timer = setTimeout(() => controller.abort(new Error("Scheduler time budget reached")), plan.timeout_ms);
  let current = initial; let fatal: unknown; let launched = 0;
  const outcomes: Array<{ task: string; status: string; claim: string }> = [];
  const active = new Map<string, Promise<void>>(); const seen = new Set<string>();
  const check = () => {
    if (currentConfigDigest && currentConfigDigest() !== configDigest) throw new Error("Resolved configuration changed during scheduling");
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Scheduler cancelled");
    if (read(safe(root, ".piccolo/roadmap.json")) !== current.bytes || digest(readSchedule(root)) !== digest(plan)) throw new Error("Execution documents changed outside coordinator; reconcile before continuing");
  };
  const update = (id: string, changes: object) => {
    check(); const document = JSON.parse(current.bytes); const task = document.tasks.find((t: any) => t.id === id); Object.assign(task, changes);
    const bytes = JSON.stringify(document, null, 2) + "\n";
    const file = safe(root, ".piccolo/roadmap.json"); const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
    try { fs.writeFileSync(temporary, bytes, { flag: "wx" }); check(); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    current = { bytes, value: evaluateRoadmap(root, document) };
  };
  const admission = async (id: string) => {
    const task = plan.tasks[id]; const entry = current.value.tasks.find(t => t.id === id)!;
    const dependencies = Object.fromEntries(entry.needs.map(n => [n.task, current.value.tasks.find(t => t.id === n.task)!.candidate!]));
    // A task+attempt claim is stable even if inputs drift. Changed inputs never
    // silently authorize a second execution of the same attempt.
    const claim = digest({ task: id, attempt: task.attempt }); const dir = safe(root, `.piccolo/schedules/${claim}`, true);
    if (fs.existsSync(path.join(dir, "launch.json"))) { outcomes.push({ task: id, status: "retained_claim", claim }); return; }
    check();
    writeNew(path.join(dir, "launch.json"), { format: 1, task_id: id, attempt: task.attempt, inputs: task, dependencies, config_digest: configDigest, schedule_digest: digest(plan), at: new Date().toISOString() });
    launched++;
    try {
      update(id, { status: "running", recorded_dependencies: dependencies });
      let base = git(root, "rev-parse", "--verify", "--end-of-options", `${task.base ?? "HEAD"}^{commit}`);
      const missing = Object.values(dependencies).filter(sha => { try { git(root, "merge-base", "--is-ancestor", sha, base); return false; } catch { return true; } });
      if (missing.length) {
        const branch = `piccolo-integration/${claim}`, worktree = selectWorktreePath(root, branch);
        preflightWorktree(root, worktree, branch);
        git(root, "worktree", "add", "-b", branch, worktree, base);
        for (const sha of missing) { check(); git(worktree, "merge", "--no-ff", "--no-edit", sha); }
        base = git(worktree, "rev-parse", "HEAD");
      }
      check(); const result = await execute({ ...task, base }, controller.signal);
      // Preserve the actual worker result even if cancellation or external edits
      // prevent a later roadmap update. Such a gap requires parent reconciliation.
      writeNew(path.join(dir, "worker-result.json"), result);
      check(); current.value = evaluateRoadmap(root, JSON.parse(current.bytes));
      if (current.value.stale[id] || current.value.waiting[id]) throw new Error("Dependency evidence drifted during execution; revalidate candidate");
      if (result.status === "complete") {
        if (path.resolve(result.worktree) !== path.resolve(task.worktree) || result.branch !== task.branch) throw new Error("Worker returned another implementation identity");
        const common = (cwd: string) => fs.realpathSync(path.resolve(cwd, git(cwd, "rev-parse", "--git-common-dir")));
        if (common(root) !== common(result.worktree)) throw new Error("Candidate belongs to another repository");
        requireCandidate(result.worktree, result.candidate, task.branch);
        git(root, "merge-base", "--is-ancestor", base, result.candidate);
        for (const sha of Object.values(dependencies)) git(root, "merge-base", "--is-ancestor", sha, result.candidate);
      }
      const status = result.status === "complete" ? "complete" : result.status === "challenge" ? "challenge" : "blocked";
      writeNew(path.join(dir, "outcome.json"), { format: 1, task: id, status, result });
      update(id, { status, ...(status === "complete" ? { candidate: result.candidate, branch: task.branch } : {}) });
      outcomes.push({ task: id, status, claim });
    } catch (error) {
      if (!fs.existsSync(path.join(dir, "outcome.json"))) writeNew(path.join(dir, "outcome.json"), { format: 1, task: id, status: "needs_parent", error: String(error) });
      outcomes.push({ task: id, status: "needs_parent", claim });
      try { update(id, { status: "blocked" }); } catch (failure) { fatal = failure; controller.abort(failure); }
    }
  };
  try {
    const unresolved = inspectSchedule(root).claims.filter(claim => claim.status === "unresolved");
    if (unresolved.length) throw new Error("Unresolved retained claims require parent reconciliation before any new admissions");
    while (true) {
      check(); current.value = evaluateRoadmap(root, JSON.parse(current.bytes));
      for (const id of current.value.ready) {
        if (active.size >= plan.max_active || launched >= plan.max_launches) break;
        if (!plan.tasks[id] || seen.has(id)) continue;
        seen.add(id);
        const promise = admission(id).catch(error => { fatal = error; controller.abort(error); }).finally(() => active.delete(id));
        active.set(id, promise);
      }
      if (!active.size) break;
      await Promise.race(active.values());
      if (fatal) throw fatal;
    }
  } catch (error) { fatal = error; controller.abort(error); }
  finally { await Promise.allSettled(active.values()); clearTimeout(timer); signal?.removeEventListener("abort", cancel); await release(); }
  return { status: fatal || controller.signal.aborted ? "needs_parent" : "idle", launched, outcomes,
    error: fatal ? String(fatal) : controller.signal.aborted ? String(controller.signal.reason) : undefined,
    readiness: roadmap(root).value, note: "No crash replay. Retained claims and candidates require explicit parent reconciliation after uncertainty." };
}
