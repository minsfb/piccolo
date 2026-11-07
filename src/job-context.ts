import { buildSessionContext, convertToLlm, type ExtensionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { captureConfig } from "./config.ts";
import type { JobExecution } from "./session-jobs.ts";

const key = Symbol("piccolo-background-context");
export type JobContext = {
  resolve: ReturnType<typeof captureConfig>; effort: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  shared: Message[]; execution: JobExecution;
};
export function background(ctx: ExtensionContext): JobContext | undefined { return (ctx as any)[key]; }
export function withBackground<T extends ExtensionContext>(ctx: T, state: JobContext): T {
  const model = ctx.model;
  const sessionId = ctx.sessionManager.getSessionId();
  const manager = Object.create(ctx.sessionManager);
  Object.defineProperty(manager, "getSessionId", { value: () => sessionId });
  return Object.create(ctx, { [key]: { value: state }, model: { value: model }, sessionManager: { value: manager } });
}
/** Capture native context without pending tool calls or provider-signed thinking. */
export function captureMessages(ctx: ExtensionContext): Message[] {
  const messages = convertToLlm(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages);
  const results = new Set(messages.filter(m => m.role === "toolResult").map(m => m.toolCallId));
  const calls = new Set(messages.filter(m => m.role === "assistant").flatMap(m => m.content.filter(c => c.type === "toolCall" && results.has(c.id)).map(c => (c as any).id)));
  const shared = messages.flatMap((message): Message[] => {
    if (message.role === "toolResult") return calls.has(message.toolCallId) ? [message] : [];
    if (message.role !== "assistant") return [message];
    const content = message.content.filter(part => part.type === "text" || (part.type === "toolCall" && calls.has(part.id)));
    return content.length ? [{ ...message, content }] : [];
  });
  if (JSON.stringify(shared).length > 8 * 1024 * 1024) throw new Error("Shared context exceeds 8 MiB; compact or use fresh context before submission");
  return structuredClone(shared);
}
