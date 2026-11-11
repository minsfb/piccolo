# Pi harness health

A standalone Pi extension that records categorical harness incidents, monitors
attention and deadlines, and requests bounded parent recovery when a safe wake
capability exists. Piccolo is optional.

```sh
pi install /absolute/path/to/piccolo/packages/health -l
```

Restart Pi after installation. Remove it with native `pi remove` when no session
uses it. `/harness-health` inspects incidents, `check` reconciles observations, and
`diagnose` requests a configured bounded diagnostic call. The `harness_health`
tool records handling, deferral, or verified resolution. A wake is not resolution.

Configuration layers package defaults, XDG user TOML, trusted project
`.pi/health.toml`, and explicit integration values. Piccolo integration overrides
use `[extensions.pi-harness-health]` in Piccolo TOML.

```toml
enabled = true
recovery = "observe"
compatibility = "off"
interval_ms = 5000

[diagnostic]
enabled = false
```

Diagnostics require an explicit available model and have bounded calls/tokens,
no project tools, and no authority to change tasks. Private incident snapshots
live under XDG state with owner-only permissions; raw errors and task text are
not persisted. Recording failures disable automated recovery.

Wake requires a host-provided capability or an explicitly enabled compatibility
adapter. Historical `managed` option names select only enumerated Pi version,
platform, and method fingerprints; they do not detect an organization or qualify
unknown runtime builds. Standalone and public Piccolo defaults are `off`.
Compatibility changes affect method wrappers in the current process, so restart
Pi after changing them. Exact SDK-based regression checks do not establish live
model, terminal, or deployment acceptance.

The experimental `native-v1` selection requires the public
`pi.completion-admission/v1` contract and the current session identity. Its Pi
prototype is proposed upstream and has not been released. Queued or accepted
notification admission does not mean the parent inspected the task outcome.
See the [prototype and release gates](../../docs/native-turn-admission.md).

`pi-harness-health:inspect:v1` supplies validated configuration, categorical
observations, and deadline expectations. `pi-harness-health:attention-owner:v1`
claims parent attention only when active, recording, and capable of safe wake.
The package does not restart Pi, restore terminals, replay work, change credentials,
or silently switch models. See source types and regression tests for protocol bounds.
