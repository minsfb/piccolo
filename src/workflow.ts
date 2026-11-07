import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Agent, Resolved } from "./config.ts";
import { resolveAgent } from "./config.ts";
import { preflightWorktree, preflightBaseIgnores } from "./worktree-preflight.ts";
import { executeCheck, assessChecks } from "./validation.ts";
import { checkSpecSchema } from "./validation-schema.ts";
import { writeNew } from "./records.ts";
import { selectWorktreePath } from "./worktree-placement.ts";
import { workflowStagePolicy } from "./workflow-stage-policy.ts";

const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
export const reportSchema = z.strictObject({
  status: z.enum(["complete", "changes_requested", "blocked", "challenge", "partial"]),
  summary: z.string().min(1).max(6000), commit: sha.optional(),
  evidence: z.array(z.string().max(2000)).max(30).default([]),
});
export type Report = z.infer<typeof reportSchema>;
export function parseReport(text: string): Report {
  const value = text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, "");
  return reportSchema.parse(JSON.parse(value));
}
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }).trim();
}
export function candidate(cwd: string): string {
  if (git(cwd, "status", "--porcelain").length) throw new Error("Candidate has uncommitted files. Preserve and reconcile before continuing.");
  return git(cwd, "rev-parse", "HEAD");
}
export function requireCandidate(cwd: string, expected: string, branch?: string): void {
  if (candidate(cwd) !== expected) throw new Error("Candidate changed; prior review and QA evidence is stale.");
  if (branch !== undefined) {
    if (!branch.trim()) throw new Error("Candidate requires a nonempty owning branch");
    git(cwd, "check-ref-format", "refs/heads/" + branch);
    let actual: string;
    try { actual = git(cwd, "symbolic-ref", "--quiet", "HEAD"); } catch { throw new Error("Worktree is detached; reconcile its owning branch before handoff."); }
    if (actual !== `refs/heads/${branch}`) throw new Error("Worktree changed its owning branch; reconcile before handoff.");
  }
}
export function validateRecipe(resolved: Resolved, job: string) {
  const stages = resolved.config.jobs?.[job]?.stages;
  if (!stages || Object.keys(stages).sort().join() !== "implement,qa,review") throw new Error("The pi-subagents recipe supports implement -> review -> qa. Arbitrary stage graphs are a later runtime experiment.");
  if (stages.implement.agents?.length !== 1 || (stages.implement.needs?.length ?? 0) !== 0 || stages.review.needs?.join() !== "implement" || stages.qa.needs?.join() !== "review") throw new Error("Recipe requires one implementer, a review panel after implementation, and QA after review.");
  for (const stage of Object.values(stages)) for (const id of stage.agents ?? []) resolveAgent(resolved, id);
  return stages;
}
export type Worker = (input: { type: string; agent: Agent; cwd: string; task: string; stage: string; round: number; workflow: string }) => Promise<Report>;
export type WorkflowInput = { root: string; worktree?: string; branch: string; task: string; job: string; resolved: Resolved; maxRevisions: number; base?: string; candidate?: string; runtime?: unknown };

