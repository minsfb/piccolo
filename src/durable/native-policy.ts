import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager, convertToLlm, getAgentDir, type ExtensionContext, type ExtensionActions, type ExtensionContextActions, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { defineDoc, type Harness, type HookApi, type ToolRegistration, type ToolExecutionApi, type ToolExecutionResult, type CompactionHooks } from "@earendil-works/pi-durable";
import { getCurrentSystemMessage, getSystemMessageText, validateToolArguments, type Message } from "@earendil-works/pi-ai";
import type { BashPrepare } from "@earendil-works/pi-durable/tools";
import { withoutAbortSignal, type Context } from "@earendil-works/chord/context";
import { digest } from "../config.ts";
import { StageOwner } from "./pool.ts";
import { hasUncertainEffects } from "./effects.ts";
import type { StageSpec } from "./contract.ts";

// Native policy state is a projection; only this Durable document is authoritative.
// Pending hook effects cannot be replayed: a rule engine may have consumed its
// external dedup key before the returned instructions reached our commit.
export const NativePolicyDoc = defineDoc<{ identity: string | null; fingerprint: string | null; modules: { path: string; events: string[] }[]; pending: string | null; messages: Record<string, any>; receipts: Record<string, any>; initialized: boolean }>({
  kind: "piccolo.native-policy", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ identity: null, fingerprint: null, modules: [], pending: null, messages: {}, receipts: {}, initialized: false }),
});
export type NativePolicyOptions = { paths: string[]; directory: string; registry: ExtensionContext["modelRegistry"]; revision: string; isProjectTrusted: () => boolean; settings?: Record<string, unknown> };
type Frame = { context: Context; messages: readonly Message[]; spec: StageSpec; cwd: string; notices: any[]; errors: string[]; prompt: string; activeTools: string[]; receipts: Record<string, any> };
type Runner = { runner: ExtensionRunner; manager: SessionManager; stageId: number; frame?: Frame; tail: Promise<unknown>; initialized: boolean };
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const supported = new Set(["session_start", "before_agent_start", "context", "context_with_system", "tool_call", "tool_result", "session_before_compact"]);

