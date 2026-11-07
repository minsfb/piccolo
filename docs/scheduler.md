# Dependency scheduling

`piccolo_schedule` adds an opt-in foreground coordinator over the qualified
pi-subagents implementation/review/QA recipe. The parent authors and reviews
`.piccolo/roadmap.json` and `.piccolo/schedule.toml`, then calls the tool with
`action="run"`. `action="inspect"` reports readiness and retained claims without
launching work. Native Pi remains the user-facing coordinator.

This executor requires `workflow.engine="subagents"`. The upstream extensible
engine, its inbox and native script API remain separately selectable; automatic
translation of arbitrary upstream workflow scripts into this executor is not
implemented. Each scheduled job can replace agent types/panels through ordinary
`overrides_toml`. Model registration, effort and compaction remain Pi/Piccolo's
existing interfaces.

## Text plan

```toml
format = 1
max_active = 2
max_launches = 1000
timeout_ms = 3600000

[tasks.A]
task = "Implement the first roadmap task and commit the validated candidate."
worktree = "/absolute/repo-root/.worktrees/task-A"
branch = "implementation/task-A"
job = "implementation"
attempt = 1
max_revisions = 3
# base = "main"
# overrides_toml = '[jobs.implementation.stages.review]\nagents = ["reviewer", "architect"]'
```

Task keys must identify roadmap entries. Each implementation needs a distinct new
absolute worktree path and branch. Commit project configuration before starting.
Keep `.pi/`, `.cache/` and the owning `.worktrees/` ignored; commit intended ignore
preparation before freezing a Durable schedule source. `max_active` defaults to two workflows (1–8);
child agents still use the existing shared eight-slot pool. `max_launches` bounds
admissions per invocation, and timeout/cancellation stops new admissions and
signals active workers. Revision bounds are per implementation. These controls
catch runaway work rather than optimize token cost. The executor must cooperate
with cancellation; this is not a process supervisor.

Only ready, planned tasks are admitted. Completing A makes B eligible; completing
C makes D eligible; E starts once B and D both satisfy their commit or merge
prerequisites. Every launch records its dependency SHAs and configuration digest.
Branch movement, missing merge evidence, changed dependency bindings or external
execution-document changes stop the affected path or coordinator. The parent
must review and revalidate revised work before changing those records.

## Git propagation

The coordinator does not merge into the parent branch. If a task's selected base
lacks prerequisite candidates, it creates a retained integration branch/worktree
under the owning primary checkout's `.worktrees/piccolo-integration-ID/`, merges
those exact candidates, and starts the
implementation from that integration commit. The implementation branch therefore
contains both sides of a join. Conflicts produce `needs_parent`, with the merge
worktree retained for inspection. No reset, force cleanup or guessed resolution
occurs. Successful candidates must be clean, on the requested branch, in the same
Git repository and descendants of the integrated prerequisites. Parent/human PR
publication remains a separate authorized action.

## Ownership and recovery

An OS advisory lock, held by a small Python helper until its parent's pipe closes,
permits one coordinator per project. This supports local macOS/Linux filesystems;
it is not distributed locking or a network filesystem guarantee. A second
coordinator rejects promptly. No PID guessing or stale-lock deletion is used.

Before Git or worker side effects, an immutable claim is written under
`.piccolo/schedules/<digest(task,attempt)>/launch.json`. Worker results and terminal
outcomes are separate retained files. A killed coordinator leaves a claim, not an
invitation to replay. Any claim without a terminal outcome blocks all new
admissions. A terminal claim also prevents repeating that task/attempt, even if
its prompt, dependency or configuration changed.

The parent inspects workflow/run records and actual processes, preserves evidence,
and records the resolved outcome before choosing a new attempt. It must ensure
old workers have stopped before resetting a task to planned and incrementing its
attempt; use a new branch/worktree for that attempt. Never delete claims to retry.
An outcome with a still-running roadmap entry is another reconciliation gap: the
worker may have finished before the roadmap update. Do not infer that the old
worker is alive, that a reported candidate is correct, or that replay is safe.

Roadmap updates use an atomic replacement with before-write content checks.
Cooperating coordinators are serialized; concurrent human/agent edits are refused
when observed. This is not a transaction against hostile concurrent filesystem
writers, a power-loss durability guarantee, exactly-once external effects, or a
persistent background scheduler. When the foreground invocation stops, automatic
admission stops. Durable state lets a fresh parent decide what to do next.
