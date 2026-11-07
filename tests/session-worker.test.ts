import test from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import worker from "../integrations/session-worker.ts";
import { createWorkerControl, queueWorkerMessage, closeWorkerControl } from "../src/worker-control.ts";

test("a pool-queued instruction queues after the original task starts, without a competing prompt", async () => {
  const control = createWorkerControl(() => {}, ["read"]);
  queueWorkerMessage(control, "QUEUED FOLLOW-UP");
  const handlers = new Map<string, Function>(); const errors: string[] = []; const starts: string[] = []; const queued: any[] = [];
  let busy = false; let finish!: () => void;
  // Exercise the installed SDK's real prompt and custom-message paths. Only
  // authentication and the model runner are stubbed; no provider is contacted.
  const session: any = Object.create(AgentSession.prototype);
  Object.defineProperties(session, { model: { value: { provider: "fixture", id: "fixture" } }, isStreaming: { get: () => busy } });
  Object.assign(session, {
    _modelRuntime: { hasConfiguredAuth: () => true }, _baseSystemPromptOptions: { selectedTools: [] }, _pendingToolNames: new Set(),
      _recordSelection() {}, getActiveToolNames: () => [], _preparePromptAndToolLoadout() {},
      _handlePostAgentRun: async () => false, _runBeforeSettleBoundary: async () => false, _emitAgentSettled: async () => {},
      _pendingNextTurnMessages: [], _followUpMessages: [],
    _baseSystemPrompt: `<piccolo-worker-control:${control.id}>`, agent: { state: {}, followUp: (message: unknown) => queued.push(message) },
    _emitQueueUpdate() {}, _flushPendingBashMessages() {}, _flushPendingCustomMessages() {}, _findLastAssistantMessage() {},
    _extensionRunner: { hasHandlers: () => true, async emitInput(text: string) {
      // This represents an asynchronous input hook that could outlive the run.
      // Parent instructions must use the synchronous queue, never enter it.
      assert.equal(text, "ORIGINAL TASK", "worker follow-up entered async prompt preflight");
      return { action: "continue" };
    }, async emitBeforeAgentStart(_trigger: unknown, options: any) {
      const result = await handlers.get("before_agent_start")!({ systemPrompt: session._baseSystemPrompt }, { sessionManager: { getSessionFile: () => undefined } });
      assert.equal(queued.length, 0); assert.equal(starts.length, 0);
      return { messages: result ? [result.message] : [], systemPromptOptions: options };
    } },
    async modelPrompt(messages: any[]) {
      if (busy) throw new Error("Agent is already processing a prompt");
      starts.push(messages[0].content[0].text); busy = true;
      handlers.get("agent_start")!({}, { isIdle: () => !busy });
      await new Promise<void>(resolve => { finish = resolve; });
      handlers.get("agent_end")!(); busy = false;
    },
  });
  session.agent.prompt = session.modelPrompt;
  worker({ registerTool() {}, on: (name: string, handler: Function) => handlers.set(name, handler), getActiveTools: () => ["read", "bash"], setActiveTools: (tools: string[]) => assert.deepEqual(tools, ["read"]),
    sendMessage: (message: any, options: any) => { session.sendCustomMessage(message, options).catch((error: unknown) => errors.push(String(error))); },
    sendUserMessage: (text: string, options: any) => { session.sendUserMessage(text, options).catch((error: unknown) => errors.push(String(error))); },
  } as any);
  try {
    const original = session.prompt("ORIGINAL TASK", { expandPromptTemplates: false }).catch((error: unknown) => errors.push(String(error)));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(starts, ["ORIGINAL TASK"]); assert.equal(queued.length, 1); assert.match(queued[0].content[0].text, /QUEUED FOLLOW-UP/); assert.deepEqual(errors, []);
    assert.equal(control.pending[0].state, "queued");
    handlers.get("message_start")!({ message: queued[0] });
    assert.equal(control.pending[0].state, "delivered");
    finish(); await original;
    queueWorkerMessage(control, "TOO LATE");
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(starts, ["ORIGINAL TASK"]); assert.equal(queued.length, 1);
    closeWorkerControl(control);
    assert.equal(control.pending[1].state, "rejected");
    handlers.get("message_start")!({ message: { role: "custom", customType: "piccolo-follow-up", content: `[Piccolo follow-up ${control.pending[1].id}]\nTOO LATE`, details: { messageId: control.pending[1].id } } });
    assert.equal(control.pending[1].state, "rejected");
  } finally { closeWorkerControl(control); }
});
