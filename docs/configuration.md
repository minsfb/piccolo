# Piccolo configuration

Install Piccolo as a normal local Pi package alongside the supported pi-subagents
package. Pi loads `extensions/piccolo.ts`; it retains its own model registry,
session controls, package manager, and execution runtime. Install dependencies
with `npm ci --omit=dev` in an installed source checkout when needed.

Configuration precedence is built-in defaults, contributed package defaults,
`$XDG_CONFIG_HOME/piccolo/config.toml` (or `~/.config/piccolo/config.toml`),
project-root `.piccolo/config.toml`, selected profile, and invocation overrides.
Relative XDG paths are ignored as required by XDG. Existing invalid TOML is an
error; absent optional files are allowed. No loader rewrites the input files.

```toml
format = 1

[models.review]
model = "provider/model"
effort = "high"

[agents.reviewer]
model = "alias:review"
skills = ["review"] # Native Pi/pi-subagents skill names or file references

[profiles.quick.agents.reviewer]
effort = "medium"

# Optional deployment extension, installed and owned externally:
[integration]
child_extensions = ["/absolute/path/to/provider-extension.ts"]
```

Named definitions merge by field; lists replace, scalars replace, omitted fields
inherit. Unknown fields fail validation. `operations.remove` and
`operations.reset` accept JSON Pointers, for example `/agents/reviewer/skills`.
Remove deletes the inherited field/definition and fails if it is absent. Reset
restores the built-in value, or removes a field absent from built-ins. Operations
run before assignments within their layer. Final reference validation still
applies: removing an agent referenced by a job requires updating that job too.

Models use exact `provider/id` strings or `alias:name`. Aliases may carry effort;
an explicit agent/invocation effort wins. Unpinned types inherit the immediate
parent's current model. Unspecified effort retains native behavior and is not
assumed to inherit. Explicit unsupported models or efforts fail before launch.
Native `/model` and `/thinking` changes are never continually reset by Piccolo.

Agent fields: description, model, effort, prompt, skills, tools, context
(`fresh` or `fork`), timeout_ms, max_depth, and requirements (host/platform).
The defaults are fresh context, a generous 15-minute child deadline, and depth 8.
An explicit remote host requirement produces an actionable mismatch on another
host; this version does not relocate the task automatically. Prompts supplement
native/project instructions. Skills use native discovery. No new credential
fields are provided; authentication stays in the provider environment.

Use `piccolo_catalog` to select an agent or inspect the configured job recipe;
`piccolo_delegate` runs a type with an optional profile and per-invocation
`overrides_toml` text. This avoids the long optional-field templates that encouraged
invented values in live testing; the TOML parser and schema still validate the patch.
The programmatic resolver accepts structured override objects. The tool can
replace model, effort, prompt, skills, and other type
fields without changing shared TOML. Catalog and workflow overrides can replace a job's review panel;
`piccolo_workflow` executes the supported recipe.

`piccolo_init` creates missing execution documents without replacing existing
ones. Delegation records immutable `.piccolo/runs/<uuid>/launch.json` and
`outcome.json`, including configuration digest/origins, resolved type, parent
selection, host, native result, and optional task/parent IDs. A new session can
read them; a launch without an outcome needs reconciliation, not automatic replay.
Commit coordination records through the task's normal Git workflow. Keep secrets
and bulky raw artifacts outside those records. The template directory documents
ownership and contains design, roadmap, task, ledger, decision, and report formats.

## Optional Pi package contributions

A normal Pi extension can emit `piccolo:contribute:v1` with a mutable request:

```ts
const request = { contribution: {
  id: "my-team", version: "1.0.0",
  config: { agents: { "my-team:reviewer": { prompt: "Review API compatibility." } } }
}, result: undefined };
pi.events.emit("piccolo:contribute:v1", request);
// Check request.result.ok; no result means Piccolo is absent/not loaded yet.
```

Load Piccolo before contribution extensions. Register during extension loading,
before launching tools. Duplicate package IDs fail; replacing an existing named
definition requires `override: true` in the contribution. User/project/invocation
layers still win. Ordinary Pi packages need no Piccolo metadata. Contributed
extensions remain ordinary trusted executable code, not sandboxed configuration.
Package identity/version and override origins are captured in launch records.

The configuration format is version 1; configuration and tool interfaces are
documented by the [1.x supported contract](contract-v1.md). Use `piccolo config show|explain` for effective configuration inspection.
Durable execution follows the separate worker contract.
