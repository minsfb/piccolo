import { workerInstructions, validateWorkerSkills } from "../src/durable/resources.ts";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactionSchema, nativeCompaction } from "../src/durable/compaction.ts";
import { configuredPolicy, policyConfigSchema } from "../src/durable/policy-config.ts";
import { workspaceSchema } from "../src/durable/contract.ts";
import { openWorkerStorage } from "../src/durable/storage.ts";
import { managedModels } from "../src/durable/models.ts";
import { workerTools } from "../src/durable/tools.ts";
import { executionEnvironments } from "../src/durable/environment.ts";
import { DurableWorker } from "../src/durable/worker.ts";
import { durablePool, type StageResources } from "../src/durable/pool.ts";
import { serveWorker } from "../src/durable/service.ts";

const configSchema = z.strictObject({ directory: z.string().startsWith("/"), workspace: workspaceSchema,
  pool: z.strictObject({ capacity: z.number().int().min(1).max(128).optional(), queue_timeout_ms: z.number().int().min(1).optional(), max_launches_per_session: z.number().int().min(1).optional() }).optional(),
  policy: policyConfigSchema.optional(), compaction: compactionSchema.optional(),
  envCommand: z.array(z.string()).min(1).optional() });

/** Explicit worker entry point: load with managed Pi -e; deployment/auth/transport stay external. */
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
    const store = await openWorkerStorage(config.directory, config.workspace);
    const environments = executionEnvironments(config.envCommand ? { command: config.envCommand, identity: config.workspace.identity } : undefined);
    let worker: DurableWorker | undefined;
    let resources: StageResources | undefined;
    try {
      resources = durablePool(config.workspace, config.pool);
      worker = await DurableWorker.open({ workspace: config.workspace, storage: store.storage, resources, policy, compaction: config.compaction ?? DEFAULT_COMPACTION_POLICY,
        reuseStoredCompaction: config.compaction === undefined, legacyCompactions: [nativeCompaction({ ...pi.getSettings() })],
        capacity: config.pool?.capacity, maxLaunchesPerOwner: config.pool?.max_launches_per_session,
        models: managedModels(ctx.modelRegistry), tools: await workerTools(policy?.prepareBash),
        env: target => environments.get(target.cwd ?? config.workspace.cwd),
        instructions: workerInstructions, validateStage: spec => validateWorkerSkills(config.workspace.cwd, spec),
      });
      let released = false;
      const release = async () => { if (released) return; released = true; try { await environments.close(); } finally { store.release(); } process.stdout.write(JSON.stringify({ type: "piccolo_worker_closed" }) + "\n"); };
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
