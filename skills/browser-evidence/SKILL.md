---
name: browser-evidence
description: Exercise a scoped browser flow using Playwright CLI and return concise evidence for a candidate revision.
---

Use the installed upstream `playwright-cli`, or the explicit executable path
provided by the task/environment. If absent, report the dependency rather than
improvising a browser backend. Inspect `--help` for the installed version.

Use a unique `-s=piccolo-TASK` session and an isolated profile. Keep browser
profiles, snapshots, screenshots and console/network captures in ignored local
storage such as `.cache/piccolo/`. Do not reuse personal authenticated browser
state unless the task explicitly requires and authorizes it.

1. Identify the candidate SHA, test URL, expected flow and evidence directory.
2. Use the task's browser connection mode. For a supplied, externally owned CDP
   endpoint, verify its current host receipt and use the installed CLI's
   `attach --cdp=URL` with the unique named session. Otherwise open the browser
   with the provided config. Read the snapshot, interact using current refs or
   stable locators, and check the actual resulting state.
3. Save a screenshot and a useful snapshot. Inspect console errors. Avoid broad
   network-header/body dumps that can expose credentials or unrelated content.
4. Inspect the screenshot with native `read` when visual assessment is needed,
   or ask the parent to delegate it to `screenshot_reviewer`. DOM assertions do
   not establish visual quality.
5. Return a bounded verdict, actions/checks, candidate, evidence paths, and
   limitations. Use `piccolo_evidence` when available, or return paths for the
   parent to register. Never paste raw logs/images into the parent response.
6. For an externally owned browser, `detach` only this task's named CLI session;
   its lifecycle owner stops the browser. For a task-launched browser, close only
   this task's session. Preserve evidence while review is pending.

For remote localhost previews, report that explicit port forwarding is required.
Code/Finder/browser navigation is a viewer action, not proof that a remote path
or URL is locally reachable. Do not run global close-all/kill-all commands.
