# Worker execution contract v2

Piccolo 1.17 defaults task execution to Pi Durable. The native executor is an
explicit compatibility option and retains its format-1 records and native SDK
behavior. TOML/contribution format 1 and worker control transport version 1 remain;
worker info advertises `workerContract: 2` and individual submission features.

## Observable behavior

- Foreground commands use the same worker execution as Jobs, waiting for results
  or yielding a Job ID when a parent question needs an answer. Interrupting a
  foreground wait requests cancellation; background parent-turn interruption
  leaves Jobs running.
- Local work belongs to the parent session. `suspend` retains it for later;
  ordinary quit cancels it. Session startup discovers saved work without running
  it, and an explicit resume/cancellation decision precedes new submissions.
- Remote independent work retains its original owner/lifetime. An attachment
  creates a controller, never resubmits that work. Restoring an old failed
  controller can recreate observation of its verified original remote request;
  completed/failed agent work is not rerun. Earlier controller/decision history
  stays recorded.
- Unsafe or uncertain effects require parent reconciliation. Recovery does not
  promise exactly-once external effects, host failover or automatic provisioning.

## Inputs and results

Delegate type/task/profile/overrides retain their meaning. `task_id` and
`parent_run_id` are captured as `origin.taskId`/`origin.parentRunId`; the delegate
keeps the invocation's canonical cwd within its assigned workspace. Model, effort,
instructions and selected skills are captured for the stage.

Foreground Durable results identify `execution_contract: 2`, `job_id`, a logical
`run_id` alias, `record` (a Durable reference), cwd/origin, attention, and available
model/effort provenance. `result.kind/text` preserves ordinary delegate text.
Execution errors set `isError`; needing a parent reply is a normal attention
outcome. `record` is not a filesystem artifact or a native session JSONL file.
Use Jobs result/result_page to inspect and acknowledge a precise outcome revision.
Native SDK artifacts and format-1 launch/outcome records remain available through
explicit native execution; Durable does not duplicate those authoritative ledgers.

Workflow/pipeline state, candidates, checks, supervisor replies, messages and
parent decisions live in the worker store. Required candidate/check guards remain.
Schedules export settled results explicitly rather than automatically rewriting
roadmaps during execution. An aggregate deadline remains absolute across reopen.

## Compatibility and setup

A local Durable store requires a Git workspace and ignored runtime paths. Plain
Pi uses the declared empty worker-policy module set. Optional native contribution
packages can supply explicit deployment-owned policy configuration. Parent compaction/extensions do not select a
worker compactor or imply extension inheritance. New workers use Durable defaults;
old stores retain their original recorded policy.

Upgrade workers first when a submission needs a newly advertised feature.
A definitive rejection has a persisted negative receipt; changing readiness then
requires a new request identity. Ambiguous admission keeps the original assignment
for inspection/cancellation. No implicit native fallback is performed.

New Durable controllers also require `admission-rejection-receipt` before remote
submission. An older service can still own previously admitted work, but must be
upgraded before accepting new dispatch from this release.
