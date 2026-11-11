# Testing Durable pipelines

The isolated regression suites exercise stage admission, retained shell outcomes,
validation cwd, cancellation, recovery, and typed worker-policy behavior with
synthetic models, tools, and owned stores.

For explicit live qualification, provision compatible Pi and public dependencies,
select an owned policy JSON, and run the fixture controller:

```sh
python3 scripts/qualify-durable-pipelines.py \
  --root /path/to/new/fixture \
  --source /path/to/piccolo \
  --policy /path/to/worker-policy.json \
  -- /path/to/pi --provider PROVIDER --model MODEL --thinking off
```

Use a new root for each attempt. The `restart` scenario tests bounded process
loss and retained outcomes. It does not establish power-loss durability, automatic
host failover, or arbitrary provider/tool compatibility. Record exact revisions,
actual model/tool receipts, forced cleanup, and all skipped checks.

Use ordinary Python with assertions enabled. `-O`, `-OO` and nonzero or noninteger
`PYTHONOPTIMIZE` are refused before fixture creation or process operations.
`PYTHONOPTIMIZE=0` is supported. The fixture commits its standard worktree ignore
rule before freezing the source.

The restart gate verifies the current control/runtime PID, the first implementer
tool, stage cwd and exact candidate canary path. Earlier wrong tool attempts leave
a violation marker and refuse the kill. Completion checks the returned worktree
and commit canary as well as the source canary. These checks require a fresh live
run to establish qualification for the selected runtime.

The host wrapper completes bounded TERM/KILL cleanup of its own process group
even when descendant output streams close. It does not supervise processes that
deliberately escape that group.
