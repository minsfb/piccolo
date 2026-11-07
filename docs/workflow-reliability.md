# Workflow reconciliation and parent acknowledgment

The upstream event publisher explicitly treats listeners as best-effort. A
completion event therefore cannot be the only source of coordinator state.
Piccolo reconciles the retained upstream state into immutable, bounded summaries
under `.piccolo/workflow-inbox`. Raw prompts, logs and session messages stay in
the ignored upstream storage; receipts contain identities, state, model names,
counts and source hashes. Event callbacks accelerate reconciliation, and each
new coordinator turn checks retained state again. No daemon is required.

Use `piccolo_workflow_inbox` with `action = "inspect"` to page through current
observations. Pending completed/failed/paused outcomes remain pending until
`action = "ack"` supplies the exact receipt and a note. An acknowledgment binds
the specific upstream state bytes observed; it cannot consume a later revision.
Concurrent identical acknowledgments are idempotent. Conflicting notes reject.
A missing upstream source remains visible through retained receipt identities;
a run directory without state is also reported. Neither is silently replayed.

For the supplied four-agent implementation recipe, `action = "verify"` checks
that all native agents completed, every structured stage report names one
candidate, and the owned worktree is clean, on the expected branch and in the
same repository. It writes an immutable candidate proof. This binds Git and
reported evidence; it does not independently execute QA or prove correctness.
Borrowed worktrees and arbitrary result formats require explicit parent review.

Recorded running/queued state is unresolved evidence, not proof a process is
alive. Native recovery commands can repeat incomplete external side effects;
the inbox never launches or retries work. A parent can challenge a task, ask
for changes or decline recovery. Native runtime exceptions remain failed or
interrupted records; explicit non-complete model reports can return
`needs_parent` from the recipe.

Writes use exclusive atomic links; interrupted temporary files do not become
receipts. This addresses process interruption and concurrent writers, not
storage-device power-loss guarantees. Symlinked or malformed source/receipt
storage and excessive inventories reject for explicit reconciliation. Limits
are 4096 runs per scan, 8 MiB per native record, 1024 agent records, 64 distinct
model identities and 16384 receipt files. Archive intentionally as a project
ages; a cap failure is not a successful partial scan. Inspection returns bounded
pages with separate cursors for observations and missing-source diagnostics.
