import fs from "node:fs";
import { defineTask, type ConversationId, type TaskId, type TaskRuntime, type TaskOutcome } from "@earendil-works/pi-durable";
import { candidate, git, requireCandidate, parseReport, type Report } from "../workflow.ts";
import { preflightBaseIgnores, preflightWorktree } from "../worktree-preflight.ts";
import { executeCheck, assessChecks } from "../validation.ts";
import type { z } from "zod";
import type { workflowSchema } from "./contract.ts";
import type { createStageTask, StageResult } from "./stage.ts";
import { hasUncertainEffects } from "./effects.ts";
import { sumUsage } from "../experiments.ts";
import { workflowStagePolicy } from "../workflow-stage-policy.ts";

export type WorkflowSpec = z.infer<typeof workflowSchema>;
type Result = { status: "complete" | "needs_parent" | "interrupted"; summary: string; candidate: string; base: string; worktree: string; branch: string; checks: string[]; metrics?: { usage: Record<string, number | null> | null; source: string }; provenance?: unknown[] };
type Progress = { head: string; round: number; feedback: Report[]; checks: string[]; samples?: Array<Pick<StageResult, "metrics" | "provenance">> };
type Phase = "prepare" | "preparing" | "implement" | "review" | "qa" | "collect" | "check" | "checking";
type State = { [P in Phase]: Progress & { phase: P; stage?: "implement" | "review" | "qa"; children?: TaskId<StageResult>[]; index?: number } }[Phase];
type Runtime = TaskRuntime<WorkflowSpec, State, Result, {}>;
const finish = (input: WorkflowSpec, state: Progress, status: Result["status"], summary: string) => ({ status: "terminal" as const,
  outcome: { status: "completed" as const, result: { status, summary, candidate: state.head, base: input.base, worktree: input.worktree, branch: input.branch, checks: state.checks,
    metrics: { usage: status === "complete" && state.samples?.length && state.samples.every(sample => sample.metrics?.usage) ? sumUsage(state.samples.map(sample => sample.metrics!.usage!)) : null,
      source: "durable_conversation_reported" }, provenance: state.samples?.map(sample => sample.provenance ?? null) ?? [] } } });

