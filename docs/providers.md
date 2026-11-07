# Providers

Pi's active model registry owns model discovery, endpoint selection, and
provider authentication. Piccolo does not create a provider or copy credentials.

Use `provider/model` references or configure a named alias:

```toml
[models.review]
model = "provider/model"
effort = "high"

[agents.reviewer]
model = "alias:review"
```

Replace the placeholder with a model actually exposed by your Pi installation.
Effort is a separate field. Unknown aliases and cycles fail configuration.
For screenshot inspection, declare image input requirements and select a model
whose native capabilities include images. Report unavailable access as blocked.

Optional provider extensions must be explicitly installed and discoverable by
SDK-created children. They own their own configuration and credentials. See
[contributions](environment-packages.md) and [configuration](configuration.md).
