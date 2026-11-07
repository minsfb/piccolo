# Workflow recovery and shell evidence

Current reconciliation (2026-09-23): the subsequent releases through 1.15.1 and real-project review completed the scoped hardening program. Pending statements below are historical. See [current roadmap](coordination.md). Stronger crash recovery remains unplanned.

Session-owned SDK bash calls retain one local `.cache/piccolo/shell/<id>/` directory.
`receipt.json` binds the guard result to the invocation; `output.log` retains up to
8 MiB of combined output; `outcome.json` records total/retained bytes and truncation.
Raw commands are not stored by the shell guard. Output may contain private data:
keep `.cache/` ignored and inspect it locally. Failures include their evidence path
and distinguish missing/malformed receipts, timeout, cancellation, and signal exit.

The guard controls its own process group through stdin EOF. Its receipt travels
through an atomic file, so a managed launcher may fork or close extra descriptors.
`group_kill_requested` is a cleanup action receipt, not proof that every conceivable
descendant is gone. Processes that deliberately start another session are outside
process-group containment. A supervisor that cannot settle has unresolved cleanup;
the parent should inspect ownership rather than assume it is safe to replay work.
The outer timeout bounds the launcher and stream wait. It does not kill arbitrary
processes by name or automatically restart work.

Workflow destination preflight requires a fresh path, writable parent and new
branch. Omit the path to use the owning primary checkout's ignored `.worktrees/`;
the runtime prepares that standard parent and ignore rule. Linked worktrees reuse
the owning area. Explicit destinations need an existing parent. It probes that
parent before creating a branch.
An explicit denied path is never silently redirected elsewhere. Races or later Git
failures retain partial work for inspection; Piccolo does not force-delete it.
Worker tool events include the native tool-call ID for correlation.

## Retain and restore interrupted work

First stop the owned workflow and let it settle. A terminal workflow record is
required; checkpoints never authorize stopping or deleting any process/worktree.
Choose new paths outside the source worktree, using canonical existing parents:

```sh
piccolo checkpoint create --cwd /project --id WORKFLOW_UUID --destination /safe/new-checkpoint
piccolo checkpoint restore --cwd /project --checkpoint /safe/new-checkpoint --worktree /safe/new-worktree --branch recovery/new-attempt
```

A checkpoint copies the working tree (including untracked and ignored artifacts),
index bytes, candidate identity, permissions, symlinks and integrity hashes. It
compares the copy and source before marking capture complete. Restore creates a
new branch/worktree in the same repository, verifies every payload entry and index,
and reports `restore_verified`. Original work and checkpoint remain untouched.
An existing destination or integrity mismatch stops before restoration begins.
A failure after creation retains its partial destination; inspect it, do not retry
over it. Restoration does not resume/replay an agent workflow.

Split-index worktrees (which need a full index first), special files, nested Git
workspaces, files over 64 MiB, totals over 1 GiB, and
more than 100,000 entries are rejected. Quiesce work and retain the original when
these bounds apply; capture large artifacts separately. Checkpoints can contain
private files and belong outside Git. No cleanup command is provided: capture
alone is not permission to remove a dirty worktree or its branch.

Structured validation receipts, parent acknowledgment/supersession controls,
portable publication summaries and full unattended workflow acceptance remain
subsequent hardening slices. This first slice does not mark H0–H5 complete.