// A foreground recipe over native pi-subagents callbacks. Persisted steps are
// evidence/reconciliation inputs, not an automatic resume or replay engine.
export async function runWorkflow(request: WorkflowInput, worker: Worker, prepare: (cwd: string, continuation?: boolean) => void, signal?: AbortSignal) {
  const input = { ...request, worktree: selectWorktreePath(request.root, request.branch, request.worktree, request.candidate) };
  const stages = validateRecipe(input.resolved, input.job);
  if (!Number.isInteger(input.maxRevisions) || input.maxRevisions < 0 || input.maxRevisions > 20) throw new Error("max_revisions must be 0..20");
  if (!path.isAbsolute(input.worktree)) throw new Error("Worktree path must be absolute");
  if (!input.candidate && fs.existsSync(input.worktree)) throw new Error("Choose a new absolute worktree path, or supply candidate and base to continue independent review");
  if (input.candidate) { sha.parse(input.candidate); if (!input.base) throw new Error("Candidate continuation requires its explicit upstream base"); }
  git(input.root, "check-ref-format", "--branch", input.branch);
  const base = git(input.root, "rev-parse", "--verify", "--end-of-options", `${input.base ?? "HEAD"}^{commit}`);
  const id = randomUUID();
  const directory = path.join(input.root, ".piccolo", "workflows", id);
  // Reject symlinked record ancestors, including a pre-existing .piccolo.
  let ancestor = input.root;
  for (const part of [".piccolo", "workflows", id]) {
    ancestor = path.join(ancestor, part); fs.mkdirSync(ancestor, { recursive: true });
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error("Workflow storage must not be symlinked");
  }
  writeNew(path.join(directory, "launch.json"), { format: 1, id, created_at: new Date().toISOString(), ...input, base });
  let sequence = 0;
  const record = (value: unknown) => writeNew(path.join(directory, `${String(++sequence).padStart(4, "0")}.json`), { format: 1, at: new Date().toISOString(), ...value as object });
  let head = input.candidate ?? base;
  const configured = Object.entries(input.resolved.config.jobs?.[input.job]?.validation?.checks ?? {}).map(([check, spec]) => [check, checkSpecSchema.parse(spec)] as const);
  const validationMode = input.resolved.config.jobs?.[input.job]?.validation?.mode ?? "required";
  const required = configured.filter(([,spec]) => spec.required).map(([check]) => check);
  let validation: ReturnType<typeof assessChecks> | { status: "not_configured" } = configured.length
    ? { format: 1, candidate: head, status: "incomplete", required, missing: [...required], checks: [] } : { status: "not_configured" };
  const finish = (status: string, summary: string) => {
    const result = { format: 1, id, status, summary, candidate: head, base, branch: input.branch, worktree: input.worktree, record: directory, validation, qualification: status === "complete" && required.length > 0 && validation.status === "complete" ? "checks_passed" : "unqualified" };
    writeNew(path.join(directory, "outcome.json"), result); return result;
  };
  try {
    if (input.candidate) {
      const common = (cwd: string) => fs.realpathSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
      if (common(input.root) !== common(input.worktree) || fs.realpathSync(git(input.worktree, "rev-parse", "--show-toplevel")) !== fs.realpathSync(input.worktree)) throw new Error("Candidate continuation requires an existing worktree of this repository");
      requireCandidate(input.worktree, head, input.branch);
      git(input.worktree, "merge-base", "--is-ancestor", base, head);
      if (head === base) throw new Error("Candidate must differ from its upstream base");
      record({ stage: "continue_candidate", candidate: head, base, branch: input.branch });
      prepare(input.worktree, true);
      requireCandidate(input.worktree, head, input.branch);
    } else {
      const ignored = preflightBaseIgnores(input.root, base);
      record({ stage: "base_preflight", ...ignored });
      const preflight = preflightWorktree(input.root, input.worktree, input.branch);
      record({ stage: "preflight", ...preflight });
      git(input.root, "worktree", "add", "-b", input.branch, preflight.worktree, base);
      prepare(input.worktree, false);
    }
    let feedback: Report[] = [];
    for (let round = 0; round <= input.maxRevisions; round++) {
      if (signal?.aborted) return finish("interrupted", "Cancelled; inspect retained work before restarting.");
      const run = async (stage: "implement" | "review" | "qa", type: string) => {
        const instructions = stage === "implement"
          ? "Implement or revise the scoped task. Commit all intended source and tracked execution documents. Keep .pi and .cache ignored. Do not push or merge. This pipeline schedules independent review and QA after you return your committed candidate; do not wait for those downstream stages or request them as a prerequisite to your report. Contact the parent only for an actual decision or blocker. If impossible, contradictory, or blocked, explain that honestly."
          : `Independently ${stage === "review" ? "review correctness and design alignment of" : "test and validate"} candidate ${head}. Do not modify source, create commits, or change branches. Report changes_requested for actionable failures; blocked/challenge/partial are valid. Complete requires evidence for this exact commit.`;
        const task = `${instructions}\nStay on branch ${input.branch}; never detach HEAD or switch/reset branches. Inspect commits using git show.\nConfigured validation (the harness runs these once after QA; inspect isolation, do not duplicate them):\n${JSON.stringify(Object.fromEntries(configured))}\nOriginal task:\n${input.task}\nStage instructions:\n${stages[stage].task ?? ""}\nBase: ${base}\nCandidate: ${head}\nRevision round: ${round}\nPrevious findings:\n${JSON.stringify(feedback)}\nReturn only a strict JSON object with status (complete, changes_requested, blocked, challenge, partial), summary, commit (full current SHA from git rev-parse HEAD), evidence (array of concise command/results or artifact references). No JavaScript expressions, computed strings, or raw logs. Inspect the current full SHA after any commit; never guess or concatenate it.`;
        const agent = resolveAgent(input.resolved, type);
        const report = reportSchema.parse(await worker({ type, agent: { ...agent, prompt: workflowStagePolicy(agent.prompt, stage) }, cwd: input.worktree, task, stage, round, workflow: id }));
        record({ stage, round, type, candidate: head, report }); return report;
      };
      if (!input.candidate || round > 0) {
        const implementation = await run("implement", stages.implement.agents![0]);
        if (signal?.aborted) return finish("interrupted", "Cancelled after implementation; retained worker report does not override cancellation.");
        if (implementation.status !== "complete") return finish(implementation.status, implementation.summary);
        const previous = head; head = candidate(input.worktree);
        requireCandidate(input.worktree, head, input.branch);
        git(input.worktree, "merge-base", "--is-ancestor", previous, head);
        if (head === previous || implementation.commit !== head) return finish("blocked", "Implementation must produce and identify a new clean descendant commit; no success was inferred.");
      }
      // A rejected report must not let the next trial or parent outlive active siblings.
      const reviewResults = await Promise.allSettled(stages.review.agents!.map(type => run("review", type)));
      const rejected = reviewResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) throw rejected.reason;
      const reviews = reviewResults.map(result => (result as PromiseFulfilledResult<Report>).value);
      if (signal?.aborted) return finish("interrupted", "Cancelled after review; no QA stage was started.");
      requireCandidate(input.worktree, head, input.branch);
      const exception = reviews.find(r => !["complete", "changes_requested"].includes(r.status));
      if (exception) return finish(exception.status, exception.summary);
      if (reviews.some(r => r.commit !== head || !r.evidence.length)) return finish("blocked", "Review evidence did not identify the candidate commit and supporting checks.");
      feedback = reviews.filter(r => r.status === "changes_requested");
      if (!feedback.length) {
        // QA is sequential to avoid two test processes modifying the same build tree.
        const qa: Report[] = [];
        for (const type of stages.qa.agents!) {
          qa.push(await run("qa", type));
          if (signal?.aborted) return finish("interrupted", "Cancelled after QA; no later validation was started.");
          requireCandidate(input.worktree, head, input.branch);
        }
        const exception = qa.find(r => !["complete", "changes_requested"].includes(r.status));
        if (exception) return finish(exception.status, exception.summary);
        if (qa.some(r => r.commit !== head || !r.evidence.length)) return finish("blocked", "QA evidence did not identify the candidate commit and supporting checks.");
        feedback = qa.filter(r => r.status === "changes_requested");
      }
      if (!feedback.length) {
        if (configured.length) {
          const ids: string[] = [];
          for (const [check, value] of configured) {
            const { required: mandatory, ...spec } = checkSpecSchema.parse(value);
            if (signal?.aborted) return finish("interrupted", "Cancelled before validation finished; retained evidence is incomplete.");
            const receipt = await executeCheck(input.worktree, { ...spec, check, candidate: head }, signal);
            ids.push(receipt.id); validation = assessChecks(input.worktree, head, required, ids); record({ stage: "validation", candidate: head, required: mandatory, receipt });
            if (signal?.aborted) return finish("interrupted", "Cancelled during configured validation; retained receipts do not authorize completion.");
            requireCandidate(input.worktree, head, input.branch);
          }
          validation = assessChecks(input.worktree, head, required, ids);
          if (validation.status !== "complete") return finish("partial", "Worker review and QA reports completed, but configured validation is incomplete or stale. Parent must inspect receipts and decide; no automatic check retry or exception waiver.");
        }
        if (validationMode === "required" && !required.length) return finish("partial", "Review and QA reports completed, but no required validation checks were supplied. Inspect project instructions, choose scoped checks, and continue this candidate with validation_checks; no implementation replay is needed. Use validation.mode=reported only as an explicit exception.");
        if (signal?.aborted) return finish("interrupted", "Cancelled before workflow completion.");
        requireCandidate(input.worktree, head, input.branch);
        return finish("complete", configured.length
          ? "Clean candidate has completed worker review/QA reports and passing configured required check receipts. Parent reviews scope, exceptions and publication readiness."
          : "Worker review and QA reports are complete for this candidate. No structured check requirements were configured; validation claims remain worker-reported. Parent reviews evidence and publication readiness.");
      }
      record({ stage: "revision_requested", round, candidate: head, feedback });
    }
    return finish("needs_parent", "Revision guideline reached; parent decides whether to revise, override limits, or challenge the task.");
  } catch (error) {
    return finish(signal?.aborted ? "interrupted" : "blocked", String(error));
  }
}
