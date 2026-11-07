# Qualification fixture

This directory is an owned synthetic Piccolo test fixture. Perform only the
requested fixture task. Do not read credentials or change global configuration.
For a calculation task, read `input.json`, sum its `values`, and write JSON to
the requested output filename with keys `sum` and `instructionMarker`.
The instructionMarker must be `piccolo-fixture-v1`.
Do not delegate further unless the qualification prompt explicitly requests it.
