/** Structural event contract only: Piccolo does not depend on the optional
 * standalone health package at runtime. The monitor owns resolved health policy.
 */
type JobSnapshot = { id: string; state: string; updatedAt: number; notifications?: "follow_up" | "notify_only"; acknowledged?: boolean };
type Inspection = {
  phase?: string;
  resolved?: { tool_ms?: unknown };
  observations?: unknown[];
  expectations?: unknown[];
};

export function appendJobHealthSnapshot(request: Inspection, jobs: readonly JobSnapshot[]): void {
  // The initial request discovers integration config before user/project TOML
  // has been merged. It must not produce deadlines under provisional policy.
  if (request.phase !== "active") return;
  const duration = request.resolved?.tool_ms;
  if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 1000 || duration > 86400000)
    throw new Error("Active health inspection requires the resolved tool deadline");
  // notify_only is a captured completion policy, not permission for automatic
  // parent inference. Genuine progress deadlines remain separate health signals.
  request.observations = [...(request.observations ?? []), ...jobs.filter(job => !job.acknowledged && job.notifications !== "notify_only" && !["queued", "running"].includes(job.state)).map(job => ({
    source: `piccolo-job:${job.id}:${job.state}`, component: "attention", code: "unacknowledged", reference: { kind: "job", id: job.id },
  }))];
  request.expectations = [...(request.expectations ?? []), ...jobs.filter(job => ["queued", "running"].includes(job.state)).map(job => ({
    source: `piccolo-job-progress:${job.id}:${job.updatedAt}`, component: "worker", code: "deadline_expired",
    deadline: job.updatedAt + duration, reference: { kind: "job", id: job.id },
  }))];
}
