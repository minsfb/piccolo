import { digest } from "../config.ts";
import { sumUsage } from "../experiments.ts";
import type { PipelineSpec } from "./pipeline.ts";

/** Comparison is a projection of settled task results; missing measurements stay null. */
export function compareTrials(spec: PipelineSpec, results: Record<string, any>) {
  if (!spec.experiment) return undefined;
  const plan = spec.experiment;
  const trials = Object.entries(plan.trials).map(([id, trial]) => {
    const node = results[id];
    return { id, ...trial, status: node?.result?.status ?? "not_started", correctness: node?.correctness ?? "unassessed",
      elapsed_ms: node?.elapsedMs ?? null, outcome_digest: node ? digest(node) : null, metrics: node?.result?.metrics ?? null,
      provenance: node?.result?.provenance ?? null };
  });
  const keys = [...new Set(trials.map(trial => JSON.stringify([trial.task, trial.variant])))];
  const groups = keys.map(key => {
    const [task, variant] = JSON.parse(key), sample = trials.filter(trial => trial.task === task && trial.variant === variant);
    const times = sample.map(trial => trial.elapsed_ms).filter((value): value is number => typeof value === "number").sort((a, b) => a - b);
    const middle = Math.floor(times.length / 2);
    return { task, variant, planned: sample.length, terminal: sample.filter(trial => trial.outcome_digest).length,
      correctness_pass: sample.filter(trial => trial.correctness === "pass").length,
      correctness_fail: sample.filter(trial => trial.correctness === "fail").length,
      correctness_unassessed: sample.filter(trial => trial.correctness === "unassessed").length,
      latency_samples: times.length, median_elapsed_ms: times.length ? times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2 : null,
      usage_samples: sample.filter(trial => trial.metrics?.usage).length,
      usage: sample.every(trial => trial.metrics?.usage) ? sumUsage(sample.map(trial => trial.metrics.usage)) : null };
  });
  return { name: plan.name, base: spec.source.base, task_digest: plan.taskDigest, manifest_digest: plan.manifestDigest, groups, trials,
    qualification: "comparison_only", note: "Execution and correctness are separate. Missing measurements are null. Reported rubric assessments cannot replace deterministic criteria." };
}
