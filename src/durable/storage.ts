import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteStorage, type SqliteDatabase, type SqliteExecutor, type SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import type { Workspace } from "./contract.ts";

type Statement = { run(...args: SqliteValue[]): unknown; get(...args: SqliteValue[]): unknown; all(...args: SqliteValue[]): unknown[] };
type Database = { exec(sql: string): unknown; prepare(sql: string): Statement; close(): void };
async function database(file: string): Promise<Database> {
  if ("Bun" in globalThis) {
    const moduleName = "bun:sqlite";
    const { Database } = await import(moduleName);
    return new Database(file, { create: true });
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(file);
}

/** Serialize transactions across await points for both Node SQLite and the managed Bun host. */
export class SerializedDatabase implements SqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private db: Database;
  constructor(db: Database) { this.db = db; }
  private queue<T>(run: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(() => { if (this.closed) throw new Error("SQLite is closed"); return run(); });
    this.tail = result.catch(() => {});
    return result;
  }
  exec(sql: string) { return this.queue(() => { this.db.exec(sql); }); }
  run(sql: string, ...params: SqliteValue[]) { return this.queue(() => { this.db.prepare(sql).run(...params); }); }
  get<T extends object>(sql: string, ...params: SqliteValue[]) { return this.queue(() => (this.db.prepare(sql).get(...params) ?? undefined) as T | undefined); }
  all<T extends object>(sql: string, ...params: SqliteValue[]) { return this.queue(() => this.db.prepare(sql).all(...params) as T[]); }
  transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.queue(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      let live = true;
      const check = () => { if (!live) throw new Error("Transaction has ended"); };
      const tx: SqliteExecutor = {
        exec: async sql => { check(); this.db.exec(sql); },
        run: async (sql, ...args) => { check(); this.db.prepare(sql).run(...args); },
        get: async <V extends object>(sql: string, ...args: SqliteValue[]) => { check(); return (this.db.prepare(sql).get(...args) ?? undefined) as V | undefined; },
        all: async <V extends object>(sql: string, ...args: SqliteValue[]) => { check(); return this.db.prepare(sql).all(...args) as V[]; },
      };
      try { const result = await callback(tx); this.db.exec("COMMIT"); return result; }
      catch (error) {
        try { this.db.exec("ROLLBACK"); } catch (rollback) { throw new AggregateError([error, rollback], "SQLite rollback failed"); }
        throw error;
      } finally { live = false; }
    });
  }
  close() { if (this.closed) return Promise.resolve(); return this.queue(() => { this.db.close(); this.closed = true; }); }
}

/** Kernel-backed single owner lock, released on process death. Stores are host-local, never shared between hosts. */
export async function openWorkerStorage(directory: string, workspace: Workspace) {
  if (workspace.host !== os.hostname() || fs.realpathSync(workspace.cwd) !== workspace.cwd) throw new Error("Worker workspace does not match this host/canonical directory");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Worker store must be a private owned directory");
  for (const file of ["owner.sqlite", "worker.sqlite"]) {
    const target = path.join(directory, file);
    if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) throw new Error("Invalid worker database path");
  }
  const lock = await database(path.join(directory, "owner.sqlite"));
  try {
    lock.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS identity (value TEXT NOT NULL)");
    lock.exec("BEGIN EXCLUSIVE");
    const stored = lock.prepare("SELECT value FROM identity").get() as { value: string } | undefined;
    const identity = JSON.stringify(workspace);
    if (stored && stored.value !== identity) throw new Error("Worker store identity mismatch");
    if (!stored) {
      lock.prepare("INSERT INTO identity(value) VALUES (?)").run(identity);
      lock.exec("COMMIT; BEGIN EXCLUSIVE");
    }
    const db = await database(path.join(directory, "worker.sqlite"));
    try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    const storage = await SqliteStorage.open(new SerializedDatabase(db));
    let released = false;
    return { storage, release: () => { if (!released) { released = true; lock.close(); } } };
    } catch (error) { db.close(); throw error; }
  } catch (error) { lock.close(); throw error; }
}