/** Explicit, supported policy modules only. This does not reload the host's model provider bundle. */
export class NativePolicy {
  private harness?: Harness;
  private runners = new Map<number, Promise<Runner>>();
  private stages = new Map<number, Set<number>>();
  private cleanup = new Set<Promise<void>>();
  readonly fingerprint: string;
  private options: NativePolicyOptions;
  constructor(options: NativePolicyOptions) {
    this.options = { ...options, paths: [...options.paths] };
    if (!options.paths.length) throw new Error("Native policy needs explicit extension modules");
    for (const file of options.paths) if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error("Policy extensions must be explicit absolute files");
    this.fingerprint = this.sourceFingerprint();
  }
  private sourceFingerprint() {
    return digest({ revision: this.options.revision, modules: this.options.paths.map(file => ({ file: fs.realpathSync(file), source: fs.readFileSync(file, "utf8") })) });
  }
  private requireSources() {
    if (this.sourceFingerprint() !== this.fingerprint) throw new Error("Native policy source changed; restore the qualified sources before starting another stage");
  }
  readonly prepareBash: BashPrepare = async (execution, api, context) => {
    const entry = await this.get(api, context);
    // A live parallel callback legitimately has a pending marker. Join its
    // serialization before distinguishing that from an interrupted callback.
    const result = entry.tail.then(async () => {
      const doc = await this.harness!.snapshot(NativePolicyDoc, api.conversationId, context);
      if (!doc?.identity || doc.pending) throw new Error("Native shell identity is unavailable or needs reconciliation");
      const agent = await api.agent(context);
      // Per-command metadata; preserve managed markers inherited by the daemon.
      Object.assign(execution.env, { PI_SESSION_ID: doc.identity, PI_SESSION_FILE: "",
        PI_PROVIDER: agent.model?.provider ?? "", PI_MODEL: agent.model?.modelId ?? "", PI_REASONING_LEVEL: agent.thinkingLevel });
    });
    entry.tail = result.catch(() => {});
    try { await result; } finally { await this.releaseEnded(entry, context); }
  };
  capabilities() { return { adapter: "piccolo-native-policy-1", fingerprint: this.fingerprint,
    cachedRunners: this.runners.size, closingRunners: this.cleanup.size,
    configuredExtensions: [...this.options.paths], supportedEvents: [...supported],
    nativeToolOverrides: false, nativeCompaction: "notification-only", interactiveActions: "reject" }; }
  bind(harness: Harness) { this.harness = harness; }
  async close() {
    await Promise.allSettled(this.cleanup);
    const runners = await Promise.allSettled(this.runners.values());
    for (const result of runners) if (result.status === "fulfilled") result.value.runner.invalidate();
    this.runners.clear();
    this.stages.clear();
  }
  releaseStage(id: number) {
    const conversations = this.stages.get(id); this.stages.delete(id);
    for (const conversation of conversations ?? []) {
      const pending = this.runners.get(conversation); this.runners.delete(conversation);
      if (!pending) continue;
      const cleanup = pending.then(async entry => { await entry.tail; entry.runner.invalidate(); });
      this.cleanup.add(cleanup);
      void cleanup.finally(() => this.cleanup.delete(cleanup)).catch(() => {});
    }
  }
  private async releaseEnded(entry: Runner, context: Context) {
    try {
      const task = await this.harness!.getTask(entry.stageId as any, withoutAbortSignal(context));
      if (task?.state.status === "terminal") this.releaseStage(entry.stageId);
    } catch { /* Store shutdown owns remaining cache cleanup; preserve callback errors. */ }
  }
  private async get(api: HookApi, context: Context) {
    let pending = this.runners.get(api.conversationId);
    if (!pending) {
      pending = this.create(api, context);
      this.runners.set(api.conversationId, pending);
      void pending.catch(() => {
        if (this.runners.get(api.conversationId) !== pending) return;
        this.runners.delete(api.conversationId);
        for (const [id, conversations] of this.stages) {
          conversations.delete(api.conversationId); if (!conversations.size) this.stages.delete(id);
        }
      });
    }
    return pending;
  }
  private async create(api: HookApi, context: Context): Promise<Runner> {
    this.requireSources();
    const h = this.harness!;
    const owner = await h.snapshot(StageOwner, api.conversationId, context);
    if (!owner?.stageId) throw new Error("Native policy needs a persisted stage owner");
    const task = await h.getTask(owner.stageId as any, context);
    if (!task) throw new Error("Native policy stage is missing; no new runner was created");
    const conversations = this.stages.get(owner.stageId) ?? new Set<number>(); conversations.add(api.conversationId); this.stages.set(owner.stageId, conversations);
    const { cwd } = task!.input as any;
    const state = await h.commit(async tx => {
      const doc = await tx.doc(NativePolicyDoc, api.conversationId);
      if (doc.fingerprint && doc.fingerprint !== this.fingerprint) throw new Error("Native policy changed; explicit reconciliation required");
      doc.identity ??= randomUUID(); doc.fingerprint ??= this.fingerprint;
      return json(doc);
    }, context);
    if (state.pending) throw new Error(`Interrupted native policy event ${state.pending}; reconciliation required before continuing`);
    // inMemory keeps this filename identity without writing a second transcript.
    const manager = SessionManager.inMemory(cwd);
    manager.setSessionFile(path.join(this.options.directory, `${state.identity}.jsonl`));
    manager.newSession({ id: state.identity! });
    const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, additionalExtensionPaths: this.options.paths,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      settingsManager: SettingsManager.inMemory({ packages: [] }),
    });
    await loader.reload();
    this.requireSources();
    const loaded = loader.getExtensions();
    try {
      if (loaded.errors.length) throw new Error(`Native policy extension failed to load: ${loaded.errors.map(e => e.path).join(", ")}`);
      if (loaded.runtime.mcpServers.list().length) throw new Error("Native policy modules cannot register MCP servers");
      if (loaded.runtime.pendingProviderRegistrations.length || loaded.runtime.pendingNativeProviderRegistrations.length || loaded.runtime.pendingVirtualModelRegistrations.length)
        throw new Error("Native policy modules cannot register model providers; keep provider initialization in the worker host");
      for (const extension of loaded.extensions) {
        if (extension.tools.size) throw new Error("Native tool overrides need a qualified execution adapter");
        for (const event of extension.handlers.keys()) if (!supported.has(event)) throw new Error(`Unsupported native policy event: ${event}`);
      }
      const modules = loaded.extensions.map(extension => ({ path: extension.path, events: [...extension.handlers.keys()].sort() }));
      await h.commit(async tx => {
        const doc = await tx.doc(NativePolicyDoc, api.conversationId);
        if (doc.modules?.length && digest(doc.modules) !== digest(modules)) throw new Error("Native policy activation changed; reconciliation required");
        doc.modules = modules;
      }, context);
      const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, manager, this.options.registry);
      const entry: Runner = { runner, manager, stageId: owner.stageId, tail: Promise.resolve(), initialized: false };
      const frame = () => { if (!entry.frame) throw new Error("Native policy action outside its invocation"); return entry.frame; };
      const unsupported = () => { throw new Error("Native policy requested an unsupported session mutation or interactive action"); };
      const actions: ExtensionActions = {
        sendMessage: (message, options) => { if (options?.triggerTurn || (options?.deliverAs && options.deliverAs !== "nextTurn")) unsupported(); frame().notices.push(json(message)); },
        sendUserMessage: unsupported, appendEntry: unsupported, setSessionName: unsupported, getSessionName: () => undefined, setLabel: unsupported,
        getActiveTools: () => frame().activeTools, getAllTools: unsupported, getSettings: () => this.options.settings ?? {},
        setActiveTools: unsupported, refreshTools: unsupported, getCommands: () => [], setModel: unsupported,
        getThinkingLevel: () => frame().spec.thinkingLevel, setThinkingLevel: unsupported,
      };
      const contexts: ExtensionContextActions = {
        getModel: () => this.options.registry.find(frame().spec.model.provider, frame().spec.model.modelId), getScopedModels: () => [],
        isIdle: () => false, isProjectTrusted: this.options.isProjectTrusted, getSignal: () => frame().context.abortSignal, abort: unsupported,
        hasPendingMessages: () => false, shutdown: unsupported, getContextUsage: () => undefined, compact: unsupported, getSystemPrompt: () => frame().prompt,
      };
      runner.bindCore(actions, contexts, { registerProvider: unsupported, registerNativeProvider: unsupported, unregisterProvider: unsupported, registerVirtualModel: unsupported, unregisterVirtualModel: unsupported });
      // Approval-dependent policies must stop; there is no implicit approval in a headless worker.
      const ui = runner.getUIContext();
      runner.setUIContext({ ...ui, select: unsupported, confirm: unsupported, input: unsupported, editor: unsupported, custom: unsupported }, "rpc");
      runner.onError(error => frame().errors.push(`${error.event}: ${error.error}`));
      return entry;
    } catch (error) { loaded.runtime.invalidate(); throw error; }
  }
  private async dispatch<T>(api: HookApi, context: Context, label: string, callback: (entry: Runner, frame: Frame) => Promise<T>): Promise<T> {
    const entry = await this.get(api, context);
    const result = entry.tail.then(async () => {
      const h = this.harness!, owner = await h.snapshot(StageOwner, api.conversationId, context);
      const task = await h.getTask(owner!.stageId as any, context);
      const { spec, cwd } = task!.input as { spec: StageSpec; cwd: string };
      const conversation = (await h.conversation(api.conversationId, context))!;
      const messages = (await conversation.context(context)).messages;
      const activeTools = (await conversation.agent(context)).tools.map(tool => tool.name);
      const state = await h.commit(async tx => {
        const doc = await tx.doc(NativePolicyDoc, api.conversationId);
        if (doc.pending) throw new Error(`Interrupted native policy event ${doc.pending}; reconciliation required`);
        if (label !== "before-tool" && Object.hasOwn(doc.receipts, `${label}:${api.taskId}`)) return json(doc);
        doc.pending = `${label}:${api.taskId}`;
        return json(doc);
      }, context);
      if (label !== "before-tool" && Object.hasOwn(state.receipts, `${label}:${api.taskId}`)) return state.receipts[`${label}:${api.taskId}`] as T;
      const frame: Frame = { context, messages, spec, cwd, notices: [], errors: [], prompt: spec.instructions, activeTools, receipts: state.receipts };
      entry.frame = frame;
      entry.manager.newSession({ id: state.identity! });
      for (const message of messages) entry.manager.appendMessage(message);
      try {
        if (!entry.initialized) {
          await entry.runner.emit({ type: "session_start", reason: state.initialized ? "resume" : "new" }); entry.initialized = true;
        }
        const value = await callback(entry, frame);
        // Once a tool's terminal result exists, its cached hook output is in the
        // authoritative transcript. Keep only receipts still needed for recovery.
        const obsolete: string[] = [];
        if (label.startsWith("request:")) for (const key of Object.keys(state.receipts)) {
          if (key.startsWith("request:")) obsolete.push(key);
          else if (key.startsWith("after-tool:")) {
            const tool = await h.getTask(Number(key.split(":").at(-1)) as any, context);
            if (tool?.state.status === "terminal") obsolete.push(key);
          }
        }
        if (frame.errors.length) throw new Error(`Native policy failed: ${frame.errors.join("; ")}`);
        await h.commit(async tx => {
          const doc = await tx.doc(NativePolicyDoc, api.conversationId);
          for (const key of obsolete) delete doc.receipts[key];
          for (const notice of frame.notices) doc.messages[digest(notice)] = notice;
          if (Buffer.byteLength(JSON.stringify(doc.messages)) > 1024 * 1024) throw new Error("Native policy context exceeds 1 MiB");
          if (label !== "before-tool") doc.receipts[`${label}:${api.taskId}`] = json(value ?? null);
          if (Buffer.byteLength(JSON.stringify(doc.receipts)) > 64 * 1024 * 1024) throw new Error("Native policy receipts exceed 64 MiB; start a new stage");
          doc.pending = null; doc.initialized = true;
        }, context);
        return value;
      } finally { entry.frame = undefined; }
    });
    entry.tail = result.catch(() => {});
    try { return await result; } finally { await this.releaseEnded(entry, context); }
  }
  async beforeRequest(messages: readonly Message[], api: HookApi, context: Context) {
    // An unsafe recovery may bypass execute/after-tool entirely. Never generate
    // through that uncertain boundary, including after active-context compaction.
    if (await hasUncertainEffects(this.harness!, api.conversationId, context))
      throw new Error("Uncertain tool effect requires reconciliation before native policy can continue");
    return this.dispatch(api, context, `request:${digest(messages)}`, async (entry, frame) => {
      const current = getCurrentSystemMessage(messages);
      const original = current ? getSystemMessageText(current) : frame.spec.instructions;
      const prompt: BuildSystemPromptOptions = { cwd: frame.cwd, customPrompt: original, selectedTools: frame.activeTools };
      const last = [...messages].reverse().find(message => message.role === "user");
      const trigger = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.filter(p => p.type === "text").map(p => p.text).join("\n")) : frame.spec.task;
      const prepared = await entry.runner.emitBeforeAgentStart({ messageType: "user", prompt: trigger }, prompt);
      frame.notices.push(...prepared.messages);
      frame.prompt = renderPolicyPrompt(prepared.systemPromptOptions, prompt);
      const stored = await this.harness!.snapshot(NativePolicyDoc, api.conversationId, context);
      const notices = { ...stored?.messages };
      for (const notice of frame.notices) notices[digest(notice)] = notice;
      const policyMessages = Object.values(notices).map(message => ({ ...message, role: "custom" as const, timestamp: 0 }));
      const system = { ...current, role: "system" as const, content: frame.prompt, sections: undefined };
      const transformed = await entry.runner.emitContext([system, ...messages.filter(m => m.role !== "system"), ...policyMessages]);
      return { messages: convertToLlm(transformed) };
    });
  }
  wrap(tool: ToolRegistration): ToolRegistration {
    return { ...tool, outputLimits: { ...tool.outputLimits, maxBytes: 1024 * 1024, maxLines: 50000 }, execute: async (args, api, context) => {
      const key = digest(args);
      const validated = validateToolArguments(tool, { type: "toolCall", id: api.callId, name: tool.name, arguments: json(args) as import("@earendil-works/pi-ai").ToolCall["arguments"] });
      // Serialize the receipt check with callbacks: another tool's in-flight
      // callback must not be mistaken for an interrupted event.
      const checked = await this.dispatch(api, context, "before-tool", async (entry, frame) => {
        const receipt = frame.receipts[`after-tool:${key}:${api.taskId}`] ?? frame.receipts[`after-tool:${digest(validated)}:${api.taskId}`];
        if (receipt) return { cached: receipt as ToolExecutionResult };
        const input = json(args) as any;
        const decision = await entry.runner.emitToolCall({ type: "tool_call", toolName: tool.name, toolCallId: this.callId(api, entry), input });
        if (decision?.terminate) throw new Error("Native early tool-batch termination is not supported by this adapter");
        if (decision?.block) return { blocked: decision.reason ?? "Native policy blocked the tool" };
        if (digest(input) !== digest(args)) throw new Error("Native argument mutation needs an execution-intent adapter");
        return { args: validated };
      });
      if ("cached" in checked) return checked.cached!;
      if ("blocked" in checked) return { output: [{ type: "text", text: checked.blocked! }], isError: true };
      let result: ToolExecutionResult;
      try { result = await tool.execute(checked.args, api, context) ?? {}; }
      catch (error) { if (context.abortSignal?.aborted) throw error; result = { output: [{ type: "text", text: String(error) }], isError: true }; }
      return this.afterTool(tool, checked.args, result, api, context, key);
    } };
  }
  private callId(api: ToolExecutionApi, entry: Runner) { return `${entry.manager.getSessionId()}:${api.taskId}:${api.callId}`; }
  private async afterTool(tool: ToolRegistration, input: unknown, result: ToolExecutionResult, api: ToolExecutionApi, context: Context, key: string) {
    return this.dispatch(api, context, `after-tool:${key}`, async entry => {
      const content = result.output ?? [{ type: "text" as const, text: api.retainedOutput().text }];
      const changed = await entry.runner.emitToolResult({ type: "tool_result", toolName: tool.name, toolCallId: this.callId(api, entry),
        input: input as Record<string, unknown>, content: [...content], isError: result.isError ?? false, details: result.details, structuredContent: result.structuredOutput });
      const output = changed?.content ?? content;
      const text = output.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (Buffer.byteLength(text) > 1024 * 1024 || text.split("\n").length > 50000)
        throw new Error("Native policy output exceeds the worker limit; refusing to truncate policy context");
      if (!changed) return { ...result, output: content };
      return json({ ...result, output: changed.content ?? content, details: changed.details ?? result.details, structuredOutput: changed.structuredContent,
        isError: changed.isError ?? result.isError, usage: changed.usage ?? result.usage }) as ToolExecutionResult;
    });
  }
  async beforeCompact(compaction: Parameters<CompactionHooks["beforeCompact"]>[0], api: HookApi, context: Context) {
    return this.dispatch(api, context, "compaction", async (entry) => {
      // Notification-only compatibility. Native checkpoint/summary ownership is
      // deliberately rejected; Durable owns selection, summarization and placement.
      const result = await entry.runner.emit({ type: "session_before_compact",
        // Notification-only handlers may reset external dedup state. A handler
        // needing native selection/checkpoint metadata must use the native executor.
        get branchEntries(): never { throw new Error("Native compaction branch metadata is unavailable in Durable"); },
        get preparation(): never { throw new Error("Native compaction preparation is unavailable in Durable"); },
        reason: compaction.reason === "manual" ? "manual" : compaction.reason === "overflow" ? "overflow" : "threshold",
        willRetry: compaction.reason === "overflow", signal: context.abortSignal!,
      });
      if (result) throw new Error("Native compaction decisions require a separate qualified adapter");
      return undefined;
    });
  }
}

/** The supported prompt mutations are additive sections/context and full prompt replacement.
 * Pi 1.3 does not export its builder; reject other mutations rather than approximate them.
 */
function renderPolicyPrompt(options: BuildSystemPromptOptions, original: BuildSystemPromptOptions): string {
  const allowed = new Set(["customPrompt", "forceSystemPrompt", "sections", "contextFiles", "appendSystemPrompt"]);
  const defaults: Record<string, unknown> = { hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], skills: [] };
  for (const [key, value] of Object.entries(options)) if (!allowed.has(key) && JSON.stringify(value) !== JSON.stringify((original as any)[key] ?? defaults[key]))
    throw new Error(`Unsupported native prompt mutation: ${key}`);
  if (options.forceSystemPrompt !== undefined) return options.forceSystemPrompt;
  const sections = Object.entries(options.sections ?? {}).map(([name, text]) => {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || name === "preamble") throw new Error("Invalid policy prompt section");
    return `<${name}>\n${text}\n</${name}>`;
  });
  return [options.customPrompt, options.appendSystemPrompt, ...sections,
    ...(options.contextFiles ?? []).map(file => `# ${file.path}\n${file.content}`)].filter(Boolean).join("\n\n");
}
