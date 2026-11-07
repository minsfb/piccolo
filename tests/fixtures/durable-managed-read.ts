import { workerInstructions, validateWorkerSkills } from "../../src/durable/resources.ts";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { qualificationControl } from "./durable-qualification-control.ts";
import { compactionSchema, nativeCompaction } from "../../src/durable/compaction.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configuredPolicy, policyConfigSchema } from "../../src/durable/policy-config.ts";
import type { NativePolicy } from "../../src/durable/native-policy.ts";
import { workspaceSchema } from "../../src/durable/contract.ts";
import { openWorkerStorage } from "../../src/durable/storage.ts";
import { managedModels } from "../../src/durable/models.ts";
import { workerTools } from "../../src/durable/tools.ts";
import { executionEnvironments } from "../../src/durable/environment.ts";
import { DurableWorker } from "../../src/durable/worker.ts";
import { durablePool, type StageResources } from "../../src/durable/pool.ts";
import { serveWorker } from "../../src/durable/service.ts";

const configSchema = z.strictObject({ directory: z.string().startsWith("/"), workspace: workspaceSchema,
  pool: z.strictObject({ capacity: z.number().int().min(1).max(128).optional(), queue_timeout_ms: z.number().int().min(1).optional(), max_launches_per_session: z.number().int().min(1).optional() }).optional(),
  policy: policyConfigSchema.optional(), compaction: compactionSchema.optional(),
  envCommand: z.array(z.string()).min(1).optional() });

/** Owned live fixture. Pause one safe read so the runner can kill the actual
 * managed runtime after intent. Production worker/service/storage remain in use. */
async function instrumentedTools(policy?: NativePolicy) {
  return (await workerTools(policy?.prepareBash)).map(tool => tool.name !== "read" ? tool : { ...tool,
    async execute(args: any, api: any, ctx: any) {
      if (args.path === ".cache/replay.txt") {
        const cwd = (await api.agent(ctx)).cwd;
        const attempts = path.join(cwd, ".cache/read-attempts");
        const count = fs.existsSync(attempts) ? Number(fs.readFileSync(attempts, "utf8")) + 1 : 1;
        fs.writeFileSync(attempts, String(count));
        if (count === 1) await new Promise<void>((_resolve, reject) => {
          ctx.abortSignal.throwIfAborted();
          ctx.abortSignal.addEventListener("abort", () => reject(new Error("fixture read interrupted")), { once: true });
        });
      }
      return tool.execute(args, api, ctx);
    },
  });
}
export default function durableWorkerExtension(pi: ExtensionAPI) {
  let stop: (() => Promise<void>) | undefined;
  pi.on("session_start", async (_event, ctx) => {
    try {
    if (stop) throw new Error("A worker host cannot replace its owning Pi session");
    const configFile = process.env.PICCOLO_WORKER_CONFIG;
    if (!configFile) throw new Error("PICCOLO_WORKER_CONFIG must identify a private worker configuration file");
    const config = configSchema.parse(JSON.parse(fs.readFileSync(configFile, "utf8")));
    if (config.policy && config.envCommand) throw new Error("Native policy requires the worker beside its execution environment");
    const policy = config.policy ? configuredPolicy(config.policy, config.directory, ctx, { ...pi.getSettings() }) : undefined;
    const models = managedModels(ctx.modelRegistry);
    const stream = models.streamSimple;
    models.streamSimple = (model, transcript, options) => {
      // Native hidden rule messages may follow the submitted user input.
      const inputs = transcript.messages.filter(message => message.role === "user").map(message => message.content);
      const envLoss = inputs.includes("PICCOLO_TEST_ENV_LOSS");
      if (!envLoss && !inputs.includes("PICCOLO_TEST_CRASH_GATE")) return stream(model, transcript, options);
      if (envLoss) {
        const counter = path.join(config.workspace.cwd, ".cache/env-loss-model-calls");
        fs.writeFileSync(counter, String((fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1));
      }
      // Deterministic, explicitly labelled fault injection; this is not inference.
      const events = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", provider: "fixture", model: "fault-injection", api: "openai-completions", timestamp: Date.now(),
        stopReason: "toolUse", content: [{ type: "toolCall", id: "fixture-crash-gate", name: "bash", arguments: {
          command: envLoss
            ? 'printf "started\\n" >> .cache/env-loss-marker; echo $$ > .cache/env-loss-shell.pid; sleep 120'
            : 'printf "started\\n" >> .cache/unsafe-marker; echo $$ > .cache/unsafe-shell.pid; sleep 120' } }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      events.push({ type: "done", reason: "toolUse", message }); return events;
    };
    const store = await openWorkerStorage(config.directory, config.workspace);
    const environments = executionEnvironments(config.envCommand ? { command: config.envCommand, identity: config.workspace.identity } : undefined);
    let worker: DurableWorker | undefined;
    let resources: StageResources | undefined;
    try {
      resources = durablePool(config.workspace, config.pool);
      worker = await DurableWorker.open({ workspace: config.workspace, storage: store.storage, resources, policy, compaction: config.compaction ?? nativeCompaction({ ...pi.getSettings() }), capacity: config.pool?.capacity, models, tools: await instrumentedTools(policy),
        env: target => environments.get(target.cwd ?? config.workspace.cwd),
        instructions: workerInstructions, validateStage: spec => validateWorkerSkills(config.workspace.cwd, spec),
      });
      const stopQualification = await qualificationControl(worker, config.directory);
      let released = false;
      const release = async () => { if (released) return; released = true; stopQualification(); try { await environments.close(); } finally { store.release(); } process.stdout.write(JSON.stringify({ type: "piccolo_worker_closed" }) + "\n"); };
      const server = await serveWorker(worker, config.workspace, path.join(config.directory, "worker.sock"), release);
      stop = async () => { server.close(); await worker!.close("suspend"); await release(); };
      process.stdout.write(JSON.stringify({ type: "piccolo_worker_ready", workspace: config.workspace }) + "\n");
    } catch (error) {
      try { if (worker) await worker.close("suspend"); else await store.storage.close(BACKGROUND_CONTEXT); }
      finally { try { resources?.close(); } finally { store.release(); await environments.close(); } }
      throw error;
    }
    } catch (error) {
      process.stdout.write(JSON.stringify({ type: "piccolo_worker_error", error: String(error) }) + "\n");
      throw error;
    }
  });
  pi.on("session_shutdown", async () => { await stop?.(); });
}
