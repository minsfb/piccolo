# Quiet native display

Piccolo setup fills three absent native user settings: `hideThinkingBlock`,
`collapseChangelog`, and `quietStartup`, all `true`. Existing values (including
`false`) are preserved. Repeated setup does not reset choices made through Pi.
Project `.pi/settings.json` continues to override user settings. Manual Pi package
installation alone does not write these defaults; use `piccolo setup` or native
`/settings`/JSON configuration. Close affected Pi sessions before setup as usual.

Piccolo tools and the standalone health package render compact summaries by
default. Job summaries distinguish running, cancelled, unresolved and pending
review; failures and health recording/wake degradation remain visible. Collapsed
rows are bounded by terminal width, including results stored as one long JSON
line. Expanded details have a display-only size cap with a retained-record hint.

- **Ctrl+T** toggles native thinking visibility without changing reasoning effort.
- **Ctrl+O** toggles native tool/custom-message expansion. Remapped native bindings
  are respected and shown in the hints.
- **/piccolo-jobs** retains the detailed, scrollable Result view and explicit review,
  instruction and Stop controls. Closing a view never acknowledges a result.
- **/harness-health** selects an incident; its transcript entry starts compact and
  expands to the retained details.

Job completion banners are brief. The full parent instruction remains in its
custom message and model context; expanding reveals it. Health recovery wake
instructions remain native user messages and are unchanged. Assistant-written
progress prose is also unchanged. This is not transcript compaction or suppression
of user requests, failures or decisions.

The renderers use Pi's public tool/message renderer APIs; they do not patch native
components, re-register built-in tools, change tool execution or remove content
from model context or execution records. The health package remains independently
installable. No transcript package, display profile or live preset system is added.
