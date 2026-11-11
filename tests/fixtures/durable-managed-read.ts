import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { qualificationControl } from "./durable-qualification-control.ts";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DurableWorker } from "../../src/durable/worker.ts";
import durableWorkerExtension from "../../integrations/durable-worker.ts";

/** Owned fault injection. Production owns config, policy, storage, environment,
 * compaction, startup and shutdown; only model/tool boundaries are instrumented. */
export default function instrumentedWorker(pi: ExtensionAPI) {
  const open = DurableWorker.open.bind(DurableWorker);
  DurableWorker.open = async options => {
    const config = JSON.parse(fs.readFileSync(process.env.PICCOLO_WORKER_CONFIG!, "utf8"));
    const stream = options.models.streamSimple.bind(options.models);
    const models = { ...options.models, streamSimple(model: any, transcript: any, request: any) {
      const inputs = transcript.messages.filter((message: any) => message.role === "user").map((message: any) => message.content);
      const envLoss = inputs.includes("PICCOLO_TEST_ENV_LOSS");
      if (!envLoss && !inputs.includes("PICCOLO_TEST_CRASH_GATE")) return stream(model, transcript, request);
      if (envLoss) {
        const counter = path.join(options.workspace.cwd, ".cache/env-loss-model-calls");
        fs.writeFileSync(counter, String((fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1));
      }
      // Deterministic fault injection is distinct from real model inference.
      const events = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", provider: "fixture", model: "fault-injection", api: "openai-completions", timestamp: Date.now(),
        stopReason: "toolUse", content: [{ type: "toolCall", id: "fixture-crash-gate", name: "bash", arguments: {
          command: envLoss
            ? 'printf "started\\n" >> .cache/env-loss-marker; echo $$ > .cache/env-loss-shell.pid; sleep 120'
            : 'printf "started\\n" >> .cache/unsafe-marker; echo $$ > .cache/unsafe-shell.pid; sleep 120' } }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      events.push({ type: "done", reason: "toolUse", message }); return events;
    } };
    const tools = options.tools.map(tool => tool.name !== "read" ? tool : { ...tool, async execute(args: any, api: any, ctx: any) {
      if (args.path === ".cache/replay.txt") {
        const cwd = (await api.agent(ctx)).cwd, attempts = path.join(cwd, ".cache/read-attempts");
        const count = fs.existsSync(attempts) ? Number(fs.readFileSync(attempts, "utf8")) + 1 : 1;
        fs.writeFileSync(attempts, String(count));
        if (count === 1) await new Promise<void>((_resolve, reject) => {
          ctx.abortSignal.throwIfAborted();
          ctx.abortSignal.addEventListener("abort", () => reject(new Error("fixture read interrupted")), { once: true });
        });
      }
      return tool.execute(args, api, ctx);
    } });
    const worker = await open({ ...options, models, tools });
    let stopControl: (() => void) | undefined;
    try { stopControl = await qualificationControl(worker, config.directory); }
    catch (error) { await worker.close("suspend"); throw error; }
    const close = worker.close.bind(worker);
    worker.close = async (...args) => { try { return await close(...args); } finally { stopControl?.(); } };
    return worker;
  };
  durableWorkerExtension(pi);
}
