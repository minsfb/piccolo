# Reproducible experiments

Experiments run a bounded TOML matrix through existing session-owned delegates and
implementation/review/QA workflows. Each trial gets a fresh retained worktree at
one exact committed source base. The default `subagents` engine is required.
Serial trials rotate variant order each repetition to reduce order effects; this
is not randomization, deterministic inference, or a statistical significance test.

## Define and launch

Store a manifest in the project (commit it before running):

```toml
format = 1
name = "summary-models"
repetitions = 3

[tasks.summary]
kind = "delegate"
type = "summarizer"
task = "Read README.md and summarize development commands. Do not modify files."
[tasks.summary.criterion]
kind = "rubric"
description = "Independently verify every command against README; identify omissions and invented commands."

[variants.baseline]
[variants.alternate]
delegate_overrides_toml = 'model = "provider/registered-model"'
```

Validate with `piccolo experiment plan --spec experiment.toml`. In Pi, call:

```json
{"kind":"experiment","arguments":{"spec":"experiment.toml"}}
```

using **piccolo_submit**. Return immediately with the job ID; the ordinary jobs
menu, explicit stop, health attention, result inspection and acknowledgment apply.
`piccolo_experiment` is the internal execution tool and refuses unowned foreground
execution. Closing/replacing the session cancels its experiment. Parent messages
require an explicit active-child target; they contaminate comparability and should
be disclosed. No new daemon or runtime is introduced.

The manifest and resolved configuration are captured at submission. Source movement
before execution rejects. Missing models, incompatible profiles, forked context and
unsupported capabilities reject before submission rather than silently falling back.
Use 2–20 repetitions and at most 100 total trials. A single variant is useful as a
baseline. Each invocation is new: interrupted trials remain unresolved/not-started;
there is no resume, retry, cleanup or automatic replay API.

## Workflows and criteria

This initial release accepts simple unnamespaced agent/job references; native
namespaced references are not part of this interface.

A workflow task sets `kind = "workflow"`, optional `job` and `max_revisions`, and
explicit `[tasks.NAME.checks.CHECK]` entries with the existing command/cwd/boundary/
scope/timeout/required fields. Every workflow must declare at least one required
check. Variants can supply `workflow_overrides_toml` to replace a review panel or
agent selections through the normal configuration merge. Each workflow starts from
the same base in a distinct branch; no candidate is pushed or merged into the parent.

- `exact_text`: delegate output must exactly match `expected`, with successful
  execution. No trimming or model judge. Best for small synthetic controls.
- `required_checks`: workflow must return complete with `qualification=checks_passed`.
  This verifies its configured checks, not every possible correctness property.
- `rubric`: initially unassessed even when execution completes. A separate human
  or agent evaluates the declared `description` against retained evidence.

Worktree isolation separates source changes, not network credentials or host services.
Task/check permissions follow the existing project and harness execution boundary.
Use an onboarded project with `.cache/` and the owning `.worktrees/` ignored.
Commit intended ignore changes before freezing experiment source. Directly configured projects must
check their ignore coverage before running; explicit experiment-storage preflight
is not inferred from experiment success.
Use owned fixtures and supported isolated checks. Untracked input outside `.piccolo`
and uncommitted source prevent launching. External dependencies, host load, global
skills and provider nondeterminism remain experimental limitations. Commit fixtures
and pin dependencies/runtime where comparisons require them.

## Inspect, assess and compare

The job result gives an experiment UUID. Local raw results live under ignored
`.cache/piccolo/experiments/UUID/`, including the captured manifest, per-trial launch
and outcome, and provenance. New trial worktrees live in the owning primary
checkout's `.worktrees/experiment-UUID-TRIAL/`, shared by native and Durable
execution. Saved trials using older paths remain inspectable and recoverable.
Preserve needed work while review is pending.

```sh
piccolo experiment report --id UUID
piccolo experiment assess --id UUID --spec assessment.json
piccolo experiment compare --id UUID1,UUID2
```

An assessment is a JSON object with `trial` (e.g. `"001"`), `outcome_digest` from
the report, `verdict` (`pass`, `fail`, `uncertain`), `assessor`, `provenance`
(`human_reported` or `agent_reported`), nonempty `evidence` references and `note`.
It is immutable and binds the exact result. Reported identity/evidence is not an
independently authenticated reviewer attestation. Rubric assessments never replace
execution status or waive deterministic failures. Use an independent reviewer, not
the worker that produced the answer. Retain its report/session reference.

Reports retain all planned denominators, failed and unstarted trials, per-trial
latency samples and median total elapsed time. Time includes worktree setup, pool
wait, model work, review and checks; it is not model-only latency. Native reported
usage and pool waits are recorded when available; missing metrics stay null, not
zero. Usage totals require all samples. Reported cost units/pricing are not verified
billing. Parent interventions and retry counts currently remain unmeasured; run
records retain their underlying evidence. No automatic winner or cost routing.

Cross-experiment comparison requires identical source base and task/criteria digest;
inspect runtime/config/host provenance and differing repetition counts before drawing
conclusions. Separate sessions can compare baseline/Blackhole, with their normal
profile qualification; one session never switches compaction ownership mid-experiment.
Extensible Workflows/Fabric integration and automatic promotion are later decisions.
