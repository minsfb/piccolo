/** Opt-in qualification support. Never captures prompts, credentials, or headers. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Test-only guard: a model omitting async:false would silently exercise the
  // package's default background path instead of the selected foreground case.
  pi.on("tool_call", async (event) => {
    const expected = process.env.PICCOLO_QUALIFY_ASYNC;
    if (event.toolName === "subagent" && event.input.agent && !event.input.action
        && expected !== undefined && event.input.async !== (expected === "true")) {
      return { block: true, reason: `Qualification requires explicit async:${expected}; retry the same child request with that field.` };
    }
  });
  for (const event of ["session_start", "agent_end"] as const) {
    pi.on(event, async (_event, ctx) => {
      pi.appendEntry("piccolo-qualification-metadata", {
        event,
        provider: ctx.model?.provider,
        model: ctx.model?.id,
        thinking: pi.getThinkingLevel(),
        cwd: ctx.cwd,
      });
    });
  }
}
