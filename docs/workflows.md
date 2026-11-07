# Implementation workflows

Current runtime setup and compatibility: [setup](setup.md). Versioned
qualification details below describe the runtime used at that time.

`piccolo_workflow` runs a foreground implementation/review/QA recipe through
pi-subagents. The coordinator chooses the task, base commit and a new branch.
Omit `worktree` to place it in the owning primary checkout's `.worktrees/`;
branch slashes become hyphens in the task directory name. The runtime creates
that worktree and records the
launch and every verdict under the originating project's `.piccolo/workflows/`.
Workers get fresh contexts by default. They inherit project instructions and the
configured model, effort, tools, skills, timeout and compaction policy.

Commit `.piccolo/config.toml` before branching; ensure `.pi/` is ignored in the
target project. Native project runtime settings are prepared in the child
worktree, without copying authentication or raw sessions. Worktrees share the
Git object database, not working files. Task worktrees share the owning primary
checkout's ignored `.worktrees/` parent while their branches can form a
parent/child dependency hierarchy. Launching from a linked worktree reuses that
area and never creates nested task worktree areas.

`piccolo init` prepares this parent and adds `/.worktrees/` to the owning
checkout's `.gitignore` when needed. Workflow preflight can also prepare it;
it never stages or commits the ignore edit. Include intended ignore changes in
the ordinary project commit. Inspect or prepare the same placement explicitly:

```sh
piccolo worktree plan --branch feature/task
piccolo worktree prepare --branch feature/task
```

An explicit absolute `worktree` remains supported and is never relocated after a
permission error. Its parent must already exist unless it is the standard area.
The owning primary checkout must be writable by the active Pi session; grant
that scope through normal startup configuration when launching from a linked
checkout. Bare/missing primary layouts require an explicit destination. Remote
defaults use the worker host's advertised primary checkout, not the parent's
local path; older workers require explicit placement. Candidate continuation
always requires the exact existing worktree path.

The supported recipe is `implement -> review -> qa`. Implementation has one
writer. Review can have a parallel panel, and every required reviewer must pass.
QA agents run sequentially to avoid colliding in a shared build tree. Arbitrary
graphs are reserved for the later workflow-runtime experiment.

Use `overrides_toml` to change the invocation's agent definitions or review panel:

```toml
[agents.architect]
model = "alias:architecture"
effort = "xhigh"
prompt = "Review architectural fit against the project design."

[jobs.implementation.stages.review]
agents = ["reviewer", "architect"]
```

The alias and effort must be supported by the active Pi deployment. This does
not persist changes to shared defaults. Stage `task` fields add role-specific
acceptance instructions. The top-level task remains visible to every stage.

The implementer commits a clean descendant of the starting candidate. Review and
QA reports identify the full commit SHA and supporting evidence. A changed HEAD
or uncommitted source blocks completion. Findings requesting changes return to
the implementer, followed by a fresh review panel and QA. Earlier evidence is
retained and never silently promoted to cover a revised commit.

Workers return a small JSON report with `status`, `summary`, `commit`, and
`evidence`. Status can be `complete`, `changes_requested`, `blocked`, `challenge`,
or `partial`. These exceptions preserve model judgment: a contradictory task is
not forced into a fabricated successful commit. Malformed reports get one recorded, report-only correction attempt without
replaying implementation. A second failure stops for parent reconciliation. The default allows three revision rounds;
`max_revisions` can explicitly override it from zero to twenty for an invocation.
After that the result is `needs_parent`, rather than another automatic retry.

The tool's terminal return is the parent callback; intermediate updates identify
active stages. This is a live foreground recipe, not a daemon or crash-recovery
engine. An interrupted parent may leave work without a terminal record. Inspect
the native session, execution records, branch and processes before deciding how
to continue. Do not blindly replay an old launch.

## Review handoff and PRs

The result contains the base, candidate, branch, worktree and record directory.
The originating agent checks these and publishes the branch/PR when authorized
and appropriate for the repository. Include the task, exact candidate, final
review/QA verdicts, limitations, and useful artifact links. Follow that repository's
publication rules. Piccolo does not silently push or merge on worker completion.
A local fixture or an explicit challenge can validly end without a PR.

