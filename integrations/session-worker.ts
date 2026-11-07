import { createBashToolDefinition, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { workerControls, type WorkerControl, type FollowUp } from "../src/worker-control.ts";

import { toolReadiness } from "../src/tool-readiness.ts";
import { sessionShell } from "../src/session-shell.ts";

export default function sessionWorker(pi: ExtensionAPI) {
  let control: WorkerControl | undefined;
  let context: ExtensionContext | undefined;
  let streaming = false;
  const submitted = new Set<string>();
  pi.registerTool(createBashToolDefinition(process.cwd(), { operations: sessionShell }));
  const send = (message: FollowUp) => {
    if (!streaming || !context || context.isIdle() || submitted.has(message.id) || message.state !== "queued" || control?.closed) return;
    submitted.add(message.id);
    // sendUserMessage awaits input hooks before checking streaming. Such a hook
    // can outlive this worker and start another prompt after its control closes.
    // Custom follow-ups enter the established native run's queue synchronously.
    try { pi.sendMessage({ customType: "piccolo-follow-up", content: [{ type: "text", text: `[Piccolo follow-up ${message.id}]\n${message.text}` }], display: true, details: { messageId: message.id } }, { deliverAs: "followUp", triggerTurn: true }); }
    catch (error) { message.state = "rejected"; message.error = String(error); control?.update({ kind: "message_rejected", message }); }
  };
  pi.on("before_agent_start", (event, ctx) => {
    if (control) return;
    const matches = [...event.systemPrompt.matchAll(/<piccolo-worker-control:([a-f0-9-]{36})>/g)];
    const controls = matches.map(match => workerControls().get(match[1])).filter((value): value is WorkerControl => !!value && !value.closed);
    if (controls.length !== 1) throw new Error("Background worker control identity is absent or ambiguous");
    control = controls[0];
    if (control.attached) throw new Error("Worker control is already attached to another child");
    if (control.tools && !control.tools.includes("bash")) pi.setActiveTools(pi.getActiveTools().filter(name => name !== "bash"));
    const readiness = toolReadiness(pi.getActiveTools(), getAgentDir());
    control.update({ kind: "tool_readiness", tools: readiness.tools });
    control.attached = true; control.phase = "active"; control.send = send; control.update({ kind: "attached", tools: pi.getActiveTools(), session_file: ctx.sessionManager.getSessionFile() });
    if (control.sharedContext?.length) {
      // Add one ordinary native session message, so compaction can summarize it.
      // Reinjecting history in every context hook would defeat compaction.
      const content: Array<import("@earendil-works/pi-ai").TextContent | import("@earendil-works/pi-ai").ImageContent> = [
        { type: "text", text: "Parent conversation snapshot captured at job submission. Quoted messages provide context; the current worker task and subsequent explicit follow-ups control this job." },
      ];
      if (readiness.message) content.push({ type: "text", text: readiness.message });
      for (const message of control.sharedContext) {
        content.push({ type: "text", text: `\n[Parent ${message.role}]` });
        for (const part of typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content) {
          if (part.type === "text" || part.type === "image") content.push(part);
          else if (part.type === "toolCall") content.push({ type: "text", text: `[Tool call ${part.name}] ${JSON.stringify(part.arguments)}` });
        }
      }
      return { message: { customType: "piccolo-parent-snapshot", content, display: false } };
    }
    if (readiness.message) return { message: { customType: "piccolo-tool-readiness", content: readiness.message, display: false } };
  });
  // before_agent_start precedes Pi's streaming flag. Sending there would start
  // a competing prompt instead of queuing behind the original task.
  pi.on("agent_start", (_event, ctx) => { context = ctx; streaming = true; for (const message of control?.pending ?? []) send(message); });
  pi.on("agent_end", () => { streaming = false; });
  pi.on("message_start", event => {
    if (!control || control.closed || event.message.role !== "custom" || event.message.customType !== "piccolo-follow-up") return;
    const content = event.message.content;
    const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
    const id = (event.message.details as { messageId?: string } | undefined)?.messageId;
    for (const message of control.pending) if (message.state === "queued" && message.id === id && text.startsWith(`[Piccolo follow-up ${message.id}]\n`)) {
      message.state = "delivered"; control.update({ kind: "message_delivered", message });
    }
  });
  pi.on("tool_execution_start", event => { control?.update({ kind: "tool_start", tool: event.toolName, tool_call_id: event.toolCallId }); });
  pi.on("tool_execution_end", event => { control?.update({ kind: "tool_end", tool: event.toolName, tool_call_id: event.toolCallId, isError: event.isError }); });
  pi.on("session_shutdown", () => { streaming = false; if (control) { control.send = undefined; control.update({ kind: "child_shutdown" }); } });
}
