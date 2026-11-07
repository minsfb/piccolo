import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { parse } from "smol-toml";
import { z } from "zod";
import { digest } from "./config.ts";
import { git } from "./workflow.ts";
import { writeNew } from "./records.ts";
import { checkName, checkSpecSchema } from "./validation-schema.ts";
import { prepareWorktreeArea, worktreeName } from "./worktree-placement.ts";

const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/).refine(v => !["constructor", "prototype", "__proto__"].includes(v));
const criterion = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exact_text"), expected: z.string().max(16000) }),
  z.strictObject({ kind: z.literal("required_checks") }),
  z.strictObject({ kind: z.literal("rubric"), description: z.string().min(1).max(6000) }),
]);
export const experimentSchema = z.strictObject({
  format: z.literal(1), name: key, repetitions: z.number().int().min(2).max(20).default(3),
  tasks: z.record(key, z.strictObject({ kind: z.enum(["delegate", "workflow"]), task: z.string().min(1).max(32000),
    type: key.optional(), job: key.optional(), max_revisions: z.number().int().min(0).max(5).default(0),
    checks: z.record(checkName, checkSpecSchema).optional(), criterion,
  })),
  variants: z.record(key, z.strictObject({ profile: z.string().min(1).max(100).optional(),
    delegate_overrides_toml: z.string().max(16000).optional(), workflow_overrides_toml: z.string().max(32000).optional() })),
}).superRefine((v, ctx) => {
  const count = Object.keys(v.tasks).length * Object.keys(v.variants).length * v.repetitions;
  if (!count || count > 100) ctx.addIssue({ code: "custom", message: "Experiment requires 1..100 planned trials" });
  for (const [id, task] of Object.entries(v.tasks)) {
    if (task.kind === "delegate" && (!task.type || task.checks || task.job || task.criterion.kind === "required_checks"))
      ctx.addIssue({ code: "custom", message: `Delegate ${id} needs type; workflow checks/job are not delegate criteria` });
    if (task.kind === "workflow" && (task.type || task.criterion.kind === "exact_text" || !Object.values(task.checks ?? {}).some(c => c.required)))
      ctx.addIssue({ code: "custom", message: `Workflow ${id} requires explicit required checks and no delegate type/text criterion` });
  }
});
export type Experiment = z.infer<typeof experimentSchema>;
export type Trial = { id: string; task: string; variant: string; repetition: number; kind: "delegate" | "workflow" };
export type Plan = { format: 1; manifest: Experiment; digest: string; task_digest: string; trials: Trial[] };
export function planExperiment(value: unknown): Plan {
  const manifest = experimentSchema.parse(value); const trials: Trial[] = [];
  const variants = Object.keys(manifest.variants).sort();
  // Rotate order each repetition; serial execution avoids self-induced pool contention.
  for (let repetition = 0; repetition < manifest.repetitions; repetition++)
    for (const task of Object.keys(manifest.tasks).sort())
      for (let n = 0; n < variants.length; n++) {
        const variant = variants[(n + repetition) % variants.length];
        trials.push({ id: `${String(trials.length + 1).padStart(3, "0")}`, task, variant, repetition: repetition + 1, kind: manifest.tasks[task].kind });
      }
  return { format: 1, manifest, digest: digest(manifest), task_digest: digest(manifest.tasks), trials };
}
export function readExperiment(file: string): Plan {
  if (fs.statSync(file).size > 256000) throw new Error("Experiment manifest exceeds 256 KB");
  return planExperiment(parse(fs.readFileSync(file, "utf8")));
}
function dir(root: string, parts: string[], create = false) {
  let current = fs.realpathSync(root);
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[\\/]/.test(part)) throw new Error("Invalid experiment path");
    current = path.join(current, part);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) throw new Error("Experiment directory must be an owned regular directory");
  }
  return current;
}
function home(root: string, id: string, create = false) { z.string().uuid().parse(id); return dir(root, [".cache", "piccolo", "experiments", id], create); }
function read(file: string): any {
  const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink() || st.size > 8 * 1024 * 1024) throw new Error("Invalid or oversized experiment record");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export function experimentTrialArguments(plan: Plan, trial: Trial, workspace: string, branch: string, base: string) {
  const task = plan.manifest.tasks[trial.task], variant = plan.manifest.variants[trial.variant];
  return task.kind === "delegate" ? { type: task.type!, task: task.task, profile: variant.profile, overrides_toml: variant.delegate_overrides_toml }
    : { task: task.task, job: task.job, worktree: workspace, branch, base, max_revisions: task.max_revisions,
        validation_checks: task.checks, overrides_toml: variant.workflow_overrides_toml };
}
export type TrialOutput = { status: string; result?: any; provenance: unknown; metrics?: { usage: Record<string, number | null> | null; pool_wait_ms: number | null; source: string; run_count: number } };
function returnSourceChanged(): never { throw new Error("Experiment source changed; no further trials admitted"); }
export type ExperimentExecutor = (trial: Trial, workspace: string, branch: string, base: string, signal?: AbortSignal) => Promise<TrialOutput>;
export async function runExperiment(root: string, plan: Plan, provenance: unknown, execute: ExperimentExecutor, signal?: AbortSignal, expectedBase?: string) {
  // Every invocation owns a new UUID. Interrupted experiments remain reportable; no resume/retry API.
  plan = planExperiment(plan.manifest);
  const base = git(root, "rev-parse", "HEAD");
  if (expectedBase && base !== expectedBase) throw new Error("Source changed after experiment submission");
  if (git(root, "diff", "HEAD", "--", ":(exclude).piccolo").length) throw new Error("Commit source changes, including any prepared /.worktrees/ ignore rule, before an experiment");
  const untracked = git(root, "ls-files", "--others", "--exclude-standard").split("\n").filter(p => p && !p.startsWith(".piccolo/"));
  if (untracked.length) throw new Error("Untracked inputs outside .piccolo prevent reproducible source binding");
  const worktrees = prepareWorktreeArea(root).area;
  if (git(root, "diff", "HEAD", "--", ":(exclude).piccolo").length) throw new Error("Commit the prepared /.worktrees/ ignore rule before freezing an experiment source");
  const id = randomUUID(), directory = home(root, id, true);
  const launch = { format: 1, id, base, host: os.hostname(), platform: process.platform, node: process.version,
    created_at: new Date().toISOString(), plan, provenance };
  writeNew(path.join(directory, "launch.json"), launch);
  let interrupted = false;
  for (const trial of plan.trials) {
    if (signal?.aborted) { interrupted = true; break; }
    const location = dir(directory, [trial.id], true), started = Date.now();
    const branch = `experiment/${id}/${trial.id}`, workspace = path.join(worktrees, worktreeName(branch));
    writeNew(path.join(location, "launch.json"), { format: 1, ...trial, base, workspace, branch, started_at: new Date(started).toISOString() });
    let output: TrialOutput;
    try {
      if (git(root, "rev-parse", "HEAD") !== base || git(root, "diff", "HEAD", "--", ":(exclude).piccolo").length) returnSourceChanged();
      output = await execute(trial, workspace, branch, base, signal);
    } catch (error) { output = { status: signal?.aborted ? "cancelled" : "execution_error", result: { error: String(error) }, provenance: null }; }
    const criteria = plan.manifest.tasks[trial.task].criterion;
    let correctness: "pass" | "fail" | "unassessed" = "unassessed";
    let criterionError: string | null = null;
    if (criteria.kind === "exact_text") {
      try { correctness = output.status === "completed" && exactText(output.result) === criteria.expected ? "pass" : "fail"; }
      catch (error) { criterionError = String(error); }
    }
    if (criteria.kind === "required_checks") correctness = output.status === "complete" && output.result?.qualification === "checks_passed" ? "pass" : "fail";
    const result = { format: 1, trial, finished_at: new Date().toISOString(), elapsed_ms: Date.now() - started,
      ...output, correctness, criterion_error: criterionError, criterion: criteria, metrics: { usage: output.metrics?.usage ?? null, pool_wait_ms: output.metrics?.pool_wait_ms ?? null, source: output.metrics?.source ?? "unavailable", run_count: output.metrics?.run_count ?? 0, parent_interventions: null, retries: null },
      metric_note: "Usage is native reported, not independently metered. Cost units/pricing are not established. Null is not zero; elapsed time includes setup, queueing and review/checks." };
    writeNew(path.join(location, "outcome.json"), result);
    if (git(root, "rev-parse", "HEAD") !== base || git(root, "diff", "HEAD", "--", ":(exclude).piccolo").length || signal?.aborted || output.status === "interrupted" || output.status === "unresolved" || output.status === "source_changed") { interrupted = true; break; }
  }
  writeNew(path.join(directory, "outcome.json"), { format: 1, id, status: interrupted ? "interrupted" : "completed", finished_at: new Date().toISOString() });
  const report = reportExperiment(root, id);
  return { status: interrupted ? "interrupted" : "completed", id, record: directory, report };
}
export function assessExperiment(root: string, id: string, input: unknown) {
  const value = z.strictObject({ trial: z.string().regex(/^\d{3}$/), outcome_digest: z.string().regex(/^[a-f0-9]{64}$/),
    verdict: z.enum(["pass", "fail", "uncertain"]), assessor: z.string().min(1).max(500),
    provenance: z.enum(["human_reported", "agent_reported"]), evidence: z.array(z.string().min(1).max(2000)).min(1).max(20), note: z.string().min(1).max(6000) }).parse(input);
  const directory = home(root, id), outcome = read(path.join(dir(directory, [value.trial]), "outcome.json"));
  if (digest(outcome) !== value.outcome_digest) throw new Error("Assessment binds a different outcome");
  if (outcome.criterion.kind !== "rubric") throw new Error("Only rubric criteria accept reported assessments; deterministic outcomes cannot be waived");
  // Reported assessments never replace execution status or pretend to be harness execution.
  const file = path.join(directory, value.trial, "assessment.json");
  writeNew(file, { format: 1, ...value, at: new Date().toISOString() }); return { record: file };
}
export function reportExperiment(root: string, id: string) {
  const directory = home(root, id), launch = read(path.join(directory, "launch.json"));
  const plan = planExperiment(launch.plan.manifest);
  if (plan.digest !== launch.plan.digest) throw new Error("Experiment manifest digest mismatch");
  const trials = plan.trials.map(trial => {
    const location = path.join(directory, trial.id);
    if (!fs.existsSync(location)) return { ...trial, status: "not_started", correctness: "unassessed", elapsed_ms: null, outcome_digest: null, assessment: null, metrics: null };
    dir(directory, [trial.id]);
    const file = path.join(location, "outcome.json");
    if (!fs.existsSync(file)) return { ...trial, status: "unresolved", correctness: "unassessed", elapsed_ms: null, outcome_digest: null, assessment: null, metrics: null };
    const result = read(file), hash = digest(result);
    if (digest(result.trial) !== digest(trial)) throw new Error("Trial identity mismatch");
    const assessment = fs.existsSync(path.join(location, "assessment.json")) ? read(path.join(location, "assessment.json")) : null;
    if (assessment && assessment.outcome_digest !== hash) throw new Error("Stale assessment");
    return { ...trial, status: result.status, correctness: result.correctness, elapsed_ms: result.elapsed_ms,
      outcome_digest: hash, assessment, provenance: result.provenance, metrics: result.metrics, record: file };
  });
  const groups = Object.keys(plan.manifest.tasks).sort().flatMap(task => Object.keys(plan.manifest.variants).sort().map(variant => {
    const sample = trials.filter(t => t.task === task && t.variant === variant);
    const times = sample.map(t => t.elapsed_ms).filter((t): t is number => typeof t === "number").sort((a,b) => a-b);
    const midpoint = Math.floor(times.length / 2);
    return { task, variant, planned: sample.length, terminal: sample.filter(t => !["not_started", "unresolved"].includes(t.status)).length,
      correctness_pass: sample.filter(t => t.correctness === "pass").length, correctness_fail: sample.filter(t => t.correctness === "fail").length,
      correctness_unassessed: sample.filter(t => t.correctness === "unassessed").length,
      reported_pass: sample.filter(t => t.assessment?.verdict === "pass").length,
      latency_samples: times.length, median_elapsed_ms: times.length ? (times.length % 2 ? times[midpoint] : (times[midpoint-1]+times[midpoint])/2) : null,
      elapsed_ms: times, usage_samples: sample.filter(t => t.metrics?.usage != null).length, usage: sample.every(t => t.metrics?.usage != null) ? sumUsage(sample.map(t => t.metrics!.usage)) : null, parent_interventions: null, retries: null };
  }));
  return { format: 1, id, name: plan.manifest.name, base: launch.base, task_digest: plan.task_digest, manifest_digest: plan.digest,
    execution: fs.existsSync(path.join(directory, "outcome.json")) ? read(path.join(directory, "outcome.json")).status : "unresolved",
    provenance: launch.provenance, host: launch.host, platform: launch.platform, node: launch.node, groups, trials,
    qualification: "comparison_only", note: "Completed experiment means trials settled, not correctness or statistical superiority. Serial rotated order; no significance or cost claim. Reported rubric assessments stay separate. Missing metrics are null." };
}
export function compareExperiments(root: string, ids: string[]) {
  if (ids.length < 2 || ids.length > 20 || new Set(ids).size !== ids.length) throw new Error("Compare 2..20 distinct experiment IDs");
  const reports = ids.map(id => reportExperiment(root, id));
  if (reports.some(r => r.base !== reports[0].base || r.task_digest !== reports[0].task_digest)) throw new Error("Comparison requires identical base, tasks and correctness criteria");
  return { comparable_inputs: true, reports, note: "Compare runtime/configuration provenance before interpreting differences. Repetition counts and variants may differ; no pooled winner or significance claim." };
}

