import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { digest, type Agent, type Resolved } from "../config.ts";
import { git, validateRecipe } from "../workflow.ts";
import { submissionSchema, type StageSpec, type Workspace, type WorkerSubmission } from "./contract.ts";
import { readExperiment, experimentTrialArguments, type Plan } from "../experiments.ts";
import { readRoadmap } from "../roadmap.ts";
import { readSchedule, inspectSchedule, type Schedule } from "../scheduler.ts";
import { sourceDigest } from "./pipeline.ts";
import type { RemoteWorker } from "./remote.ts";
import { selectWorktreePath, worktreeName, owningRepository } from "../worktree-placement.ts";

export function prepareSubmission(snapshot: any, workspace: Workspace, owner: string, remote?: { target: RemoteWorker; base: string; lifetime: "session" | "independent"; worktreeOwner?: string | null }): WorkerSubmission {
  const resolved: Resolved = snapshot.resolved;
  const executionRoot = remote?.target.workspace.cwd ?? workspace.cwd;
  const remap = (file: string) => remote && (file === workspace.cwd || file.startsWith(workspace.cwd + path.sep)) ? executionRoot + file.slice(workspace.cwd.length) : file;
  // Parent/native compaction and child-extension settings govern the interactive
  // Pi instance. Durable worker policy is selected by its own host configuration.
  const spec = (agent: Agent, name: string, task: string): StageSpec => {
    const model = agent.model ?? snapshot.parent.model;
    if (!model) throw new Error("Worker model is required");
    const slash = model.indexOf("/");
    if (slash < 1) throw new Error("Expected provider/model");
    return { name, task, model: { provider: model.slice(0, slash), modelId: model.slice(slash + 1) },
      instructions: agent.prompt ?? "", skills: agent.skills ?? [],
      tools: agent.tools ?? [], thinkingLevel: agent.effort ?? snapshot.parent.effort, report: false, timeoutMs: agent.timeout_ms ?? 900000,
      ...(agent.requirements ? { requirements: agent.requirements } : {}),
      ...(agent.context === "fork" ? { context: snapshot.context ?? [] } : {}) };
  };
  const envelope = { version: 1 as const, registry: "piccolo-1" as const, requestId: randomUUID(), workspace, lifetime: remote?.lifetime ?? "session" as const, owner, configDigest: resolved.digest,
    ...(remote ? { placement: remote.target } : {}) };
  if (snapshot.kind === "delegate") {
    const cwd = remap(snapshot.parent.cwd ?? workspace.cwd);
    const origin = { ...(snapshot.arguments.task_id ? { taskId: snapshot.arguments.task_id } : {}), ...(snapshot.arguments.parent_run_id ? { parentRunId: snapshot.arguments.parent_run_id } : {}) };
    return submissionSchema.parse({ ...envelope, kind: "delegate", ...(cwd !== executionRoot ? { cwd } : {}),
      ...(Object.keys(origin).length ? { origin } : {}), stage: spec(snapshot.agents.delegate, "delegate", snapshot.arguments.task) });
  }
  const workflow = (args: any, key: string, config: Resolved, executionWorktree?: string) => {
    const recipe = validateRecipe(config, args.job || "implementation");
    const stages = Object.fromEntries(Object.entries(recipe).map(([stage, value]) => [stage,
      value.agents!.map(type => spec(snapshot.agents[`${key}/${stage}/${type}`], `${stage}:${type}`, value.task ?? `Perform ${stage} for the original task.`))]));
    if (args.candidate && !args.worktree) throw new Error("Candidate continuation requires its explicit existing worktree");
    let worktree: string;
    if (remote) {
      if (args.worktree !== undefined) {
        if (!path.isAbsolute(args.worktree)) throw new Error("Worktree path must be absolute");
        worktree = executionWorktree ?? remap(path.normalize(args.worktree));
      } else {
        if (!remote.worktreeOwner || !path.isAbsolute(remote.worktreeOwner)) throw new Error("Remote worker has no qualified primary Git checkout; choose an explicit worktree destination or update its Piccolo runtime");
        worktree = path.join(remote.worktreeOwner, ".worktrees", worktreeName(args.branch));
      }
    } else worktree = selectWorktreePath(workspace.cwd, args.branch, args.worktree, args.candidate);
    const base = remote ? args.base ?? remote.base : git(workspace.cwd, "rev-parse", "--verify", "--end-of-options", `${args.base ?? "HEAD"}^{commit}`);
    if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error("Remote workflow needs an exact base commit available on its worker");
    return { root: executionRoot, worktree, branch: args.branch,
      base, ...(args.candidate ? { candidate: args.candidate } : {}),
      task: args.task, maxRevisions: args.max_revisions ?? 3, stages, checks: config.config.jobs?.[args.job || "implementation"]?.validation?.checks ?? {},
      validationMode: config.config.jobs?.[args.job || "implementation"]?.validation?.mode ?? "required" };
  };
  if (snapshot.kind === "workflow") return submissionSchema.parse({ ...envelope, kind: "workflow", workflow: workflow(snapshot.arguments, "workflow", resolved) });
  const nodes: Record<string, unknown> = {};
  const files: Record<string, string> = {};
  let maxActive = 1;
  const base = snapshot.experimentBase ?? git(workspace.cwd, "rev-parse", "HEAD");
  if (remote && remote.base !== base) throw new Error("Remote pipeline source must match the frozen local base");
  if (snapshot.kind === "experiment") {
    const plan: Plan = snapshot.experiment;
    const owner = remote ? remote.worktreeOwner : owningRepository(workspace.cwd);
    if (!owner) throw new Error("Remote experiment needs an advertised primary Git checkout; update the worker runtime");
    const directory = path.join(owner, ".worktrees");
    files[remap(snapshot.arguments.spec)] = sourceDigest(path.resolve(workspace.cwd, snapshot.arguments.spec));
    if (digest(readExperiment(path.resolve(workspace.cwd, snapshot.arguments.spec))) !== digest(plan)) throw new Error("Experiment changed after submission");
    for (const trial of plan.trials) {
      const branch = `experiment/${envelope.requestId}/${trial.id}`, cwd = path.join(directory, worktreeName(branch));
      const args = experimentTrialArguments(plan, trial, cwd, branch, base);
      const task = plan.manifest.tasks[trial.task];
      nodes[trial.id] = { needs: [], criterion: task.criterion,
        work: trial.kind === "delegate" ? { kind: "delegate", root: executionRoot, cwd, base, branch, stage: spec(snapshot.agents[trial.id], trial.id, task.task) } :
          { kind: "workflow", workflow: workflow(args, trial.id, snapshot.configs[trial.id], remote ? cwd : undefined) } };
    }
  } else {
    const plan: Schedule = snapshot.schedule;
    const current = readRoadmap(workspace.cwd), retained = inspectSchedule(workspace.cwd);
    if (retained.claims.some(claim => claim.status === "unresolved")) throw new Error("Reconcile legacy unresolved schedule claims before Durable admission");
    files[".piccolo/schedule.toml"] = sourceDigest(path.join(workspace.cwd, ".piccolo/schedule.toml"));
    files[".piccolo/roadmap.json"] = sourceDigest(current.file);
    if (digest(readSchedule(workspace.cwd)) !== digest(plan) || digest(readRoadmap(workspace.cwd)) !== digest(current)) throw new Error("Schedule or roadmap changed after submission");
    maxActive = plan.max_active;
    const planned = current.tasks.filter(task => task.status === "planned" && plan.tasks[task.id]);
    if (planned.length > plan.max_launches) throw new Error("Schedule launch budget exceeded");
    for (const task of planned) {
      if (current.stale[task.id] || retained.claims.some(claim => claim.task === task.id && claim.attempt === plan.tasks[task.id].attempt)) throw new Error("Retained/stale task attempt requires explicit reconciliation");
      const needs: string[] = [], dependencies: string[] = [], merges: Record<string, string> = {};
      for (const need of task.needs) {
        const upstream = current.tasks.find(task => task.id === need.task)!;
        if (upstream.status === "planned" && plan.tasks[upstream.id]) needs.push(upstream.id);
        else if (upstream.status === "complete" && upstream.candidate && !current.stale[upstream.id] && !current.waiting[upstream.id]) dependencies.push(upstream.candidate);
        else throw new Error(`Dependency ${upstream.id} needs parent reconciliation`);
        if (need.requires === "merge") {
          if (!need.merged_into) throw new Error("Merge prerequisite needs merged_into");
          merges[upstream.status === "complete" ? upstream.candidate! : upstream.id] = need.merged_into;
        }
      }
      nodes[task.id] = { attempt: plan.tasks[task.id].attempt, needs, dependencies, merges, work: { kind: "workflow", workflow: workflow(plan.tasks[task.id], task.id, snapshot.configs[task.id]) } };
    }
  }
  const experiment = snapshot.kind === "experiment" ? { name: snapshot.experiment.manifest.name, manifestDigest: snapshot.experiment.digest,
    taskDigest: snapshot.experiment.task_digest, trials: Object.fromEntries(snapshot.experiment.trials.map((trial: Plan["trials"][number]) => [trial.id,
      { task: trial.task, variant: trial.variant, repetition: trial.repetition, configDigest: snapshot.configs[trial.id].digest }])) } : undefined;
  return submissionSchema.parse({ ...envelope, kind: snapshot.kind, pipeline: { nodes, maxActive, source: { root: executionRoot, base, files }, failFast: snapshot.kind === "schedule", experiment, ...(snapshot.kind === "schedule" ? { timeoutMs: snapshot.schedule.timeout_ms } : {}) } });
}
