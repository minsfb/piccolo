# Project execution records

Tracked coordination state for the parent, workers, and harness. Keep maintained
project/API documentation in the visible docs directory. Never store credentials
or raw sessions here. Bulky logs/screenshots stay in ignored artifact storage.

The parent owns design alignment, roadmap, and dependency readiness. Each worker
owns its task and run records; integrate those through committed branch handoffs.
One implementation writer owns a worktree at a time.

Use stable task IDs and UUID run/attempt IDs. Link tasks to design, dependencies,
upstream commit requirements, external PRs/issues/tasks, run records, review/QA
verdicts, exceptions, and completion evidence. Existing launch snapshots remain
immutable. A running record without an outcome requires reconciliation; do not
assume failure or relaunch automatically after a restart.

Launch/outcome records use format 1. Source commits, not mutable branch names,
bind review and QA evidence. Status-only changes cannot re-certify a new head.
