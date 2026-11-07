# Harness health

Piccolo setup includes the independently installable
[pi-harness-health package](../packages/health/README.md). It records categorical
compaction, model, tool deadline, and attention incidents without retaining raw
error messages or task contents. Inspection does not execute project work.

Piccolo enables monitoring with diagnostics disabled and `compatibility = "off"`.
Wake requires an explicit safe native capability. Unsupported runtimes retain
observation and notification behavior. Compatibility patches remain an optional,
exact-version/platform/fingerprint choice and do not qualify a new runtime.

```toml
[extensions.pi-harness-health]
enabled = true
recovery = "observe"
compatibility = "off"

[extensions.pi-harness-health.diagnostic]
enabled = false
```

Use `/harness-health`, `/harness-health check`, or the `harness_health` tool to
inspect incidents and record handling, deferral, or verified resolution. A wake
receipt is not resolution. Diagnostics require an explicit enabled setting and
an available model; inference is bounded and cannot run project tools.

Private records live under XDG state outside the project. Storage or native-session
recording errors disable automatic recovery. Monitoring stops with the session and
does not restart Pi or replay durable jobs. Qualify actual runtime and user-interface
behavior separately from isolated regression tests.
