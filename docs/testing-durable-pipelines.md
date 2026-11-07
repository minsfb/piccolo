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
