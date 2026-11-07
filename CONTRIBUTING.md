# Contributing

Preserve native Pi package installation/removal, project cwd and instruction
discovery, strict layered configuration, explicit execution ownership, and bounded
recovery. Keep providers, credentials, machine provisioning, organization policies,
and remote supervision behind explicit external interfaces.

Use the checked-in npm lockfile. Validate with `npm test`, `npm run typecheck`,
`python3 -B -m unittest discover -s tests -p 'test_*.py'`, and `git diff --check`.
Regression suites use owned fixtures and synthetic model/tool services. Live probes
require a separately selected target, credentials, and owned evidence directory.

Read [publication scope](docs/publication.md) before sharing a revision. Do not
commit raw sessions, captures, credentials, or machine-specific qualification.
Keep compatibility patches exact and fail closed when upstream bytes change.
