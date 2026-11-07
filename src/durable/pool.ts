import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { acquireSlot, poolDirectory, type PoolSettings } from "../pool.ts";
import type { Context } from "@earendil-works/chord/context";
import type { Workspace } from "./contract.ts";
import { defineDoc, type HookApi } from "@earendil-works/pi-durable";

export type StageResources = {
  acquire(id: number, context: Context): Promise<void>;
  release(id: number): void;
  close(): void;
};

/** Construct only while holding this workspace's SQLite owner lock. */
export function durablePool(workspace: Workspace, settings: PoolSettings = {}, directory?: string): StageResources {
  const prefix = `durable:${workspace.identity}:`, home = poolDirectory(directory);
  // Reconcile only this store's dead process leases. A live/reused PID remains a manual decision.
  for (let index = 0; index < 128; index++) {
    const file = path.join(home, `slot-${index}.json`);
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 16000) throw new Error("Invalid host pool lease");
    const lease = JSON.parse(fs.readFileSync(file, "utf8"));
    if (lease.host !== workspace.host || !String(lease.owner).startsWith(prefix)) continue;
    if (workspace.host !== os.hostname() || !Number.isSafeInteger(lease.pid) || lease.pid <= 0) throw new Error("Invalid Durable pool owner");
    try { process.kill(lease.pid, 0); throw new Error("Prior Durable pool owner is still alive; reconcile its lease"); }
    catch (error: any) { if (error.code !== "ESRCH") throw error; }
    if (JSON.parse(fs.readFileSync(file, "utf8")).id !== lease.id) throw new Error("Pool lease changed during reconciliation");
    fs.unlinkSync(file);
  }
  const held = new Map<number, Awaited<ReturnType<typeof acquireSlot>>>();
  const acquiring = new Map<number, Promise<void>>();
  let closed = false;
  return {
    async acquire(id, context) {
      if (closed) throw new Error("Worker pool is closed");
      if (held.has(id)) return;
      const pending = acquiring.get(id);
      if (pending) return pending;
      // Reacquiring a persisted stage after restart is not a new launch. Worker
      // admissions enforce owner budgets; a long-lived store is not a session.
      const acquisition = acquireSlot(`${prefix}${id}`, workspace.identity, settings, context.abortSignal, directory, false).then(lease => {
        if (closed) { lease.release(); throw new Error("Worker pool closed during admission"); }
        held.set(id, lease);
      });
      acquiring.set(id, acquisition);
      try { await acquisition; } finally { acquiring.delete(id); }
    },
    release(id) { const lease = held.get(id); if (lease) { lease.release(); held.delete(id); } },
    close() {
      closed = true;
      const errors: unknown[] = [];
      for (const [id, lease] of held) try { lease.release(); held.delete(id); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Worker pool leases require reconciliation");
    },
  };
}

// Conversation ownership is persisted so recovered generation/tool tasks acquire
// capacity before executing, even when the scheduler resumes a child first.
export const StageOwner = defineDoc<{ stageId: number | null }>({ kind: "piccolo.stage-owner", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ stageId: null }) });
export async function acquireConversation(resources: StageResources | undefined, api: HookApi, context: Context) {
  if (!resources) return;
  const owner = await api.snapshot(StageOwner, api.conversationId, context);
  if (!owner?.stageId) throw new Error("Conversation has no persisted capacity owner; reconcile before resuming this registry version");
  await resources.acquire(owner.stageId, context);
}
