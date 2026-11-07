# Roadmaps, worker capacity and reconciliation

Keep execution planning under tracked `.piccolo/`: design alignment, roadmap,
task breakdown, decisions and run records. External PRs/issues/tasks remain the
collaboration artifacts. Visible project documentation stays in `docs/`.

The parent can maintain `.piccolo/roadmap.json` alongside the narrative roadmap:

```json
{
  "format": 1,
  "tasks": [
    {"id":"A","title":"Implement API","status":"planned"},
    {"id":"B","title":"Build consumer","status":"planned","needs":[{"task":"A"}]},
    {"id":"C","title":"Release","status":"planned","needs":[{"task":"B","requires":"merge","merged_into":"main"}]}
  ]
}
```

`piccolo_readiness` reports ready task IDs, waiting prerequisites and stale
evidence. It does not launch work or synchronize trackers. The parent records
`candidate` as a full commit SHA and optionally `branch`. A completed task must
have that commit available locally; a merge prerequisite checks actual ancestry
against the named local ref. Fetch current refs before relying on remote state.

When starting dependent work, record `recorded_dependencies` as a map from task
ID to the upstream SHA actually used. Start its workflow with `base` at the chosen
upstream commit; stacked branches need not wait for merge. Multiple upstream
branches need a deliberate integration base prepared by the parent. Changed
upstream candidates, moving branches, missing bindings and unresolved ancestors
block downstream readiness. Joins require every predecessor to be satisfied.

The parent merges/rebases upstream changes into dependent worktrees, re-runs
review and QA at the new candidate, then updates dependency bindings and records.
Do not simply change a recorded SHA to make readiness green. No old review is
automatically promoted to cover new source. A workflow cannot attach to/replay an
old live attempt; use native sessions and explicit parent-driven reconciliation.

## Shared worker pool

Piccolo delegation and recipes share eight worker slots per user and host by
default. Excess launches wait; the default queue timeout is fifteen minutes.
Configured capacity, timeout, and a generous 1,000-launch per-session guideline
live in `[pool]`: `capacity`, `queue_timeout_ms`, `max_launches_per_session`.
Native agent recursion remains bounded by `max_depth` (default eight).

Leases are small JSON files under
`${XDG_STATE_HOME:-~/.local/state}/piccolo/pool/HOST/`. Atomic exclusive creation
coordinates separate Pi processes. Every client must agree with the stored host
capacity. To change it, drain all work, verify no leases remain, update the host
pool's `config.json` capacity and the applicable TOML, then restart clients.
Do not mutate capacity while work is running.

A normal terminal callback releases the lease. An unacknowledged cancellation
retains it conservatively. Process death is not proof that descendants stopped;
there is no automatic stale-lease reaper. Inspect owner/session/PID, native worker
state and records, terminate or reconcile the actual work, and only then remove
the specific abandoned slot file. Never delete the whole pool to get more slots.

This pool covers Piccolo's native SDK launches. Direct generic pi-subagents calls,
external CLI workers and arbitrary shell-launched agents have their own controls.
It is an admission guideline, not a security boundary. Default worker tool sets
do not encourage recursive orchestration. Nested custom coordinators can exhaust
slots while awaiting descendants; a bounded queue timeout surfaces that condition
for the parent. Slot lending, priority, memory-pressure adaptation and out-of-band
hung-process diagnosis belong to the later supervisor/runtime work.

## Interrupted work and cleanup

A launch without an outcome is unfinished or ambiguous, not permission to replay.
Inspect the native session, process and branch; record the reconciliation decision
with identities and evidence. Preserve earlier reports and add a new attempt for
new work. Retry/revision decisions remain the parent's responsibility.

Keep worktrees/artifacts for pending human review, dependents or an explicit
keep-alive request. Once the parent confirms they are no longer needed:

1. Confirm no active or unreconciled worker/lease owns the workspace.
2. Verify the worktree is clean and the candidate is retained in an approved
   branch/PR or merged target. Recheck merge ancestry at cleanup time.
3. Preserve needed evidence and record the retention decision.
4. Use ordinary `git worktree remove /exact/path` without `--force`. Retain the
   branch unless branch deletion is separately appropriate. Close only the
   task-owned browser session and remove only explicitly eligible local artifacts.

Piccolo does not automatically prune dirty/unmerged work or delete raw evidence.
The live pilot records normal cleanup separately from pending-review retention.
