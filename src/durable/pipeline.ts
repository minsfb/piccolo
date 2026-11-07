import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { defineTask, type TaskId } from "@earendil-works/pi-durable";
import type { z } from "zod";
import type { pipelineSchema } from "./contract.ts";
import type { createWorkflowTask } from "./workflow.ts";
import type { createStageTask } from "./stage.ts";
import { git, requireCandidate } from "../workflow.ts";
import { preflightWorktree } from "../worktree-preflight.ts";
import { compareTrials } from "./comparison.ts";
import { digest } from "../config.ts";
import { assessChecks } from "../validation.ts";
import { selectWorktreePath } from "../worktree-placement.ts";

export type PipelineSpec = z.infer<typeof pipelineSchema>;
type Node = PipelineSpec["nodes"][string];
type NodeInput = { node: Node; dependencies: string[]; source?: PipelineSpec["source"] };
type NodeState = { phase: "prepare" } | { phase: "preparing" } | { phase: "join"; child: TaskId; startedAt: number };
type NodeResult = { elapsedMs?: number; status: "complete" | "needs_parent"; result: any; correctness: "pass" | "fail" | "unassessed"; criterionError?: string };
type PipelineTiming = { deadline?: number; poll?: number; pending: string[]; results: Record<string, NodeResult> };
type PipelineState = PipelineTiming & ({ phase: "start" } | { phase: "dispatch" } |
  { phase: "join"; children: Record<string, number> } | { phase: "timeout"; children: Record<string, number> });
type PipelineResult = { status: "complete" | "needs_parent"; results: Record<string, NodeResult>; pending: string[]; timedOut?: boolean; error?: string; comparison?: ReturnType<typeof compareTrials> };

export function sourceDigest(file: string) { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
export function requirePipelineSource(source: PipelineSpec["source"]) {
  if (git(source.root, "rev-parse", "HEAD") !== source.base || git(source.root, "diff", "HEAD", "--", ":(exclude).piccolo")) throw new Error("Pipeline source changed");
  if (git(source.root, "ls-files", "--others", "--exclude-standard").split("\n").some(file => file && !file.startsWith(".piccolo/"))) throw new Error("Untracked source prevents reproducible pipeline execution");
  for (const [file, hash] of Object.entries(source.files)) if (sourceDigest(path.resolve(source.root, file)) !== hash) throw new Error("Pipeline execution inputs changed");
}

function prepareIgnoredDirectory(root: string, relative: string) {
  if (fs.realpathSync(root) !== root) throw new Error("Pipeline source root must be canonical");
  git(root, "check-ignore", "-q", "--", relative + "/");
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error: any) { if (error.code !== "EEXIST") throw error; }
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) throw new Error("Pipeline runtime paths must be real directories");
  }
  return current;
}
function prepareExperimentParent(root: string, cwd: string) {
  const relative = path.relative(root, path.dirname(cwd));
  if (/^\.cache\/piccolo\/experiments\/[a-f0-9-]{36}\/worktrees$/.test(relative)) prepareIgnoredDirectory(root, relative);
}

