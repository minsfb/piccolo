import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { NativeResult } from "./delegation.ts";
import { writeNew } from "./records.ts";

function ownedDirectory(root: string, parts: string[]): string {
  let current = fs.realpathSync(root);
  for (const part of parts) {
    current = path.join(current, part); fs.mkdirSync(current, { recursive: true });
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Evidence storage must not be symlinked");
  }
  return current;
}
export function boundNative(root: string, id: string, native: NativeResult, limit = 12000): NativeResult {
  if (!Number.isInteger(limit) || limit < 1000 || limit > 100000) throw new Error("Evidence return limit must be 1000..100000 characters");
  const text = native.result?.text ?? JSON.stringify(native.result?.value ?? "");
  if (text.length <= limit) return native;
  // Store bulky raw output outside tracked coordination records.
  try { execFileSync("git", ["-C", root, "check-ignore", "-q", ".cache/piccolo/results/probe"], { stdio: "ignore" }); }
  catch { throw new Error("Ignore .cache/ before storing a large worker result; no raw output was written."); }
  const directory = ownedDirectory(root, [".cache", "piccolo", "results"]);
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid evidence identity");
  const file = path.join(directory, `${id}.json`);
  writeNew(file, native);
  const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return { requestId: native.requestId, runId: native.runId, status: native.status, model: native.model, thinking: native.thinking, usage: native.usage,
    error: native.error?.slice(0, limit), result: { kind: "text", text: text.slice(0, limit) + "\n[Truncated; inspect the retained artifact.]" }, raw_artifact: { host: os.hostname(), path: file, sha256, characters: text.length } };
}
export function navigation(file: string, host = os.hostname(), local = false, editor = "vscode") {
  if (!path.isAbsolute(file) || !/^[a-zA-Z0-9_.-]+$/.test(host)) throw new Error("Navigation requires an absolute path and a plain hostname");
  if (!["vscode", "cursor"].includes(editor)) throw new Error("Unknown editor scheme");
  const encoded = file.split(path.sep).map(encodeURIComponent).join("/");
  return {
    host, path: file,
    code_url: local ? `${editor}://file${encoded}` : `${editor}://vscode-remote/ssh-remote+${encodeURIComponent(host)}${encoded}`,
    code_argv: local ? ["code", file] : ["code", "--remote", `ssh-remote+${host}`, file],
    reveal_argv: local && process.platform === "darwin" ? ["open", "-R", file] : null,
  };
}
export async function evidence(root: string, input: { file: string; summary: string; preview?: string; local?: boolean }) {
  const file = fs.realpathSync(path.resolve(root, input.file));
  const stat = fs.statSync(file);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error("Evidence must identify a regular file or workspace directory");
  if (input.summary.length > 6000) throw new Error("Evidence summary exceeds 6000 characters");
  let preview: string | undefined;
  if (input.preview) {
    const url = new URL(input.preview);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(k => /token|secret|password|signature|credential/i.test(k))) throw new Error("Preview must be an HTTP(S) URL without credentials");
    preview = url.href;
  }
  let sha256: string | undefined;
  if (stat.isFile()) {
    const hash = createHash("sha256"); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); sha256 = hash.digest("hex");
    const after = fs.statSync(file);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error("Artifact changed while hashing; retry when writing has finished");
  }
  let candidate: string | undefined; let dirty: boolean | undefined; let workspace: string | undefined;
  try {
    const location = stat.isDirectory() ? file : path.dirname(file);
    workspace = execFileSync("git", ["-C", location, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    candidate = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    dirty = !!execFileSync("git", ["-C", workspace, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { /* Non-Git artifact workspace is valid. */ }
  const id = randomUUID(); const directory = ownedDirectory(root, [".piccolo", "evidence"]);
  const record = path.join(directory, `${id}.json`);
  const result = { format: 1, id, created_at: new Date().toISOString(), summary: input.summary, workspace, candidate, worktree_dirty: dirty,
    artifact: { ...navigation(file, os.hostname(), input.local), kind: stat.isFile() ? "file" : "directory", bytes: stat.isFile() ? stat.size : undefined, sha256 }, preview,
    retention: "retain until parent/human confirms review and dependency needs are satisfied", record };
  writeNew(record, result); return result;
}
