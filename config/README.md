# Configuration examples

`defaults.toml` contains validated portable defaults. Override them in XDG user
or project `.piccolo/config.toml`; package files remain independently versioned.
`providers.example.toml` is an optional alias example, not authentication or a
new provider. Replace its model with one discovered in your Pi registry.
`workflows.example.toml` illustrates agent/job overrides. Native package settings
are separate from Piccolo TOML. See [configuration](../docs/configuration.md).

Keep credentials, private provider routes, and machine-specific paths outside Git.
