import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { z } from "zod";
import { digest, effortSchema, packageRoot, type Resolved } from "./config.ts";
import { writeNew } from "./records.ts";
import { navigation } from "./evidence.ts";

const idSchema = z.string().uuid();
const requestSchema = z.strictObject({ format: z.literal(1), action: z.enum(["start", "status"]),
  id: idSchema, hostname: z.string().min(1), cwd: z.string().min(1),
  task: z.string().min(1).max(100000).optional(), model: z.string().max(512).regex(/^[^/\s]+\/\S+$/).optional(),
  effort: effortSchema.optional(), timeout_ms: z.number().int().min(1000).max(86400000).optional() });
export type RemoteRequest = z.infer<typeof requestSchema>;

async function* boundedLines(file: string, oversized: () => void) {
  let pending = "", bytes = 0, dropping = false;
  for await (const chunk of fs.createReadStream(file, { encoding: "utf8" })) {
    const pieces = chunk.split("\n");
    for (let i = 0; i < pieces.length; i++) {
      if (!dropping) {
        bytes += Buffer.byteLength(pieces[i], "utf8");
        if (bytes > 1048576) { oversized(); pending = ""; dropping = true; }
        else pending += pieces[i];
      }
      if (i < pieces.length - 1) {
        if (!dropping) yield pending;
        pending = ""; bytes = 0; dropping = false;
      }
    }
  }
  if (pending && !dropping) yield pending;
}

// Files belong to the current OS user. This is a trusted transport endpoint,
// not a network service, credentials broker, or sandbox boundary.
function directory(root: string, parts: string[]) {
  let current = fs.realpathSync(root);
  for (const part of parts) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (e: any) { if (e.code !== "EEXIST") throw e; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Remote storage must be a real directory");
  }
  return current;
}
function read(file: string) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Remote record must not be a symlink");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function jobDirectory(cwd: string, id: string, create = false) {
  idSchema.parse(id);
  if (create) return directory(cwd, [".piccolo", "remote-jobs", id]);
  let current = fs.realpathSync(cwd);
  for (const part of [".piccolo", "remote-jobs", id]) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Remote storage must be a real directory");
  }
  return current;
}
export function remoteStatus(cwd: string, id: string) {
  const job = jobDirectory(cwd, id);
  const launch = read(path.join(job, "launch.json"));
  const outcomeFile = path.join(job, "outcome.json");
  const startedFile = path.join(job, "started.json");
  return { format: 1, id, hostname: os.hostname(), cwd: launch.cwd,
    state: fs.existsSync(outcomeFile) ? "terminal" : "unresolved",
    started: fs.existsSync(startedFile) ? read(startedFile) : null,
    outcome: fs.existsSync(outcomeFile) ? read(outcomeFile) : null,
    session: launch.session, launch_digest: launch.request_digest,
    note: "No terminal receipt means unresolved, not proof of an active worker. Reattach never relaunches work." };
}
export function remoteRequest(value: unknown) {
  const request = requestSchema.parse(value);
  if (request.hostname !== os.hostname()) throw new Error("Transport reached the wrong host");
  if (!path.isAbsolute(request.cwd)) throw new Error("Remote cwd must be absolute");
  const cwd = fs.realpathSync(request.cwd);
  if (request.action === "status") return remoteStatus(cwd, request.id);
  if (!request.task) throw new Error("A start request requires a task");
  // Both native transcript and task are private runtime data; the small launch
  // record references them without placing prompts or model responses in Git.
  execFileSync("git", ["-C", cwd, "check-ignore", "-q", ".cache/piccolo/remote/probe"], { stdio: "ignore" });
  const job = jobDirectory(cwd, request.id, true);
  const launchFile = path.join(job, "launch.json");
  if (fs.existsSync(launchFile)) {
    if (read(launchFile).request_digest !== digest(request)) throw new Error("Job identity already belongs to a different request");
    return remoteStatus(cwd, request.id);
  }
  const raw = directory(cwd, [".cache", "piccolo", "remote", request.id]);
  const session = path.join(raw, "session.jsonl");
  // Exclusive claim before spawning: a crash leaves an unresolved job, never
  // permission to replay a possibly effectful model request.
  writeNew(launchFile, { format: 1, id: request.id, hostname: os.hostname(), cwd, session,
    request_digest: digest(request), created_at: new Date().toISOString(), piccolo_version: read(path.join(packageRoot, "package.json")).version });
  writeNew(path.join(raw, "request.json"), request);
  const log = fs.openSync(path.join(raw, "worker.log"), "wx", 0o600);
  try {
    const child = spawn(process.execPath, [path.join(packageRoot, "bin/remote-worker.mjs"), cwd, request.id], { cwd, detached: true, stdio: ["ignore", log, log] });
    child.on("error", error => {
      writeNew(path.join(job, "outcome.json"), { status: "startup_error", error: error.message });
    });
    child.unref();
  } finally { fs.closeSync(log); }
  return remoteStatus(cwd, request.id);
}

