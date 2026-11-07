# Durable workers

Piccolo defaults to Pi Durable for foreground and background tasks. Use
`[background] executor = "native"` for the native executor. The pinned Pi SDK,
Durable, Env, and Chord dependencies are 1.3.0.

Workers bind jobs to workspace and session identities, retain stage outcomes,
and surface saved Jobs on session startup. Restoration and cancellation are
explicit. Independent remote work can outlive its controller; session-owned
work follows the parent session's lifecycle. Inspect retained intents before
retrying ambiguous operations.

## Policy and deployment

The default policy uses no deployment extension. Optional deployments supply
`integration.worker_policy` or a `PICCOLO_WORKER_POLICY` JSON file:

```json
{"version": 1, "revision": "my-policy/1", "extensions": ["/absolute/path/to/policy.ts"]}
```

These extensions and their revision belong to the deployment. Configure
`integration.require_worker_policy = true` to require a nonempty policy, or set
`PICCOLO_REQUIRE_WORKER_POLICY=1` before loading a mandatory contribution.
A failed contribution must preserve that marker so local execution fails closed.
Remote dispatch does not silently grant permission to start a plain local worker.

Provision machines, Pi, Node, source, dependencies, and provider authentication
with external tooling. `integrations/durable-worker.ts` is the native worker
entrypoint. `scripts/durable-host.py -- <Pi RPC command>` owns its RPC input and
forwards lifecycle events. Use an explicitly configured transport and worker
identity; Piccolo does not discover or provision remote hosts.

## Jobs and recovery

The Jobs tools and `/piccolo-jobs` expose list, inspect, wait, message, stop,
restore, attach, and cancel operations. Inspect job details and immutable outcomes
before deciding whether a retry is safe. An elapsed deadline, delivered callback,
or matching model response is not proof of task success.

The shared pool bounds concurrency. Stage admission is retained before execution;
interruption and accounting inconsistencies become explicit parent decisions.
Shell work keeps its stage identity and reports execution receipts. Required
validation uses the candidate's exact cwd and declared isolation.

See [worker contract](contract-v2.md), [validation receipts](validation-receipts.md),
[workflow recovery](workflow-reliability.md), and
[pipeline testing](testing-durable-pipelines.md). Regression tests exercise
synthetic workers and fixtures; users must separately qualify their live runtime,
provider modules, and remote supervision.
