// Native pi-extensible-workflows experiment. Supply args.task and model strings.
const report = {
  type: "object", additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["complete", "changes_requested", "blocked", "challenge", "partial"] },
    summary: { type: "string" }, commit: { type: "string" },
    evidence: { type: "array", items: { type: "string" } }
  }, required: ["status", "summary", "commit", "evidence"]
};
return await withWorktree("implementation", async (workspace) => {
  const implementation = await agent(
    "Implement this task in the assigned worktree and branch. Commit intended changes; do not push or merge. " +
    "Read AGENTS.md. Report the full current commit SHA, real checks, and any blocker honestly. Task: " + args.task,
    { model: args.implementModel, tools: ["read", "bash", "edit", "write"], outputSchema: report, timeoutMs: 180000 }
  );
  if (implementation.status !== "complete") return { status: "needs_parent", workspace, implementation };
  const reviewPrompt = "Independently review the current implementation against task: " + args.task +
    ". Do not change files or branches. Inspect full HEAD and cite concrete evidence. Candidate: " + implementation.commit;
  const reviews = await parallel("review", {
    correctness: async () => await agent(reviewPrompt, { model: args.reviewModel, tools: ["read", "bash"], outputSchema: report, timeoutMs: 120000 }),
    architecture: async () => await agent(reviewPrompt + ". Focus on design alignment and maintainability.", { model: args.architectureModel, tools: ["read", "bash"], outputSchema: report, timeoutMs: 120000 })
  });
  if (Object.values(reviews).some(r => r.status !== "complete" || r.commit !== implementation.commit))
    return { status: "needs_parent", workspace, implementation, reviews };
  const qa = await agent("Test the committed task: " + args.task + ". Do not modify source or branches. Run real checks; report full HEAD and evidence.",
    { model: args.qaModel, tools: ["read", "bash"], outputSchema: report, timeoutMs: 120000 });
  return { status: qa.status === "complete" && qa.commit === implementation.commit ? "review_ready" : "needs_parent", workspace, implementation, reviews, qa };
});