export async function remoteWorker(cwd: string, id: string) {
  const job = jobDirectory(cwd, id);
  const launch = read(path.join(job, "launch.json"));
  const raw = path.dirname(launch.session);
  const request = requestSchema.parse(read(path.join(raw, "request.json")));
  if (digest(request) !== launch.request_digest) throw new Error("Remote request changed after admission");
  // Exclusive worker claim also rejects accidental duplicate worker processes.
  writeNew(path.join(job, "started.json"), { worker_pid: process.pid, at: new Date().toISOString() });
  const output = fs.openSync(path.join(raw, "stdout.jsonl"), "wx", 0o600);
  const errors = fs.openSync(path.join(raw, "stderr.log"), "wx", 0o600);
  let timedOut = false;
  let nativeError: string | undefined;
  let code: number | null = null;
  try {
    const args = ["--approve", "--mode", "json", "--session", launch.session];
    if (request.model) args.push("--model", request.model);
    if (request.effort) args.push("--thinking", request.effort);
    // Native Pi reads a piped prompt, avoiding task content in argv/process lists.
    args.push("-p");
    const child = spawn("pi", args, { cwd, detached: true, stdio: ["pipe", output, errors] });
    child.stdin!.on("error", () => { /* EPIPE is reflected by the child outcome. */ });
    child.stdin!.end(request.task);
    let escalation: Promise<void> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
        escalation = new Promise(resolve => setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Owned group already exited. */ }
          resolve();
        }, 1000));
      }
    }, request.timeout_ms ?? 3600000);
    try {
      code = await new Promise<number | null>(resolve => {
        child.once("error", error => { nativeError = error.message; resolve(null); });
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
      // Leader exit does not imply descendant exit. Keep the escalation alive
      // and complete it before writing any terminal timeout receipt.
      if (escalation) await escalation;
    }
  } catch (error) { nativeError = String(error); }
  finally { fs.closeSync(output); fs.closeSync(errors); }
  const models = new Set<string>(); let response = "";
  // Process line-by-line to avoid loading an arbitrarily large native transcript.
  for await (const line of boundedLines(path.join(raw, "stdout.jsonl"), () => { nativeError = "Native output record exceeds 1 MiB; inspect retained raw diagnostics"; })) {
    try {
      const e = JSON.parse(line);
      const message = e.type === "message_end" ? e.message : null;
      if (message?.role === "assistant") {
        if (typeof message.provider === "string" && typeof message.model === "string") {
          const identity = `${message.provider}/${message.model}`;
          if (Buffer.byteLength(identity, "utf8") > 512) nativeError = "Native model identity exceeds 512 bytes; inspect retained raw diagnostics";
          else if (!models.has(identity) && models.size >= 64) nativeError = "Native output contains more than 64 distinct model identities";
          else models.add(identity);
        }
        if (["error", "aborted"].includes(message.stopReason)) nativeError = message.errorMessage || message.stopReason;
        const text = message.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        if (text) response = text.slice(0, 12000);
      }
    } catch { /* Non-JSON launcher diagnostics are retained, not model evidence. */ }
  }
  if (request.model && (models.size !== 1 || !models.has(request.model))) nativeError = "Actual model identity did not match requested model";
  if (!models.size || !fs.existsSync(launch.session)) nativeError ??= "No native assistant/session evidence";
  writeNew(path.join(job, "outcome.json"), { format: 1, id, finished_at: new Date().toISOString(),
    status: timedOut ? "timed_out" : nativeError || code !== 0 ? "failed" : "completed", exit_code: code,
    models: [...models].slice(0, 64), error: nativeError?.slice(0, 4000), response, raw_directory: raw,
    note: "Native execution outcome; task correctness and deliverables require review." });
}

