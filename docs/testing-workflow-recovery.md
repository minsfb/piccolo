# Testing workflow recovery

The owned live fixture for native session recovery is prepared by
`scripts/acceptance-session-jobs.py` with an explicit source, provider extension,
installed subagents package, and selected models. It archives a clean committed
candidate and retains local evidence. Use a new root for each attempt.

`scripts/acceptance-combined-recovery.py --root PATH` exercises continuation,
retained outcomes, queued work, and parent recovery in that prepared fixture.
Read its source and fixture policy before execution. These probes make real model
calls. Native terminal interaction, visual observations, and the independently
configured remote service require separate acceptance.

Do not repeat ambiguous work or mark operator UI checks passed from a script
receipt. Regression tests validate bookkeeping and synthetic paths independently.
