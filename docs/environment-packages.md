# Native contribution packages

An environment manager can deploy Piccolo and optional ordinary Pi packages
through native `pi install`/`pi remove`. Provisioning, authentication, transport,
and service supervision remain external responsibilities.

A contribution loads after Piccolo and emits `piccolo:contribute:v1` with a named,
versioned configuration contribution. Inspect the mutable acknowledgment and
fail if validation or collision handling rejects it. Explicit `override: true`
is required to replace an existing named definition. User/project TOML retains
higher precedence. See [configuration](configuration.md).

Contributions may supply model aliases, agent definitions, profiles, or explicit
worker-policy modules. They must preserve normal native package installation,
removal, and instruction discovery. Restart Pi after package changes. Keep all
credentials, machine paths, and organization policies in deployment-owned files.
