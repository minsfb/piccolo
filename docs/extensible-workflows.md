# Upstream workflow experiment

`workflow.engine = "extensible"` opts into pi-extensible-workflows **5.14.0**.
Restart Pi after changing the setting. The default `subagents` retains the
v1 recipe; in experimental mode use upstream `workflow` and `workflow_catalog`
with a JavaScript file, rather than `piccolo_workflow`. That tool deliberately
rejects calls in experimental mode to avoid silently running another engine.
The upstream companion subagents and trajectory extensions are not loaded.

The dependency is pinned in Piccolo. After installing dependencies and with Pi
closed, run:

```sh
python3 scripts/patch-workflows.py --package node_modules/pi-extensible-workflows
```

This exact-hash patch uses Node for the restricted JavaScript DSL worker when
the host is Bun and selects interoperable JSON IPC. A managed Pi executable
cannot safely stand in for a general JavaScript interpreter. The worker keeps
Node's permission model, read access limited to its generated script directory,
and a 128 MiB heap limit. Model sessions still use upstream's native Pi SDK and
provider extensions in the managed parent; no direct provider client or new
authentication is introduced. Worker stderr is retained for failure diagnosis.
Reinstalling dependencies removes the patch; rerun the idempotent helper before
launch. Unknown upstream bytes are refused. Node 24+ must be on PATH.

Provider extensions must be explicitly discoverable by native SDK-created children.
Use deployment-owned native Pi settings; do not copy credentials.

Upstream model syntax combines model and effort, for example
`provider/model:medium`. Its own roles/settings and JavaScript workflow
scripts are the experiment's configuration; Piccolo TOML agent types are not
automatically translated. `agent`, `parallel`, sequential awaits, checkpoints
and named worktrees provide deterministic stage transitions. Explicit blocked
results, revisions and commit-validation policies belong in the authored
workflow. Do not treat a successful model turn as evidence of code correctness.

Use `foreground: true` for bounded acceptance. Background work belongs to the
live Pi session; closing Pi can interrupt it. Native `workflow_status` and
explicit recovery commands use persisted snapshots/journals. A replayed
incomplete operation can repeat external side effects; inspect outcomes before
retrying. Crash-safe parent acknowledgments and automatic roadmap scheduling
remain later layers. Raw upstream state is under this project's ignored
`.cache/piccolo/workflow-host`; project execution summaries should be retained
under `.piccolo` and candidate commits/PRs remain the review artifacts.

This opt-in experimental API may evolve; the stable default v1 workflow and
native unstructured delegation remain available by switching back and restarting.

The starter script is `templates/workflows/implementation.js`. Invoke native
`workflow` with `scriptPath`, `foreground: true`, and JSON `args` containing
`task`, `implementModel`, `reviewModel`, `architectureModel`, and `qaModel`.
Use provider/model:thinking strings. It creates one named worktree, commits an
implementation, runs two named parallel reviews, then QA; explicit non-complete stage reports return
`needs_parent`. Thrown execution failures reject the native workflow and remain
failed/interrupted runtime records. `review_ready` still requires parent verification of Git and
actual evidence before publishing. The sample does not automatically revise.

For managed SDK children, select only the required provider extensions in
`PI_CODING_AGENT_DIR/pi-extensible-workflows/settings.json` `extensions`.
Those extensions must also be discoverable in native Pi settings. Avoid loading
the Piccolo host recursively into these children. Native workflow concurrency
defaults to eight; this experiment's pool is separate from pi-subagents' shared
pool, so do not claim a unified cross-engine resource cap.

This milestone qualifies native Pi compaction only for upstream SDK workers.
Selecting Blackhole with the extensible engine is rejected until child profile
propagation is qualified; use the default subagents engine for Blackhole.
