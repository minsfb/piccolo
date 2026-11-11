import type { Message } from "@earendil-works/pi-ai";
import { configure, defineTask, type ConversationId, type TaskId, type TaskOutcome } from "@earendil-works/pi-durable";
import { parseReport } from "../workflow.ts";
import type { StageSpec } from "./contract.ts";
import type { AgentChange } from "@earendil-works/pi-durable";
import { MessagesDoc } from "./messages.ts";
import { StageOwner, type StageResources } from "./pool.ts";
import { hasUncertainEffects } from "./effects.ts";
import { withCancel, type Context } from "@earendil-works/chord/context";

export type StageResult = { status: "complete" | "needs_parent"; text: string; conversationId: number; reason?: string; provenance?: { requested: StageSpec["model"]; observed: string[]; effort: string }; metrics?: { usage: Record<string, number | null> | null; source: string } };
type Input = { spec: StageSpec; cwd: string };
type Checkpoint = { phase: "create" } | { phase: "queued"; active: TaskId[] } | { phase: "acquire" } |
  { phase: "run"; conversationId: ConversationId; deadline: number; correction?: number };

export function stageActivity(task: { state: { status: string; checkpoint?: unknown } }): "waiting" | "starting" | "active" {
  const phase = (task.state.checkpoint as { phase?: string } | undefined)?.phase;
  return phase === "queued" || task.state.status === "waiting" ? "waiting" :
    phase === "create" || phase === "acquire" || task.state.status === "pending" ? "starting" : "active";
}

