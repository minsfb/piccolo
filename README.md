# Piccolo

A [Pi coding agent](https://pi.dev/) configuration and workflow package.

Piccolo uses native Pi packages and extension APIs for layered configuration,
typed delegation, implementation/review/QA workflows, retained execution records,
Durable workers, experiments, and bounded evidence returns. Its health monitor is
also independently installable as a Pi package.

## Requirements and installation

- Node 24 or newer, Python 3.9 or newer, and Git.
- A compatible Pi installation with your chosen providers already configured.
- Locked dependencies installed in this checkout.

```sh
git clone https://github.com/minsfb/piccolo.git
cd piccolo
npm ci
node bin/piccolo.mjs setup --dry-run
node bin/piccolo.mjs setup
```

Setup registers native Pi packages and an optional command symlink. Close sessions
using that agent directory before setup and restart afterward. It does not select
an organization, configure credentials, provision machines, or install Pi itself.
Use `--no-bin` to omit the command symlink. See [setup](docs/setup.md).

From a target project, preserving its working directory and instructions:

```sh
piccolo init --dry-run
piccolo init
pi
```

Ordinary native `pi install /absolute/path/to/piccolo` and `pi remove` remain
supported. Setup additionally installs the pinned subagents package and its exact
compatibility patch; see [onboarding](docs/setup.md).

## Configuration and features

Configuration merges package defaults, native contributions, user TOML, project
TOML, selected profiles, and invocation overrides. Provider selection uses Pi's
active model registry; Piccolo has no endpoint or authentication defaults.

- [Configuration](docs/configuration.md) and [providers](docs/providers.md)
- [Workflows](docs/workflows.md), [coordination](docs/coordination.md), and [scheduler](docs/scheduler.md)
- [Durable workers](docs/durable-workers.md) and [session-owned jobs](docs/session-jobs.md)
- [Experiments](docs/experiments.md) and [workflow recovery](docs/workflow-reliability.md)
- [Evidence](docs/evidence.md), [portable records](docs/portable-records.md), and [validation receipts](docs/validation-receipts.md)
- [Compaction](docs/compaction.md), [display](docs/display.md), and [harness health](docs/harness-health.md)
- [Optional contributions](docs/environment-packages.md) and [remote deployment](docs/deployment.md)

The package version is **1.20.0**. Durable is the default executor; native execution
is selected with `[background] executor = "native"`. Dependencies pin Pi SDK 1.3.0;
compatibility with other installed Pi releases must be assessed separately.
Runtime compatibility patches are opt-in, and no historical live qualification
is asserted for your installation.

## Layout

| Path | Purpose |
| --- | --- |
| `extensions/`, `skills/` | Native Pi extension and task skills |
| `config/` | Non-secret defaults and examples |
| `src/`, `integrations/` | Configuration, execution, and worker APIs |
| `packages/health/` | Standalone health monitor |
| `templates/` | Execution records and optional workflow examples |
| `docs/` | Public interfaces and operating guides |
| `tests/`, `scripts/` | Isolated regression tests and explicit live probes |

Keep credentials, raw sessions, transcripts, generated artifacts, and local
configuration outside version control. Review execution-record contents before
sharing them. Extensions execute with the Pi process's privileges.

## Development

```sh
npm test
npm run typecheck
python3 -B -m unittest discover -s tests -p 'test_*.py'
git diff --check
```

Live probes require explicitly chosen models and owned fixtures; they are separate
from the regression suites. See [contributing](CONTRIBUTING.md) and
[publication scope](docs/publication.md).

This repository retains `UNLICENSED` metadata and npm's `private` publication guard.
Public Git hosting does not add a license or authorize registry publication.
Dependency licenses and attribution are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
