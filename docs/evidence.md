# Evidence

`piccolo_evidence` records an artifact path, concise summary, and optional HTTP(S)
preview URL. Records include artifact size/hash, workspace candidate and dirty
state when available, host/path, and explicit editor navigation instructions.
Preview URLs containing credentials are rejected.

Bulky worker output is retained in ignored `.cache/piccolo/results/` and returned
with a bounded excerpt and hash. Screenshots, console logs, raw sessions, and
browser profiles remain outside Git. A link or a successful launcher command is
not proof a reviewer visually inspected the file.

The browser-evidence skill uses the separately installed upstream Playwright CLI
in an owned named session. Install its browser through the supported installer,
record actual tool/browser versions, and retain screenshots and console evidence.
Use only the task's browser profile and close only sessions you own.

Local navigation supports VS Code and Cursor. Remote links use the explicit SSH
host and preserve paths. Inspect record contents before sharing: host/path and
candidate metadata may identify your environment. [Portable records](portable-records.md)
provide a separate export and audit mechanism.