Parent agents integrate completed children deliberately and propagate changes to
dependent branches. Rebase/merge changes the candidate and invalidates earlier
review/QA coverage. Do not automatically remove retained worktrees, branches, or
artifacts needed for review. Agents have native shell capabilities: the clean
candidate checks detect drift but are not a filesystem security sandbox.

## Continue an existing candidate

Pass `candidate` (full commit SHA), `base`, the existing absolute `worktree`,
and its `branch` to `piccolo_workflow` or a `piccolo_submit` workflow. Piccolo
verifies the repository, clean tree, exact branch/commit and base ancestry before
starting independent review, then QA. It does not copy, reset or cherry-pick the
candidate. Requested revisions may invoke the implementer within `max_revisions`;
old reviews are never reused for a changed commit. Continuation creates a new
workflow record, not a replay of an interrupted engine. The worktree must already
have matching generated Piccolo configuration; reconcile configuration explicitly
before submission if necessary.

New worktrees also preflight the **selected base's** `.pi` ignore rules. Current
checkout changes do not repair an older base. A missing rule blocks before branch
creation; commit `/.pi/` in the selected base or intentionally configure a local
Git exclude. Piccolo does not silently change Git excludes.

## Required validation

The stock implementation job uses `validation.mode = "required"`. Supply named
checks in project TOML, invocation TOML, or directly as `validation_checks`:

```json
{
  "focused": {
    "command": "python3 -m unittest tests.test_logs",
    "cwd": ".",
    "boundary": "isolated",
    "scope": "Temporary log fixtures; no real services",
    "timeout_ms": 120000,
    "required": true
  }
}
```

Choose actual project commands after reading its instructions and checking test
isolation. A declared boundary describes the command; it does not create a sandbox.
Direct invocation checks override same-name configured checks, preserving others.
The original task's required validation commands are workflow requirements. Each
worker completes its assigned stage and reports the configured commands as
deferred; the harness executes them once after review and QA. Focused development
checks may still run before an implementation commit.
The harness runs each check once after review/QA and retains output, exit status,
command, scope and candidate identity. Checks may run in a nested package directory;
their shell evidence stays under the candidate root’s `.cache/piccolo/shell/`,
independently of the command working directory. Stage prompts ask workers to inspect these
checks instead of redundantly executing them.

Validation shells inherit the host environment with `PYTHONDONTWRITEBYTECODE=1`
so ordinary Python test imports do not leave untracked bytecode. Launch and check
receipts record that nonsecret override. Commands retain their exact text; other
generated artifacts must be ignored or written under `.cache/`. Source edits,
branch changes and untracked outputs still invalidate the candidate. A Durable
workflow retains the check receipt reference when that happens.

With no required check, stage reports can finish but the outcome is `partial`,
with `qualification: "unqualified"`. The parent can inspect the work and continue
the same candidate with selected checks. `validation.mode = "reported"` is an
explicit compatibility/exception setting: reports alone may complete the workflow,
but remain unqualified. `qualification: "checks_passed"` means configured required
checks passed for that candidate, not that every possible test or publication gate
passed. Failed optional checks remain in receipts. Failed required checks are not
waived by a worker's prose or automatically retried.

## Supervisor handoff compatibility

Session-owned jobs opt into a narrow, exact-source patch of pi-subagents 0.68.0.
The public request gains `awaitSupervisor`; it uses the native live completion
promise and retains the owner's cancellation route through `contact_supervisor`.
The same worker and pool lease remain owned until terminal acknowledgment. Other
native launches keep their existing behavior. Normal foreground delegation does
not opt in because its parent cannot reply while awaiting the tool.

`piccolo setup` applies the patch to the stopped installation. For an explicitly
selected project installation, after closing its Pi sessions:

```sh
python3 scripts/subagents-supervisor-compat.py --package-root /path/to/pi-subagents
```

Unknown package versions/source bytes fail closed. `--revert` restores the pinned
original bytes; reinstalling the native package also removes the patch. Update
Piccolo and rerun setup before relying on background supervisor continuation.
