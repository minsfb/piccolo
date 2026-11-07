# Candidate validation receipts

Workflow stage reports and command results are separate evidence. Existing
free-text reports remain readable; a completed worker report is not automatically
machine-verified QA. Piccolo reports `validation.status = "not_configured"` when
no command requirements are defined.

Declare scoped checks in the existing layered TOML, including invocation overrides:

```toml
[jobs.implementation.validation.checks.focused]
command = "python3 -B -m unittest discover -s tests -p test_feature.py"
cwd = "."
boundary = "isolated"
scope = "Temporary fixtures for the changed CLI behavior; no services"
timeout_ms = 30000
required = true
```

After successful independent review/QA reports, the subagents recipe executes
these checks sequentially against the clean candidate. The command cwd must be
inside the same worktree. `boundary` describes the agreed execution scope; it
is not an OS sandbox or proof that an arbitrary command is isolated. Inspect
commands before authorizing them. Piccolo does not run unconfigured broad suites.
The parent is responsible for selecting sufficient checks for the task.

Each attempt retains command, cwd, candidate, declared boundary/scope, timestamps,
exit status, bounded output and its hash under ignored `.cache/piccolo/checks/`.
These are local raw records, potentially containing private output. A short
workflow stage receipt references them. A nonzero exit is failure; timeout,
cancellation, unknown supervisor outcome and candidate drift remain distinct.
A required non-pass keeps the workflow `partial` and its session job needs its
parent. No automatic retry or silent waiver occurs. Optional failures stay visible
but do not satisfy or defeat unrelated required checks. No configured checks means
no automatic validation completeness claim.

For a scoped manual check, write a JSON specification file containing `check`
plus command/cwd/boundary/scope/timeout_ms, and optionally the expected candidate:

```sh
piccolo check run --cwd /candidate/worktree --spec /local/check.json
piccolo check inspect --cwd /candidate/worktree --id ATTEMPT_UUID
```

The CLI exits nonzero for a non-pass result. An intentional retry may name
`retry_of` and `retry_reason` together; earlier receipts remain immutable.
Independent verification is also a new attempt, not replacement of a prior log.
When assessing supplied attempts for a check, the latest outcome wins: an earlier
pass cannot hide a later failure, and evidence from another candidate is stale.

Models may still report blocked, challenged or partial work. The parent can
challenge an unreasonable requirement, accept a documented scope exception, or
launch a revised invocation. Such a decision does not rewrite an earlier failed
receipt into a pass. There is no automatic publication approval: the parent/human
must assess candidate, coverage, exceptions and project policy before shipping.

Before SDK worker inference, Piccolo probes needed stock rg/fd executables in
the current PATH and native agent bin directory without downloading or installing
anything. Missing stock binaries are recorded and focused fallback guidance is
provided. Custom provider tools can supply a separate search implementation; this
is an observation about stock executables, not a reason to disable those tools.
