import { workerInstructions, validateWorkerSkills } from "./resources.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { nativeCompaction } from "./compaction.ts";
import { localPolicy } from "./policy-config.ts";
import { managedModels } from "./models.ts";
import { executionEnvironments } from "./environment.ts";
import { workerTools } from "./tools.ts";
import { openWorkerStorage } from "./storage.ts";
import { DurableWorker } from "./worker.ts";
import { DurableJobs } from "./jobs.ts";
import { durablePool, type StageResources } from "./pool.ts";
import type { PoolSettings } from "../pool.ts";
import type { Workspace } from "./contract.ts";
import { requireIgnoredArtifacts } from "./artifacts.ts";
import type { Config } from "../config.ts";

export async function localJobs(root: string, ctx: ExtensionToolContext, callbacks: { nativeSettings?: Record<string, unknown>; pool?: PoolSettings; capacity?: number; maxJobs?: number; shutdownMs?: number; resume?: boolean; dispatchOnly?: boolean;
  workerPolicy?: NonNullable<Config["integration"]>["worker_policy"]; managedPolicy?: boolean; cancellationOnly?: boolean;
  changed: () => void; notify: (ids: string[]) => void }) {
  root = fs.realpathSync(root);
  // Session UUID scopes cancellation; the persistent workspace UUID is never inferred from cwd alone.
  const session = ctx.sessionManager.getSessionId();
  const directory = path.join(root, ".cache", "piccolo", "workers", session);
  requireIgnoredArtifacts(root, ["workspace.json", "worker.sqlite", "worker.sqlite-wal", "worker.sqlite-shm", "worker.sqlite-journal",
    "owner.sqlite", "owner.sqlite-wal", "owner.sqlite-shm", "owner.sqlite-journal"].map(file => path.join(directory, file)));
  let ancestor = root;
  for (const part of [".cache", "piccolo", "workers", session]) {
    if (!part || part === "." || part === ".." || /[\\/]/.test(part)) throw new Error("Invalid worker session identity");
    ancestor = path.join(ancestor, part);
    fs.mkdirSync(ancestor, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error("Worker storage must not be symlinked");
  }
  const identityFile = path.join(directory, "workspace.json");
  let workspace: Workspace;
  if (fs.existsSync(identityFile)) {
    const stat = fs.lstatSync(identityFile);
    if (!stat.isFile() || stat.size > 16000) throw new Error("Invalid worker identity file");
    workspace = JSON.parse(fs.readFileSync(identityFile, "utf8"));
  }
  else {
    workspace = { host: os.hostname(), cwd: root, identity: randomUUID() };
    fs.writeFileSync(identityFile, JSON.stringify(workspace), { flag: "wx", mode: 0o600 });
  }
  const managedPolicy = callbacks.managedPolicy || process.env.PICCOLO_REQUIRE_WORKER_POLICY === "1";
  const controllerOnly = !!callbacks.dispatchOnly && !process.env.PICCOLO_WORKER_POLICY && !callbacks.workerPolicy?.extensions.length &&
    (managedPolicy || !callbacks.workerPolicy);
  const policy = controllerOnly || callbacks.cancellationOnly ? undefined
    : localPolicy(directory, ctx, callbacks.nativeSettings, callbacks.workerPolicy, managedPolicy);
  const store = await openWorkerStorage(directory, workspace);
  const environments = executionEnvironments();
  let worker: DurableWorker | undefined;
  let resources: StageResources | undefined;
  try {
    if (!callbacks.cancellationOnly) resources = durablePool(workspace, callbacks.pool ?? { capacity: callbacks.capacity });
    worker = await DurableWorker.open({ workspace, storage: store.storage, resources, policy, dispatchOnly: controllerOnly, resume: callbacks.resume, cancellationOnly: callbacks.cancellationOnly,
      compaction: DEFAULT_COMPACTION_POLICY, reuseStoredCompaction: true, legacyCompactions: [nativeCompaction(callbacks.nativeSettings ?? {})],
      capacity: callbacks.capacity, maxJobs: callbacks.maxJobs, maxLaunchesPerOwner: callbacks.pool?.max_launches_per_session,
      models: managedModels(ctx.modelRegistry), tools: callbacks.cancellationOnly ? [] : await workerTools(policy?.prepareBash),
      env: target => environments.get(target.cwd ?? root),
      instructions: workerInstructions, validateStage: spec => validateWorkerSkills(root, spec),
    });
    const jobs = new DurableJobs(root, session, worker, { ...callbacks, release: async () => { try { await environments.close(); } finally { store.release(); } } });
    await jobs.refresh();
    return { jobs, workspace };
  } catch (error) { try { if (worker) await worker.close("suspend"); else await store.storage.close(BACKGROUND_CONTEXT); } finally { try { resources?.close(); } finally { store.release(); await environments.close(); } } throw error; }
}
