import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export type PoolSettings = { capacity?: number; queue_timeout_ms?: number; max_launches_per_session?: number };
const launches = new Map<string, number>();
export function poolDirectory(testDirectory?: string) {
  const xdg = process.env.XDG_STATE_HOME;
  return testDirectory ?? path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".local/state"), "piccolo/pool", os.hostname());
}
export async function acquireSlot(owner: string, session: string, settings: PoolSettings = {}, signal?: AbortSignal, testDirectory?: string, countLaunch = true) {
  const capacity = settings.capacity ?? 8;
  const timeout = settings.queue_timeout_ms ?? 900000;
  const maxLaunches = settings.max_launches_per_session ?? 1000;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 128 || !Number.isInteger(timeout) || timeout < 1 || !Number.isInteger(maxLaunches) || maxLaunches < 1) throw new Error("Invalid pool settings");
  const directory = poolDirectory(testDirectory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Pool directory must not be symlinked");
  const config = path.join(directory, "config.json");
  const temporary = path.join(directory, `config-${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify({ format: 1, capacity }), { flag: "wx", mode: 0o600 });
  try { fs.linkSync(temporary, config); } catch (e: any) { if (e.code !== "EEXIST") throw e; } finally { fs.unlinkSync(temporary); }
  const installed = JSON.parse(fs.readFileSync(config, "utf8"));
  if (installed.format !== 1 || installed.capacity !== capacity) throw new Error(`Host pool capacity differs. Drain/reconcile leases before updating ${config}; all clients must agree.`);
  const start = Date.now();
  while (true) {
    if (signal?.aborted) throw new Error("Cancelled while waiting for a worker slot");
    if (countLaunch && (launches.get(session) ?? 0) >= maxLaunches) throw new Error("Session launch guideline reached; parent must reconcile possible runaway work.");
    for (let index = 0; index < capacity; index++) {
      const file = path.join(directory, `slot-${index}.json`);
      const lease = { format: 1, owner, session, pid: process.pid, host: os.hostname(), acquired_at: new Date().toISOString(), id: randomUUID() };
      try { fs.writeFileSync(file, JSON.stringify(lease, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
      catch (e: any) { if (e.code === "EEXIST") continue; throw e; }
      if (countLaunch) launches.set(session, (launches.get(session) ?? 0) + 1);
      let released = false;
      return { file, waited_ms: Date.now() - start, release() {
        if (released) return;
        const current = JSON.parse(fs.readFileSync(file, "utf8"));
        if (current.id !== lease.id) throw new Error("Worker lease ownership changed; refusing to remove it");
        fs.unlinkSync(file); released = true;
      } };
    }
    if (Date.now() - start >= timeout) throw new Error("Worker pool queue timeout; inspect active or unreconciled leases before retrying");
    await new Promise(resolve => setTimeout(resolve, Math.min(100, timeout)));
  }
}