export function createPipelineTasks(stage: ReturnType<typeof createStageTask>, workflow: ReturnType<typeof createWorkflowTask>) {
  const nodeTask = defineTask<NodeInput, NodeState, NodeResult, {}>({
    name: "piccolo.pipeline-node", version: 1, initial: () => ({ phase: "prepare" }),
    phases: {
      async prepare(task, api, ctx) {
        const { node, dependencies } = task.input;
        const startedAt = api.now();
        await api.commit(() => ({ status: "running", checkpoint: { phase: "preparing" } }), ctx);
        try {
          const work = structuredClone(node.work);
          prepareExperimentParent(work.kind === "delegate" ? work.root : work.workflow.root, work.kind === "delegate" ? work.cwd : work.workflow.worktree);
          if (work.kind === "delegate") {
            const destination = preflightWorktree(work.root, work.cwd, work.branch);
            if (destination.worktree !== work.cwd) throw new Error("Pipeline worktree path must be canonical");
            if (task.input.source) requirePipelineSource(task.input.source);
            git(work.root, "worktree", "add", "-b", work.branch, destination.worktree, work.base);
            requireCandidate(work.cwd, work.base, work.branch);
          } else {
            const spec = work.workflow;
            const missing = dependencies.filter(sha => { try { git(spec.root, "merge-base", "--is-ancestor", sha, spec.base); return false; } catch { return true; } });
            if (missing.length) {
              const identity = digest({ worktree: spec.worktree, branch: spec.branch, base: spec.base, dependencies });
              const branch = `piccolo-integration/${identity}`;
              const cwd = selectWorktreePath(spec.root, branch);
              preflightWorktree(spec.root, cwd, branch);
              // An ignore edit must not silently change a frozen pipeline source.
              if (task.input.source) requirePipelineSource(task.input.source);
              git(spec.root, "worktree", "add", "-b", branch, cwd, spec.base);
              for (const sha of missing) git(cwd, "merge", "--no-ff", "--no-edit", sha);
              spec.base = git(cwd, "rev-parse", "HEAD");
            }
            if (!spec.candidate) preflightWorktree(spec.root, spec.worktree, spec.branch);
            if (task.input.source) requirePipelineSource(task.input.source);
          }
          await api.commit(async tx => {
            const owner = { ownership: { kind: "task" as const, taskId: api.taskId } };
            const child = work.kind === "delegate" ? await tx.createTask(stage, { spec: work.stage, cwd: work.cwd }, owner) : await tx.createTask(workflow, work.workflow, owner);
            return { status: "waiting", on: [child], policy: "allSettled", checkpoint: { phase: "join", child, startedAt } };
          }, ctx);
        } catch (error) { await api.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: String(error) } } }), ctx); }
      },
      async preparing(_task, api, ctx) {
        await api.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: "Interrupted pipeline preparation or dependency merge; inspect effects before explicit reconciliation" } } }), ctx);
      },
      async join(task, api, ctx) {
        const [outcome] = await api.outcomes([task.state.checkpoint.child], ctx);
        const result: any = outcome.status === "completed" ? outcome.result : { error: outcome };
        let correctness: NodeResult["correctness"] = "unassessed";
        let criterionError: string | undefined;
        const criterion = task.input.node.criterion;
        if (criterion?.kind === "exact_text") correctness = result.status === "complete" && result.text === criterion.expected ? "pass" : "fail";
        if (criterion?.kind === "required_checks") {
          correctness = "fail";
          try {
            const work = task.input.node.work;
            if (work.kind !== "workflow") throw new Error("Required-check correctness needs a workflow with harness validation receipts");
            const required = Object.entries(work.workflow.checks).filter(([, spec]) => spec.required).map(([name]) => name);
            if (!required.length) throw new Error("Required-check correctness needs at least one configured required check");
            if (result.status !== "complete") throw new Error("Workflow did not complete its required validation");
            const assessment = assessChecks(work.workflow.worktree, result.candidate, required, result.checks ?? []);
            if (assessment.status !== "complete") throw new Error(`Required-check evidence is ${assessment.status}: ${assessment.missing.join(", ")}`);
            correctness = "pass";
          } catch (error) { criterionError = String(error).slice(0, 1000); }
        }
        const status = result.status === "complete" && correctness !== "fail" ? "complete" : "needs_parent";
        await api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status, result, correctness, ...(criterionError ? { criterionError } : {}), elapsedMs: api.now() - task.state.checkpoint.startedAt } } }), ctx);
      },
    },
    async abort(_task, api, ctx) { await api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
  });
  const pipelineTask = defineTask<PipelineSpec, PipelineState, PipelineResult, {}>({
    name: "piccolo.pipeline", version: 1,
    initial: input => ({ phase: "start", pending: Object.keys(input.nodes), results: {} }),
    phases: {
      async start(task, api, ctx) {
        await api.commit(() => ({ status: "running", checkpoint: { ...task.state.checkpoint, phase: "dispatch",
          ...(task.input.timeoutMs ? { deadline: api.now() + task.input.timeoutMs } : {}) } }), ctx);
      },
      async dispatch(task, api, ctx) {
        const state = task.state.checkpoint;
        if (state.deadline !== undefined && api.now() >= state.deadline) {
          await api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: "needs_parent", results: state.results, pending: state.pending, timedOut: true } } }), ctx); return;
        }
        try {
          requirePipelineSource(task.input.source);
          const failed = Object.values(state.results).some(result => result.status !== "complete");
          const ready = state.pending.filter(id => task.input.nodes[id].needs.every(need => state.results[need]?.status === "complete")).slice(0, task.input.maxActive);
          if (!ready.length || (failed && task.input.failFast)) {
            await api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: state.pending.length || failed ? "needs_parent" : "complete", results: state.results, pending: state.pending,
              ...(task.input.experiment ? { comparison: compareTrials(task.input, state.results) } : {}) } } }), ctx); return;
          }
          const planned = ready.map(id => {
            const node = task.input.nodes[id], dependencies = [...node.dependencies, ...node.needs.map(need => state.results[need].result.candidate).filter(Boolean)];
            for (const [need, target] of Object.entries(node.merges)) {
              const sha = state.results[need]?.result.candidate ?? need;
              const merged = git(task.input.source.root, "rev-parse", "--verify", "--end-of-options", `${target}^{commit}`);
              git(task.input.source.root, "merge-base", "--is-ancestor", sha, merged);
            }
            return { id, node, dependencies };
          });
          await api.commit(async tx => {
            if (state.deadline !== undefined && api.now() >= state.deadline) return { status: "terminal", outcome: { status: "completed", result: { status: "needs_parent", results: state.results, pending: state.pending, timedOut: true } } };
            const children: Record<string, number> = {};
            for (const { id, node, dependencies } of planned) children[id] = await tx.createTask(nodeTask, { node, dependencies, source: task.input.source }, { ownership: { kind: "task", taskId: api.taskId } });
            // Running join checkpoints permit an aggregate deadline while children
            // remain live. The absolute deadline survives process restart.
            const checkpoint: PipelineState = { ...state, phase: "join", children };
            return state.deadline === undefined ? { status: "waiting", on: Object.values(children) as TaskId[], policy: "allSettled", checkpoint }
              : { status: "running", checkpoint };
          }, ctx);
        } catch (error) {
          await api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: "needs_parent", results: state.results, pending: state.pending, error: String(error).slice(0, 1000) } } }), ctx);
        }
      },
      async join(task, api, ctx) {
        const state = task.state.checkpoint;
        const records = await Promise.all(Object.values(state.children).map(id => api.getTask(id as TaskId, ctx)));
        if (records.some(record => !record)) {
          await Promise.all(records.filter(record => !!record).map(record => api.abortOwned(record!.id, ctx)));
          await api.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: "A persisted pipeline child is missing; reconcile its retained state" } } }), ctx); return;
        }
        if (records.some(record => record?.state.status !== "terminal")) {
          const settled = Promise.all(Object.values(state.children).map(id => api.waitForTask(id as TaskId, ctx))).then(() => "settled" as const);
          const ready = state.deadline === undefined ? await settled : await Promise.race([settled, api.sleep(state.deadline, ctx).then(() => "timeout" as const)]);
          if (ready === "timeout") {
            await api.commit(() => ({ status: "running", checkpoint: { ...state, phase: "timeout" } }), ctx); return;
          }
        }
        const results = { ...state.results }, outcomes = await api.outcomes(Object.values(state.children) as TaskId<NodeResult>[], ctx);
        Object.keys(state.children).forEach((id, index) => { const outcome = outcomes[index]; results[id] = outcome.status === "completed" ? outcome.result : { status: "needs_parent", result: { error: outcome }, correctness: "unassessed" }; });
        await api.commit(() => ({ status: "running", checkpoint: { phase: "dispatch", ...(state.deadline !== undefined ? { deadline: state.deadline } : {}), results, pending: state.pending.filter(id => !Object.hasOwn(state.children, id)) } }), ctx);
      },
      async timeout(task, api, ctx) {
        const state = task.state.checkpoint;
        await Promise.all(Object.values(state.children).map(id => api.abortOwned(id as TaskId, ctx)));
        const results = { ...state.results }, outcomes = await api.outcomes(Object.values(state.children) as TaskId<NodeResult>[], ctx);
        Object.keys(state.children).forEach((id, index) => { const outcome = outcomes[index]; results[id] = outcome.status === "completed" ? outcome.result : { status: "needs_parent", result: { error: outcome, timedOut: true }, correctness: "unassessed" }; });
        await api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: "needs_parent", results,
          pending: state.pending.filter(id => !Object.hasOwn(state.children, id)), timedOut: true } } }), ctx);
      },
    },
    async abort(_task, api, ctx) { await api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
  });
  return { pipelineTask, nodeTask };
}
