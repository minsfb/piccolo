# Piccolo development

- Follow applicable parent and target-project instructions.
- Treat Piccolo as a substantial Pi configuration first and a wrapper second.
  Prefer native Pi packages and extension APIs, preserving ordinary package
  installation/removal and upstream compatibility. Add wrapper behavior only
  for identified gaps; keep general-purpose features independently packageable.
- Piccolo owns Pi configuration and workflows and is independent of environment managers.
  Keep machine provisioning, managed authentication, and generic remote transport
  behind external tooling/integration boundaries. Environment managers may deploy and
  configure Piccolo through its public interfaces without becoming core dependencies.
- Keep credentials, session data, raw research captures, and generated artifacts
  out of Git. Commit sanitized research with sources and observation dates.
- Preserve the working directory and instruction discovery of the project that
  a future Piccolo launcher operates on.
- Make optional integrations explicit and versioned. Document compatibility with
  the supported Pi release before enabling an upstream package.
- Scaffold validation: parse JSON and run `git diff --check`. Introduce runtime
  checks when executable behavior is added.
