# Piccolo 1.x supported interface

From 1.17, this execution/record contract applies to the explicit native executor.
Durable is the default and uses the [worker execution contract v2](contract-v2.md).
Configuration format 1, contributions and native package management retain their
existing formats. The default change was explicitly approved for migration.

Piccolo is a native Pi package. The 1.x contract covers the documented interfaces
below; external Pi/provider/package APIs retain their own versions and limits.
Native model/session controls, project instruction discovery and package handling
remain owned by Pi. Compatibility with a particular installation requires separate qualification.

| Surface | Supported behavior |
| --- | --- |
| TOML format 1 | Built-in → package → XDG user → project → selected profile → invocation; field merge, array/scalar replacement, omission inheritance, explicit remove/reset, unknown-field errors |
| Agent definitions | Model alias/provider ID, separate effort, prompt, skills/tools, context, timeout/depth and explicit host/platform requirements |
| Jobs | Implementation/review/QA recipe; one implementer, required review panel, sequential QA, bounded revisions and explicit exception outcomes |
| Profiles | Baseline and Blackhole ownership, materialization/restart, explicit deployment server-compaction adapter |
| Tools | `piccolo_catalog`, `piccolo_init`, `piccolo_delegate`, `piccolo_workflow`, `piccolo_evidence`, `piccolo_readiness` and their documented arguments; additive discovery/inspection/remote/inbox/schedule tools are documented in their feature guides |
| Configuration command | Native `/piccolo-configure`; optional `piccolo configure --cwd PATH` CLI for built-in/file-defined profiles |
| Contributions | `piccolo:contribute:v1`, named/versioned validated configuration, explicit collision override, normal Pi loading/removal |
| Records | Format-1 launch/outcome, workflow steps, artifact metadata, roadmap task/dependency fields described below |
| Admission | Shared per-user/host Piccolo worker capacity, bounded queue, explicit lease reconciliation, generous session-launch guideline |

`src/config.ts` supplies the executable strict schema. Public configuration
sections are format, profile/profiles, defaults, models, agents, jobs, compaction,
integration, extensions, operations, evidence, pool, hosts and workflow. Package-specific values
under `extensions` are owned by that package. Changing documented default meaning
requires compatibility assessment; a new optional profile is preferred for an
experiment. Model availability and exact generated wording are not guaranteed.

Tool arguments use `overrides_toml` for deliberate invocation patches. Empty
optional profile/override strings mean omitted. Delegate overrides are agent
fields; workflow/catalog overrides are configuration patches. Explicit unsupported
models, effort levels or host requirements fail rather than silently reroute.
Workflow success requires clean descendant commits and every required review/QA
report identifying the candidate. `blocked`, `challenge`, `partial`, interrupted
work, and revision-limit escalation are valid non-success outcomes.

Run records retain format, ID, creation/completion times, project/cwd, host,
Piccolo version, task/type, resolved configuration/origins/digest, agent and parent
selection, optional task/parent IDs, and terminal outcome. New 1.0 launches also
record host SDK/runtime versions and observed package manifests/compatibility
hashes where discoverable. That manifest list is explicitly not an exhaustive
inventory of loaded extensions. Native result payloads/statuses remain namespaced
upstream data; their entire internal shape is not a Piccolo stability promise.

Workflow records retain immutable launch inputs, numbered stage/round/type reports,
candidate identity, revision requests and the terminal branch/worktree/base/head
handoff. Worker report semantics are status, summary, full commit SHA and
evidence references. Artifact records retain identity, source workspace/candidate,
dirty state, host/path/hash/size, navigation and retention metadata. References to
raw files may outlive local retention; they are not an artifact-hosting service.

Roadmap format 1 uses stable task IDs, title/status, explicit predecessor edges,
commit-or-merge prerequisites, candidate/branch and recorded dependency SHAs.
`piccolo_readiness` remains a report for parent judgment. The opt-in
`piccolo_schedule` tool can consume a separate format-1 schedule TOML and advance
ready work through the stable recipe; see [scheduler](scheduler.md) for claim,
lock, integration and recovery boundaries. Existing
format-1 records without newer optional provenance remain readable. Unknown future
formats require migration; never reinterpret them silently as current records.

Human-facing error prose, private TypeScript function signatures, native session
files, the internal pool lease layout, and undocumented extension internals are
not stable external APIs. The JSON/TOML contracts do not guarantee durable replay,
exactly-once execution, distributed recovery, automatic host placement, token-cost
routing, or live memory-pressure management. Those capabilities remain later
roadmap experiments.

Qualification evidence is cumulative by minor version, with final-source checks
for changed behavior. Releasing 1.0 does not imply Mac qualification, observational
memory evaluation, or support for external CLI workers' compaction. See the
release notes for actual supported combinations and known limitations.

The upstream workflow engine and normalized inbox are opt-in extensions described
in [the runtime guide](extensible-workflows.md) and [reliability guide](workflow-reliability.md).
An inbox acknowledgment binds an exact observed revision; a candidate proof binds
Git identity and stage reports. Neither establishes process liveness or independently
reruns QA. The native upstream state schema is not a Piccolo stability promise.