export function transportRequest(argv: string[], request: unknown, timeoutMs = 30000, acceptErrorResponse = false, maxResponseBytes = 1048576, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let failure: Error | undefined;
    let escalation: Promise<void> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      output = "";
      child.stdin.destroy();
      // Drain without retaining more output while the owned transport exits.
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
        escalation = new Promise(resolve => setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Owned group already exited. */ }
          child.stdout.destroy(); child.stderr.destroy();
          resolve();
        }, 1000));
      }
    };
    const timer = setTimeout(() => stop(new Error("Transport timed out; inspect the same job identity, do not submit a replacement")), timeoutMs);
    const abort = () => stop(new Error("Transport waiter cancelled; remote work is unchanged"));
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", data => { if (!failure) { output += data; if (Buffer.byteLength(output, "utf8") > maxResponseBytes) stop(new Error("Transport response too large")); } });
    child.stderr.resume();
    child.once("error", e => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(e); });
    child.once("close", async code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (escalation) await escalation;
      if (failure) return reject(failure);
      if (code !== 0 && !acceptErrorResponse) return reject(new Error(`Transport exited ${code}; job state is unknown. Diagnostics retained by transport; no automatic retry.`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Transport did not return one JSON response; job state is unknown")); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
export async function remoteClient(root: string, resolved: Resolved, host: string, action: "start" | "status", options: { id?: string; task?: string; model?: string; effort?: string; timeout_ms?: number }) {
  const target = resolved.config.hosts?.[host];
  if (!target) throw new Error(`Unknown explicit host: ${host}`);
  if (!target.transport) throw new Error("Host has no legacy transport configured");
  const id = options.id ?? (action === "start" ? randomUUID() : undefined);
  const request = requestSchema.parse({ format: 1, action, id, hostname: target.hostname, cwd: target.cwd,
    ...(action === "start" ? { task: options.task, model: options.model, effort: options.effort, timeout_ms: options.timeout_ms } : {}) });
  const local = directory(root, [".piccolo", "remotes"]);
  const record = path.join(local, `${id}.json`);
  if (action === "start") writeNew(record, { format: 1, id, host, hostname: target.hostname, cwd: target.cwd, request_digest: digest(request), config_digest: resolved.digest, created_at: new Date().toISOString() });
  else if (fs.existsSync(record)) {
    const previous = read(record);
    if (previous.hostname !== target.hostname || previous.cwd !== target.cwd) throw new Error("Host mapping changed; restore the original mapping before reattaching");
  }
  try {
    const result = await transportRequest(target.transport, request);
    if (result.id !== id || result.hostname !== target.hostname || result.cwd !== target.cwd) throw new Error("Transport response identity mismatch");
    if (fs.existsSync(record) && read(record).request_digest !== result.launch_digest) throw new Error("Remote launch differs from retained local identity");
    return { ...result, host, local_record: record,
      workspace: navigation(target.cwd, target.hostname, false, target.editor),
      session_artifact: navigation(result.session, target.hostname, false, target.editor),
      navigation_note: "Editor remote URLs require a separately working SSH/editor connection; this transport does not establish one." };
  } catch (error) { throw new Error(`Remote job ${id} on ${host}: ${String(error)}. Reattach with remote status --host ${host} --id ${id}.`); }
}
