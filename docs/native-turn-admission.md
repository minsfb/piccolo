# Native completion admission prototype

Upstream proposal: [earendil-works/pi #12073](https://github.com/earendil-works/pi/issues/12073).

The proposed upstream Pi API exposes `ctx.turnAdmission`, with `version: 1` and
`contract: "pi.completion-admission/v1"`. `enqueue` captures a custom completion
message under a caller-owned stable ID. Reusing an ID with changed content is
refused. An accepted or queued receipt records admission, not parent inspection.
Task records and explicit outcome acknowledgment remain authoritative.

The prototype is based on published Pi 1.5.0 source. It has not landed upstream
or been deployed in a managed runtime. No released compatible version is claimed.
For isolated qualification of the prototype, select `compatibility = "native-v1"`
in the health configuration. The exact public contract and current session ID are
required. Missing or mismatched capabilities remain visibly unsupported. Existing
`managed`, explicit managed versions and `off` retain their current selection.

Native admission holds completion intent through prompt preparation, active work,
settlement, shell work and compaction. Aborting pauses automatic completion starts;
explicit later input or enqueue permits recovery. Replacement, shutdown and reload
invalidate captured capabilities before asynchronous teardown. The native runtime
preserves queued context if startup fails; Piccolo does not resubmit ambiguous
project work based on a notification failure.

The prototype passes 92 native SDK cases with faux responses, including queued
user preparation, failed/handled input, shell work, compaction and lifecycle
replacement. Owned Node and Bun terminal runs preserve an unsent draft through
idle wake, then submit it once. The real RPC entry point preserves pending user
input, wakes idle completions, times out unresponded dialogs and rejects an old
capability after session replacement. These runs use an in-process faux provider.

Upstream maintainer acceptance and managed deployment remain release gates.
Enable a new default only after those gates identify the exact compatible
runtime. The existing compatibility adapter can then be retired in a later change.
