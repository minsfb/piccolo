import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { packageRoot } from "./config.ts";

export function parseShellReceipt(text: string, id: string) {
  if (!text) throw new Error("missing receipt");
  if (Buffer.byteLength(text) > 4096) throw new Error("oversized receipt");
  let value: any;
  try { value = JSON.parse(text); } catch { throw new Error("malformed receipt"); }
  if (value?.format !== 1 || value.id !== id || !["completed", "timed_out", "aborted"].includes(value.reason)
      || !Number.isSafeInteger(value.guard_pid) || value.guard_pid <= 1
      || value.cleanup !== "group_kill_requested"
      || !(value.exitCode === null || Number.isInteger(value.exitCode))) throw new Error("invalid receipt identity or fields");
  if (value.reason === "completed" && (value.exitCode === null || value.exitCode < 0)) throw new Error("command ended by signal; completion was not successful");
  return value as { reason: string; exitCode: number | null; guard_pid: number; cleanup: string };
}

function evidenceDirectory(cwd: string, id: string) {
  let directory = fs.realpathSync(cwd);
  for (const part of [".cache", "piccolo", "shell", id]) {
    directory = path.join(directory, part);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error: any) { if (error.code !== "EEXIST" || part === id) throw error; }
    const info = fs.lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Shell evidence directory must not be linked");
  }
  return directory;
}

/** The launcher can fork or close extra descriptors. Control uses stdin EOF;
 * the guard writes an atomic, invocation-bound receipt in owned local evidence.
 * An explicit evidence root separates retained artifacts from the command cwd.
 * Process groups do not contain descendants that deliberately start new sessions.
 */
export function createSessionShell(python = "python3", script = path.join(packageRoot, "scripts/session-shell.py"), evidenceRoot?: string): BashOperations {
  return { async exec(command, cwd, options) {
    if (options.signal?.aborted) throw new Error("aborted");
    if (process.platform === "win32") throw new Error("Session-owned shells currently require macOS or Linux");
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout > 86400)) throw new Error("Shell timeout must be greater than zero and at most 86400 seconds");
    const id = randomUUID(), directory = evidenceDirectory(evidenceRoot ?? cwd, id);
    const receiptFile = path.join(directory, "receipt.json");
    const output = fs.openSync(path.join(directory, "output.log"), "wx", 0o600);
    let retained = 0, total = 0;
    const started = Date.now();
    return await new Promise((resolve, reject) => {
      const child = spawn(python, [script], { cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      let streamFailed = false;
      let settled = false, stopTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        child.stdin.end();
        stopTimer ??= setTimeout(() => {
          // Only the live direct child handle is signalled; never a retained PID.
          child.kill("SIGKILL");
          finish(new Error("shell supervisor did not settle after stop; cleanup unresolved"));
        }, 5000);
      };
      const timer = setTimeout(() => { stop(); }, ((options.timeout ?? 86400) * 1000) + 5000);
      const finish = (error?: Error, value?: { exitCode: number }) => {
        if (settled) return; settled = true;
        clearTimeout(timer); if (stopTimer) clearTimeout(stopTimer);
        options.signal?.removeEventListener("abort", stop);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); fs.closeSync(output);
        const result = { format: 1, id, started_at: started, finished_at: Date.now(), status: error ? "failed" : "completed",
          output_bytes: total, retained_bytes: retained, truncated: total > retained,
          receipt: "receipt.json", output: "output.log", cleanup: fs.existsSync(receiptFile) ? "inspect_receipt" : "unresolved" };
        try { fs.writeFileSync(path.join(directory, "outcome.json"), JSON.stringify(result) + "\n", { flag: "wx", mode: 0o600 }); }
        catch { error = new Error("shell outcome could not be recorded; inspect retained evidence"); }
        if (error) reject(new Error(`${error.message}; shell evidence: ${directory}`)); else resolve(value!);
      };
      child.stdin.on("error", () => {});
      const data = (bytes: Buffer) => {
        if (settled) return;
        try {
          total += bytes.length;
          const keep = bytes.subarray(0, Math.max(0, 8 * 1024 * 1024 - retained));
          if (keep.length) { fs.writeSync(output, keep); retained += keep.length; }
          options.onData(bytes);
        } catch { streamFailed = true; stop(); }
      };
      child.stdout.on("data", data); child.stderr.on("data", data);
      child.once("error", () => finish(new Error("shell supervisor could not start")));
      // close drains stdout/stderr as well as the managed launcher. A separate
      // watchdog bounds missing close events (e.g. an escaped descriptor holder).
      child.once("close", () => {
        if (settled) return;
        if (options.signal?.aborted) { finish(new Error("aborted")); return; }
        if (streamFailed) { finish(new Error("shell output delivery or recording failed")); return; }
        try {
          const info = fs.lstatSync(receiptFile);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("invalid receipt file");
          const receipt = parseShellReceipt(fs.readFileSync(receiptFile, "utf8"), id);
          if (receipt.reason === "timed_out") throw new Error(`timeout:${options.timeout}`);
          if (receipt.reason !== "completed") throw new Error("shell guard stopped without command completion");
          finish(undefined, { exitCode: receipt.exitCode! });
        } catch (error: any) { finish(new Error(error.code === "ENOENT" ? "shell supervisor exited without a receipt; cleanup unresolved" : error.message)); }
      });
      options.signal?.addEventListener("abort", stop, { once: true });
      child.stdin.write(JSON.stringify({ command, cwd, timeout: options.timeout ?? null, id, receipt: receiptFile }) + "\n");
      if (options.signal?.aborted) stop();
    });
  } };
}
export const sessionShell = createSessionShell();