export function exactText(result: any): string | undefined {
  if (!result?.artifact) return result?.result?.text;
  const file = result.artifact.path;
  const raw = read(file);
  if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== result.artifact.sha256) throw new Error("Full result artifact hash mismatch");
  return raw.result?.text;
}
export function sumUsage(samples: Array<Record<string, number | null>>) {
  return Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "turns", "toolCalls", "durationMs", "cost"].map(key =>
    [key, samples.length && samples.every(s => typeof s[key] === "number" && Number.isFinite(s[key]) && s[key]! >= 0) ? samples.reduce((n,s) => n + s[key]!, 0) : null]));
}
export function experimentMetrics(root: string, result: any, kind: "delegate" | "workflow") {
  const records: any[] = [];
  if (kind === "delegate" && result?.record) records.push(read(result.record));
  else if (kind === "workflow" && result?.id) {
    const runs = path.join(root, ".piccolo/runs");
    const inventory = new Map<string, any>();
    const names = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
    if (names.length > 10000) throw new Error("Run inventory exceeds experiment metric bound");
    for (const id of names) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const launch = read(path.join(runs, id, "launch.json"));
      inventory.set(id, launch);
    }
    const owned = new Set<string>([result.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, launch] of inventory) if (!owned.has(id) && owned.has(launch.parent_run_id)) { owned.add(id); changed = true; }
    }
    for (const id of owned) {
      if (id === result.id) continue;
      const file = path.join(runs, id, "outcome.json");
      records.push(fs.existsSync(file) ? read(file) : {});
    }
  }
  return { usage: records.length && records.every(r => r.native?.usage) ? sumUsage(records.map(r => r.native.usage)) : null,
    pool_wait_ms: records.length && records.every(r => typeof r.native?.pool_wait_ms === "number") ? records.reduce((n,r)=>n+r.native.pool_wait_ms,0) : null,
    source: "native_reported", run_count: records.length };
}
