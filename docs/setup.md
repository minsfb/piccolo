# Setup

Install Node 24+, Python, Git, Pi, and your provider configuration independently.
In this checkout run `npm ci` to install the exact public dependencies.

```sh
node bin/piccolo.mjs setup --dry-run
node bin/piccolo.mjs setup --no-bin
```

By default setup creates `~/.local/bin/piccolo`; use `--bin-dir PATH` to select
another command directory. Existing foreign commands and conflicting package
registrations are refused. `PI_CODING_AGENT_DIR` selects Pi's agent directory.
`--pi PATH` selects a launcher supplied by you.

Setup registers this package, pi-subagents 0.79.2, and the standalone health
package through native Pi installation. It applies the checked, exact-version
subagents supervisor patch. `--blackhole` also installs pi-blackhole 0.5.15;
its baseline starts disabled. Setup seeds missing quiet display preferences
while preserving explicit native user settings.

Close Pi sessions using the selected agent directory before setup. Setup logs
remain local. A failed operation preserves completed registrations for explicit
reconciliation; it does not roll back user settings or remove packages.

From your target project:

```sh
piccolo init --dry-run
piccolo init
pi
```

Initialization preserves the project's cwd, instructions, and existing TOML. It
creates coordination templates and ignores private `.pi/` and `.cache/` state.
It verifies installed package compatibility and dispatches a discovered native
onboarding command without requesting inference. Foreign links, hidden ledgers,
and unfinished execution records require reconciliation first.

Use ordinary `pi remove` for package removal when sessions are closed. Environment
managers may deploy the package through these interfaces but remain external to
Piccolo. Legacy `--deployment auto` resolves to native setup without detection.
