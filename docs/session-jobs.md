# Session-owned jobs

With `[background] executor = "native"`, background SDK jobs belong to the current
Pi session. They retain individual launch/outcome records, share admission through
the configured pool, and support explicit inspection, waiting, messaging, and stop.
New-session and shutdown transitions cancel owned work and wait for bounded cleanup.
They do not become independent remote services after Pi exits.

Notifications can use `follow_up` or `notify_only`. Parent wake requires a safe
native capability; when unavailable, the outcome remains inspectable and ordinary
notifications continue. Health compatibility adapters are opt-in and must match
an exact runtime profile. Callback delivery does not establish task completion.

For an explicit live fixture, `scripts/acceptance-session-jobs.py prepare` accepts
an owned root, the installed subagents package, an explicit provider extension,
and caller-selected models. The helper records its exact source and creates
isolated configuration files. Its live model calls are separate from regression
tests and do not establish terminal UI acceptance.

See [contract v1](contract-v1.md), [Durable execution](durable-workers.md), and
[health monitoring](harness-health.md).