/** Persist each stage admission/join and every unsafe command intent separately. */
export function createWorkflowTask(stageTask: ReturnType<typeof createStageTask>, prepare: (cwd: string) => Promise<void>) {
  async function launch(input: WorkflowSpec, state: State, api: Runtime, ctx: Parameters<Runtime["commit"]>[1], stage: "implement" | "review" | "qa") {
    if (stage !== "implement") requireCandidate(input.worktree, state.head, input.branch);
    const specs = stage === "qa" ? [input.stages.qa[state.index ?? 0]] : input.stages[stage];
    await api.commit(async tx => {
      const children: TaskId<StageResult>[] = [];
      for (const spec of specs) {
        const instruction = stage === "implement"
          ? "Implement or revise the original task. Commit intended changes. Do not push or merge. Return your committed candidate; the harness schedules independent review and QA."
          : `Independently ${stage} candidate ${state.head}. Do not modify source, commit, change branches, or reset HEAD. Report changes_requested for actionable failures.`;
        children.push(await tx.createTask(stageTask, { cwd: input.worktree, spec: { ...spec, report: true,
          instructions: workflowStagePolicy(spec.instructions, stage),
          tools: stage === "implement" ? spec.tools : spec.tools.filter(name => !["write", "edit"].includes(name)),
          task: `${instruction}\nStay on branch ${input.branch}.\nOriginal task:\n${input.task}\nStage instructions:\n${spec.task}\nBase: ${input.base}\nCandidate: ${state.head}\nRound: ${state.round}\nPrevious findings: ${JSON.stringify(state.feedback)}\nConfigured checks (the harness runs these after QA; do not duplicate): ${JSON.stringify(input.checks)}\nReturn only JSON: status (complete, changes_requested, blocked, challenge, partial), summary, commit (exact full SHA from git rev-parse HEAD), evidence (array of concise results).`,
        } }, { ownership: { kind: "task", taskId: api.taskId } }));
      }
      return { status: "waiting", on: children, policy: "allSettled", checkpoint: { ...state, phase: "collect", stage, children } };
    }, ctx);
  }
  return defineTask<WorkflowSpec, State, Result, {}>({
    name: "piccolo.workflow", version: 1,
    initial: input => ({ phase: "prepare", head: input.candidate ?? input.base, round: 0, feedback: [], checks: [] }),
    phases: {
      async prepare(task, api, ctx) {
        const input = task.input, state = task.state.checkpoint;
        // Intent is committed before worktree mutation. Restart at preparing requires reconciliation.
        await api.commit(() => ({ status: "running", checkpoint: { ...state, phase: "preparing" } }), ctx);
        try {
          if (input.candidate) {
            const common = (cwd: string) => fs.realpathSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
            if (common(input.root) !== common(input.worktree)) throw new Error("Candidate is not in this repository");
            requireCandidate(input.worktree, input.candidate, input.branch);
            git(input.worktree, "merge-base", "--is-ancestor", input.base, input.candidate);
            if (input.base === input.candidate) throw new Error("Candidate must differ from base");
          } else {
            preflightBaseIgnores(input.root, input.base);
            const target = preflightWorktree(input.root, input.worktree, input.branch);
            if (target.worktree !== input.worktree) throw new Error("Worktree path must be canonical");
            git(input.root, "worktree", "add", "-b", input.branch, input.worktree, input.base);
          }
          await prepare(input.worktree);
          requireCandidate(input.worktree, state.head, input.branch);
          await api.commit(() => ({ status: "running", checkpoint: { ...state, phase: input.candidate ? "review" : "implement" } }), ctx);
        } catch (error) { await api.commit(() => finish(input, state, "needs_parent", String(error)), ctx); }
      },
      async preparing(task, api, ctx) {
        await api.commit(() => finish(task.input, task.state.checkpoint, "needs_parent", "Interrupted worktree preparation; inspect effects before explicitly continuing the candidate."), ctx);
      },
      async implement(task, api, ctx) { await launch(task.input, task.state.checkpoint, api, ctx, "implement"); },
      async review(task, api, ctx) { await launch(task.input, task.state.checkpoint, api, ctx, "review"); },
      async qa(task, api, ctx) { await launch(task.input, task.state.checkpoint, api, ctx, "qa"); },
      async collect(task, api, ctx) {
        const input = task.input;
        let state = task.state.checkpoint;
        try {
          const outcomes = await api.outcomes(state.children!, ctx);
          if (outcomes.some(outcome => outcome.status !== "completed")) throw new Error("Stage did not complete; inspect its terminal receipt");
          state = { ...state, samples: [...state.samples ?? [], ...outcomes.map(outcome => {
            const result = (outcome as Extract<TaskOutcome<StageResult>, { status: "completed" }>).result;
            return { metrics: result.metrics, provenance: result.provenance };
          })] };
          const reports = outcomes.map(outcome => parseReport((outcome as Extract<TaskOutcome<StageResult>, { status: "completed" }>).result.text));
          // Interrupted unsafe tools remain a blocker even if the model declares success.
          for (let i = 0; i < outcomes.length; i++) {
            const result = (outcomes[i] as Extract<TaskOutcome<StageResult>, { status: "completed" }>).result;
            if (await hasUncertainEffects(api, result.conversationId as ConversationId, ctx)) throw new Error("Stage effects require reconciliation before any workflow continuation");
            if (result.status !== "complete" && reports[i].status === "complete") throw new Error("Stage effects are uncertain; completion report cannot override the receipt");
          }
          if (state.stage === "implement") {
            const head = candidate(input.worktree), report = reports[0];
            requireCandidate(input.worktree, head, input.branch);
            git(input.worktree, "merge-base", "--is-ancestor", state.head, head);
            if (report.status !== "complete" || head === state.head || report.commit !== head) throw new Error("Implementation must identify a new clean descendant commit");
            await api.commit(() => ({ status: "running", checkpoint: { ...state, head, phase: "review", index: 0, feedback: [] } }), ctx);
            return;
          }
          requireCandidate(input.worktree, state.head, input.branch);
          if (reports.some(report => !["complete", "changes_requested"].includes(report.status) || report.commit !== state.head || !report.evidence.length)) throw new Error("Stage reports must identify this candidate and supporting evidence");
          const feedback = [...state.feedback, ...reports.filter(report => report.status === "changes_requested")];
          if (state.stage === "qa" && (state.index ?? 0) + 1 < input.stages.qa.length) {
            await api.commit(() => ({ status: "running", checkpoint: { ...state, feedback, index: (state.index ?? 0) + 1, phase: "qa" } }), ctx);
          } else if (feedback.length) {
            await api.commit(() => state.round >= input.maxRevisions ? finish(input, state, "needs_parent", "Revision limit reached; parent decision required") :
              { status: "running", checkpoint: { ...state, round: state.round + 1, feedback, phase: "implement", index: 0, checks: [] } }, ctx);
          } else {
            await api.commit(() => ({ status: "running", checkpoint: { ...state, feedback: [], index: 0, phase: state.stage === "review" ? "qa" : "check" } }), ctx);
          }
        } catch (error) { await api.commit(() => finish(input, state, "needs_parent", String(error)), ctx); }
      },
      async check(task, api, ctx) {
        const input = task.input, state = task.state.checkpoint;
        const checks = Object.entries(input.checks), index = state.index ?? 0;
        try {
          requireCandidate(input.worktree, state.head, input.branch);
          if (index >= checks.length) {
            const required = checks.filter(([, spec]) => spec.required).map(([name]) => name);
            if (!required.length && input.validationMode === "required") throw new Error("No required validation checks configured");
            if (checks.length && assessChecks(input.worktree, state.head, required, state.checks).status !== "complete") throw new Error("Validation checks incomplete or stale");
            await api.commit(() => finish(input, state, "complete", "Candidate completed independent review, QA, and configured validation."), ctx);
            return;
          }
          await api.commit(() => ({ status: "running", checkpoint: { ...state, phase: "checking" } }), ctx);
          const [check, { required: _required, ...spec }] = checks[index];
          const receipt = await executeCheck(input.worktree, { ...spec, check, candidate: state.head }, api.signal);
          const checked = { ...state, checks: [...state.checks, receipt.id] };
          try { requireCandidate(input.worktree, state.head, input.branch); }
          catch (error) {
            await api.commit(() => finish(input, checked, "needs_parent", `Validation ${check} left the candidate changed; retained check ${receipt.id} is ${receipt.status}: ${String(error)}`), ctx);
            return;
          }
          await api.commit(() => ({ status: "running", checkpoint: { ...checked, phase: "check", index: index + 1 } }), ctx);
        } catch (error) { await api.commit(() => finish(input, state, "needs_parent", String(error)), ctx); }
      },
      async checking(task, api, ctx) {
        await api.commit(() => finish(task.input, task.state.checkpoint, "needs_parent", "Interrupted validation command; inspect retained check attempt before an explicit retry."), ctx);
      },
    },
    async abort(task, api, ctx) {
      await api.commit(() => finish(task.input, task.state.checkpoint, "interrupted", "Cancelled; retained effects require inspection."), ctx);
    },
  });
}
