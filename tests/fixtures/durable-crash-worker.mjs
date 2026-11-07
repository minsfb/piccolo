import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { createModels, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { openWorkerStorage } from "../../src/durable/storage.ts";
import { durablePool } from "../../src/durable/pool.ts";
import { DurableWorker } from "../../src/durable/worker.ts";

const root = process.argv[2], request = JSON.parse(fs.readFileSync(path.join(root, "request.json"), "utf8"));
const replay = process.argv[3];
const models = createModels();
models.getModel = () => ({ id: "test", provider: "test", api: "openai-completions", name: "Test", reasoning: false, input: ["text"],
  contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
models.streamSimple = (_model, context) => {
  const finished = context.messages.some(message => message.role === "toolResult");
  const message = { role: "assistant", content: finished ? [{ type: "text", text: "done" }] : [{ type: "toolCall", id: "effect", name: "effect", arguments: {} }],
    api: "openai-completions", provider: "test", model: "test", stopReason: finished ? "stop" : "toolUse", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason, message }); return stream;
};
const tool = defineTool({ name: "effect", description: "Owned crash test effect", replay, parameters: Type.Object({}),
  async execute(_args, _api, ctx) {
    const file = path.join(root, "effects");
    const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) + 1 : 1;
    fs.writeFileSync(file, String(count));
    process.stdout.write(JSON.stringify({ type: "effect_started", count }) + "\n");
    if (count === 1) await new Promise((_resolve, reject) => ctx.abortSignal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    return { output: [{ type: "text", text: "effect completed" }] };
  } });
const store = await openWorkerStorage(path.join(root, "store"), request.workspace);
const resources = durablePool(request.workspace, { capacity: 1 }, path.join(root, "pool"));
const worker = await DurableWorker.open({ resources, workspace: request.workspace, storage: store.storage, models, tools: [tool], env: () => undefined });
try {
  const admission = await worker.submit(request);
  const result = await worker.wait(request.requestId);
  process.stdout.write(JSON.stringify({ type: "result", taskId: admission.taskId, outcome: result.state.outcome }) + "\n");
} finally { await worker.close("suspend"); store.release(); }
