# Portable execution ledger

Keep project-facing design/API documentation in ordinary docs. Agent execution
roadmaps and task coordination documents remain tracked under `.piccolo/`.
Local session transcripts, shell output, resolved machine configuration and
checkpoint payloads are raw evidence and should not be published casually.

`piccolo records export --id WORKFLOW_UUID` creates a new tracked-friendly
`.piccolo/ledger/<id>.json` execution index. It retains candidate/base, categorical
stage dispositions, evidence counts, configured-validation status, configuration
digest and relative local-record references. It deliberately omits free-form
prompts/results, model IDs, branch names, machine paths and resolved configuration.
Original records remain intact. An existing summary is never overwritten.

This index supports reconstruction and locating evidence. It is not a substitute
for reviewing the actual commands, outputs, model provenance and design alignment.
Publish an appropriately reviewed narrative/evidence set when collaborators need
those details; hashes alone do not establish that work was reviewed or tested.
Old records remain readable and are not silently relocated or ignored. Review
which raw coordination files belong in each repository before staging them.

Before committing execution records, run `piccolo records audit`. It examines the
**staged** `.piccolo` files, flags raw jobs/runs/workflows and common credential/path
patterns, and returns nonzero when review is needed. Findings include file names
and categories, never matched values. Restricted filenames are replaced with a
SHA-256 reference; inspect the staged path list locally to locate them. Staged
file-type changes are included. Invalid JSON diagnostics omit input snippets. It does not change the index or approve
publication. This focused check is not a general secret scanner, a full external
sharing audit, or a classifier of every private identifier. Apply the destination
repository's publication policy and ordinary independent review as well.

Project/deployment-specific restrictions can be supplied explicitly as JSON:

```json
{"format":1,"restricted_literals":["private.example.invalid","internal-package-example"]}
```

Run `piccolo records audit --policy /path/to/policy.json`. Matching is literal and
case-sensitive against staged contents and paths; no executable rules are loaded.
Keep private policy values outside public repositories. The check does not infer
policy from an organization or import environment-manager settings.

After inspecting an exported summary, stage its exact returned filename, for
example `git add -- .piccolo/ledger/WORKFLOW_UUID.json`, then run the audit. Avoid
`git add .piccolo` when raw historical execution records are present. Export and
audit never stage files or modify old evidence.
