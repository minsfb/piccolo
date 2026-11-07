/** Apply the workflow's validation ownership at the stage's instruction level,
 * preserving the configured role and project constraints. Standalone delegates
 * keep their ordinary develop/implement/QA lifecycle. */
export function workflowStagePolicy(instructions: string | undefined, stage: "implement" | "review" | "qa"): string {
  const focused = stage === "implement"
    ? "You may run additional focused development checks needed for your changes before committing."
    : "You may run additional independent focused checks appropriate to your role. Preserve source, branch and candidate; report findings without making changes.";
  return `${instructions ?? ""}\n\nWorkflow ${stage} stage assignment: complete your assigned stage and return its report to the coordinator. Interpret the original task's configured validation requirements as requirements for the whole workflow. The harness executes those named commands once after independent review and QA, satisfying the original task's validation requirement. Inspect their scope and isolation here and report them as deferred to the harness. Return your stage report without waiting for downstream stages or asking the parent whether to run the configured validation now. ${focused} Keep generated test/build artifacts ignored or under .cache so checks leave the candidate clean; use python3 -B for focused Python checks when bytecode is not already ignored. Follow explicit project prerequisites and report substantive blockers or decisions honestly.`;
}