/** One owned conversation per stage; stable input IDs reconcile lost submit replies. */
export function createStageTask(agent: (spec: StageSpec, cwd: string) => AgentChange | Promise<AgentChange>, capacity = 8, resources?: StageResources, admit?: (id: number, context: Context) => Promise<void>) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 128) throw new Error("Invalid stage capacity");
  return defineTask<Input, Checkpoint, StageResult, {}>({
    name: "piccolo.stage", version: 1,
    initial: () => ({ phase: "create" }),
    phases: {
      async create(task, api, ctx) {
        // Queued admission still counts toward the owner's existing launch
        // guideline. The admission callback deduplicates this stable stage ID.
        await admit?.(api.taskId, ctx);
        await api.commit(async tx => {
          const active = [];
          for (const status of ["running", "completing"] as const) {
            let cursor;
            do {
              const page = await tx.scanTasks({ kind: "piccolo.stage", status }, 1000, cursor);
              active.push(...page.items.filter(record => record.id !== api.taskId && (record.state.status === "completing" ||
                (["acquire", "run"].includes((record.state as { checkpoint?: { phase?: string } }).checkpoint?.phase ?? "")))));
              cursor = page.next;
            } while (cursor);
          }
          return { status: "running", checkpoint: active.length >= capacity
            ? { phase: "queued", active: active.map(record => record.id) }
            : { phase: "acquire" } };
        }, ctx);
      },
      async queued(task, api, ctx) {
        // The persisted queue owns no conversation or host lease. Wake after
        // any reservation settles, then recheck capacity on the mutation line.
        if (task.state.checkpoint.active.length) {
          const round = withCancel(ctx), waits = task.state.checkpoint.active.map(id => api.waitForTask(id, round.context));
          try { await Promise.race(waits); }
          finally { round.cancel(); await Promise.allSettled(waits); }
        }
        await api.commit(() => ({ status: "running", checkpoint: { phase: "create" } }), ctx);
      },
      async acquire(task, api, ctx) {
        await resources?.acquire(api.taskId, ctx);
        const configuration = await agent(task.input.spec, task.input.cwd);
        await api.commit(async tx => {
          const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          (await tx.doc(StageOwner, conversation.id)).stageId = api.taskId;
          for (const message of task.input.spec.context ?? []) await tx.appendEntry(conversation.id, { kind: "piccolo.parent-context", model: [message as unknown as Message] });
          for (const [id, message] of Object.entries((await tx.doc(MessagesDoc)).messages)) if (message.queuedStageId === api.taskId) {
            await tx.appendEntry(conversation.id, { kind: "piccolo.queued-instruction", data: { id }, model: [{ role: "user", content: message.text, timestamp: api.now() }] });
            message.conversationId = conversation.id;
          }
          await configure(tx, conversation.id, configuration);
          return { status: "running", checkpoint: { phase: "run", conversationId: conversation.id,
            deadline: api.now() + task.input.spec.timeoutMs } };
        }, ctx);
      },
      async run(task, api, ctx) {
        await resources?.acquire(api.taskId, ctx);
        const { conversationId, deadline, correction = 0 } = task.state.checkpoint;
        const conversation = (await api.conversation(conversationId, ctx))!;
        if (api.now() >= deadline) {
          await conversation.abort(ctx);
          await api.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: "Stage deadline exceeded" } } }), ctx);
          return;
        }
        const submission = await conversation.submit({ type: "input", requestId: correction ? `stage-input-v1:correction:${correction}` : "stage-input-v1",
          content: correction ? "Your report did not match the required JSON schema. Return only JSON with status (complete, changes_requested, blocked, challenge, partial), summary, commit, and evidence (array of strings). Use the existing observations; tools are disabled during this report correction. Do not claim missing evidence." : task.input.spec.task, whenBusy: "followUp" }, ctx);
        const timeout = new AbortController();
        // A deadline terminates work, while a cancelled waiter only leaves persisted work suspended.
        const timer = setTimeout(() => timeout.abort(), Math.max(1, deadline - api.now()));
        const abort = () => { void conversation.abort(ctx).catch(() => {}); };
        timeout.signal.addEventListener("abort", abort, { once: true });
        try {
          const settled = await submission.wait(ctx);
          const transcript = await api.context(conversationId, ctx);
          const messages = transcript.entries.flatMap(entry => entry.model ?? []);
          const answer = messages.filter(message => message.role === "assistant").at(-1);
          const text = answer?.content.filter(item => item.type === "text").map(item => item.text).join("\n") ?? "";
          // Compaction changes active model context, not the truth of prior effects.
          // Inspect committed history so a summary cannot erase an unsafe receipt.
          const uncertain = await hasUncertainEffects(api, conversationId, ctx);
          let status: StageResult["status"] = settled.status === "done" && !uncertain && !timeout.signal.aborted ? "complete" : "needs_parent";
          let reason = uncertain ? "Uncertain tool effect requires parent reconciliation" : timeout.signal.aborted ? "Stage deadline exceeded" :
            settled.status !== "done" ? `Stage input settled as ${settled.status}` : undefined;
          if (settled.status !== "done") await api.commit(async tx => {
            const failures = (await tx.scanTasks({ conversationId, status: "terminal" }, 1000)).items
              .filter(record => record.state.status === "terminal" && "error" in record.state.outcome)
              .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
            const error = failures[0]?.state.status === "terminal" ? (failures[0].state.outcome as { error?: { message?: string } }).error?.message : undefined;
            if (error && !uncertain && !timeout.signal.aborted) reason = error.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 1000);
            return undefined;
          }, ctx);
          if (task.input.spec.report) {
            try { if (parseReport(text).status !== "complete") status = "needs_parent"; }
            catch {
              if (status === "complete" && correction < 1) {
                await api.commit(async tx => {
                  await configure(tx, conversationId, { tools: [] });
                  return { status: "running", checkpoint: { phase: "run", conversationId, deadline, correction: correction + 1 } };
                }, ctx);
                return;
              }
              status = "needs_parent";
            }
          }
          const ownMessages = transcript.entries.filter(entry => entry.kind === "pi.assistant").flatMap(entry => entry.model ?? []).filter(message => message.role === "assistant");
          const observed = [...new Set(ownMessages.map(message => `${message.provider}/${message.model}`))];
          const compacted = transcript.entries.some(entry => entry.kind === "pi.compaction");
          const usage = ownMessages.length && !compacted ? {
            input: ownMessages.reduce((sum, message) => sum + message.usage.input, 0), output: ownMessages.reduce((sum, message) => sum + message.usage.output, 0),
            cacheRead: ownMessages.reduce((sum, message) => sum + message.usage.cacheRead, 0), cacheWrite: ownMessages.reduce((sum, message) => sum + message.usage.cacheWrite, 0),
            turns: ownMessages.length, toolCalls: ownMessages.reduce((sum, message) => sum + message.content.filter(part => part.type === "toolCall").length, 0),
            cost: ownMessages.reduce((sum, message) => sum + message.usage.cost.total, 0), durationMs: task.input.spec.timeoutMs - (deadline - api.now()),
          } : null;
          await api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status, text, conversationId, ...(reason ? { reason } : {}),
            provenance: { requested: task.input.spec.model, observed, effort: task.input.spec.thinkingLevel }, metrics: { usage, source: "durable_conversation_reported" } } } }), ctx);
        } finally { clearTimeout(timer); timeout.signal.removeEventListener("abort", abort); }
      },
    },
    async abort(_task, api, ctx) {
      // The harness cascades the abort through task-owned conversations and joins them before terminal publication.
      const outcome: TaskOutcome<StageResult> = { status: "aborted" };
      await api.commit(() => ({ status: "terminal", outcome }), ctx);
    },
  });
}
