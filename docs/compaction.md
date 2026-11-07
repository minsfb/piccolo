# Compaction profiles

The baseline profile uses Pi compaction. The optional Blackhole profile uses
pi-blackhole 0.5.15, explicitly disables the declared server-compaction path, and
preserves its own recorded configuration. Install it with `piccolo setup --blackhole`.

Select a profile in user or project TOML, stop that workspace's Pi sessions, run
`piccolo configure`, and restart. Pending execution records block reconfiguration.
Configuration drift blocks input until reconciled; an ambient Blackhole override
cannot silently replace the materialized policy.

The default deployment has no server-compaction adapter:

```toml
[integration]
server_compaction = "none"
```

If an independently installed backend uses a top-level Pi settings object with
an `enabled` field, explicitly name that object:

```toml
[integration]
server_compaction = "settings"
server_compaction_key = "backendCompaction"
```

This example does not install a backend. The adapter disables only that object's
`enabled` field for Blackhole and restores its prior value for baseline, retaining
unrelated fields. Restore baseline before changing the configured key. Other
backend policies belong in explicit native contribution packages.

Compaction ownership, memory, thresholds, and mid-run policy are described by
`config/defaults.toml` and the validated configuration schema. The experimental
extensible workflow engine currently accepts native Pi compaction only.
