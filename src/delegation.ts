import { randomUUID } from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Agent } from "./config.ts";
import { background } from "./job-context.ts";
import { acquireSlot, type PoolSettings } from "./pool.ts";

// Public pi-subagents v0.79 event protocols; no private runtime imports or second engine.
const REGISTER = "pi-subagents:runtime-agent-register:v1";
const REQUEST = "prompt-template:subagent:request";
const RESPONSE = "prompt-template:subagent:response";
const CANCEL = "prompt-template:subagent:cancel";
export type NativeResult = { requestId: string; status: string; error?: string; runId?: string; model?: string; thinking?: string; result?: { kind: string; text?: string; value?: unknown }; [key: string]: unknown };

export function validateAgentRuntime(agent: Agent, ctx: ExtensionContext): Agent {
  if (agent.requirements?.host && ![os.hostname(), "local"].includes(agent.requirements.host)) throw new Error(`Explicit host ${agent.requirements.host} is not this host (${os.hostname()}); remote placement is not automatic.`);
  if (agent.requirements?.platform && agent.requirements.platform !== process.platform) throw new Error(`Requires platform ${agent.requirements.platform}; current platform is ${process.platform}`);
  const id = agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const model = ctx.modelRegistry.getAvailable().find(m => `${m.provider}/${m.id}` === id);
  if (!model) throw new Error(`Model unavailable in the active Pi registry: ${id ?? "no parent model"}`);
  for (const input of agent.requirements?.input ?? []) if (!model.input?.includes(input)) throw new Error(`Model ${id} does not support required ${input} input`);
  if (agent.effort && !getSupportedThinkingLevels(model).includes(agent.effort)) throw new Error(`Unsupported effort ${agent.effort} for ${id}; supported: ${getSupportedThinkingLevels(model).join(", ")}`);
  return { ...agent, model: id };
}
export async function delegate(pi: ExtensionAPI, ctx: ExtensionContext, agent: Agent, task: string, owner: string, childExtensions: string[], signal?: AbortSignal, pool: PoolSettings = {}, progress?: (event: { kind: string; [key: string]: unknown }) => void): Promise<NativeResult> {
  for (const file of childExtensions) if (!fs.statSync(file).isFile()) throw new Error(`Child extension is not a file: ${file}`);
  const requestId = randomUUID();
  progress?.({ kind: "pool_wait", request: requestId });
  const lease = await acquireSlot(owner, ctx.sessionManager.getSessionId(), pool, signal);
  let uncertain = false;
  const name = `piccolo-${requestId}`;
  const registration: any = {
    version: 1, name, definition: {
      description: agent.description ?? "Piccolo task worker",
      systemPrompt: agent.prompt?.trim() || "Follow the task and applicable project instructions. Return an honest, concise outcome with evidence.",
      systemPromptMode: "append", inheritProjectContext: true, inheritGlobalContext: true,
      inheritSkills: true, defaultContext: agent.context ?? "fresh", defaultAsync: false,
      // Native 0.79 removed the wording-based completion guard. Role tool
      // limits and Piccolo candidate validation retain the non-writing policy.
      tools: agent.tools, skills: agent.skills, maxSubagentDepth: agent.max_depth,
      subagentOnlyExtensions: childExtensions,
    },
  };
  const identity = { requestId, ownerRunId: owner, nodeId: "delegate" };
  try {
    progress?.({ kind: "pool_acquired", request: requestId, waited_ms: lease.waited_ms });
    pi.events.emit(REGISTER, registration);
    if (!registration.result?.ok) throw registration.result?.error ?? new Error("pi-subagents runtime registration is unavailable; install the supported package.");
    return await new Promise<NativeResult>((resolve) => {
      let finished = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: NativeResult) => {
        if (finished) return;
        finished = true; clearTimeout(timer); if (grace) clearTimeout(grace);
        off(); signal?.removeEventListener("abort", cancel);
        uncertain = value.status === "interrupted";
        resolve({ ...value, pool_lease: lease.file, pool_wait_ms: lease.waited_ms, pool_lease_retained: uncertain });
      };
      const cancel = () => {
        pi.events.emit(CANCEL, identity);
        if (!grace) grace = setTimeout(() => finish({ requestId, status: "interrupted", error: "Cancellation requested; terminal acknowledgment not observed. Reconcile native worker state before restarting." }), 10000);
      };
      const off = pi.events.on(RESPONSE, (value: any) => { if (value?.requestId === requestId && value.ownerRunId === owner && value.nodeId === identity.nodeId) finish(value); });
      const timer = setTimeout(cancel, (agent.timeout_ms ?? 900000) + 10000);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { finish({ requestId, status: "cancelled", error: "Cancelled before launch" }); return; }
      pi.events.emit(REQUEST, {
        ...identity, ...(background(ctx) ? { awaitSupervisor: true } : {}), agent: name, task, cwd: ctx.cwd, context: agent.context ?? "fresh",
        model: agent.model, thinking: agent.effort, skill: agent.skills, timeoutMs: agent.timeout_ms ?? 900000,
        artifacts: true, result: { kind: "text" },
      });
    });
  } finally { registration.result?.registration?.dispose(); if (!uncertain) lease.release(); }
}
