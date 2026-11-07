import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { createSessionShell } from "./session-shell.ts";
import { git } from "./workflow.ts";
import { checkInputSchema } from "./validation-schema.ts";
import { writeNew } from "./records.ts";

// Python import caches are incidental outputs, not candidate changes. Suppress
// their creation at execution; keep the normal source/untracked drift checks.
const environmentOverrides = { PYTHONDONTWRITEBYTECODE: "1" } as const;

export const checkReceiptSchema = z.strictObject({
  format: z.literal(1), id: z.string().uuid(), check: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/),
  branch: z.string().min(1).max(2000), candidate: z.string().regex(/^[a-f0-9]{40,64}$/), command: z.string().min(1).max(16000), cwd: z.string(),
  boundary: z.enum(["isolated", "integration", "live"]), scope: z.string().min(1).max(2000),
  started_at: z.iso.datetime(), finished_at: z.iso.datetime(),
  status: z.enum(["pass", "fail", "timed_out", "cancelled", "unknown", "stale"]),
  exit_code: z.number().int().min(0).max(255).nullable(), output: z.literal("output.log"), output_sha256: z.string().regex(/^[a-f0-9]{64}$/), error: z.string().max(4000).optional(),
  output_bytes: z.number().int().nonnegative(), retained_bytes: z.number().int().nonnegative(),
  provenance: z.literal("harness_execution"), retry_of: z.string().uuid().optional(), retry_reason: z.string().min(1).max(2000).optional(),
  environment_overrides: z.strictObject({ PYTHONDONTWRITEBYTECODE: z.literal("1") }).optional(),
}).refine(r => r.status !== "pass" || r.exit_code === 0, "Passing check requires exit 0")
  .refine(r => r.status !== "fail" || (r.exit_code !== null && r.exit_code !== 0), "Failed check requires nonzero exit")
  .refine(r => !["timed_out", "cancelled", "unknown"].includes(r.status) || r.exit_code === null, "Incomplete execution cannot claim an exit code")
  .refine(r => r.finished_at >= r.started_at && r.retained_bytes <= r.output_bytes, "Invalid receipt chronology or byte counts");
export type CheckReceipt = z.infer<typeof checkReceiptSchema>;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function home(root: string, create = false) {
  let directory = fs.realpathSync(root);
  for (const part of [".cache", "piccolo", "checks"]) {
    directory = path.join(directory, part);
    if (create) { try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error: any) { if (error.code !== "EEXIST") throw error; } }
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error("Check storage must not be linked");
  }
  return directory;
}
function clean(root: string, expected?: string) {
  const head = git(root, "rev-parse", "HEAD");
  if ((expected && expected !== head) || git(root, "status", "--porcelain")) throw new Error("Check requires the specified clean candidate; reconcile changes first");
  return head;
}
export function readCheck(root: string, id: string): CheckReceipt {
  if (!z.string().uuid().safeParse(id).success) throw new Error("Expected check attempt UUID");
  const directory = path.join(home(root), id);
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error("Invalid check directory");
  const read = (name: string, limit: number) => {
    const file = path.join(directory, name), info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error("Invalid check evidence");
    return fs.readFileSync(file);
  };
  const receipt = checkReceiptSchema.parse(JSON.parse(read("receipt.json", 256 * 1024).toString()));
  const output = read("output.log", 8 * 1024 * 1024);
  if (receipt.id !== id || hash(output) !== receipt.output_sha256 || output.length !== receipt.retained_bytes) throw new Error("Check evidence integrity mismatch");
  return receipt;
}
export async function executeCheck(root: string, input: { check: string; command: string; cwd?: string; boundary: "isolated" | "integration" | "live"; scope: string; candidate?: string; timeout_ms?: number; retry_of?: string; retry_reason?: string }, signal?: AbortSignal) {
  input = checkInputSchema.parse(input);
  const timeout = input.timeout_ms!;
  root = fs.realpathSync(root); const cwd = fs.realpathSync(input.cwd ? path.resolve(root, input.cwd) : root);
  if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new Error("Check cwd must belong to its candidate worktree");
  if (input.retry_of && readCheck(root, input.retry_of).check !== input.check) throw new Error("Retry check identity differs");
  if (fs.realpathSync(git(cwd, "rev-parse", "--show-toplevel")) !== root) throw new Error("Check cwd belongs to a different Git worktree");
  git(root, "check-ignore", "--quiet", ".cache/piccolo/checks/probe");
  const candidate = clean(root, input.candidate), branch = git(root, "rev-parse", "--symbolic-full-name", "HEAD"), id = randomUUID(), directory = path.join(home(root, true), id);
  fs.mkdirSync(directory, { mode: 0o700 });
  const started = new Date().toISOString(); let bytes = 0, retained = 0;
  const outputFile = path.join(directory, "output.log");
  writeNew(path.join(directory, "launch.json"), { format: 1, id, candidate, branch, ...input, cwd, environment_overrides: environmentOverrides, started_at: started });
  const fd = fs.openSync(outputFile, "wx", 0o600);
  let status: CheckReceipt["status"] = "unknown", exit: number | null = null, errorText: string | undefined;
  try {
    const result = await createSessionShell(undefined, undefined, root).exec(input.command, cwd, { timeout: timeout / 1000, signal, env: { ...process.env, ...environmentOverrides }, onData: data => {
      const value = Buffer.from(data); bytes += value.length;
      const keep = value.subarray(0, Math.max(0, 8 * 1024 * 1024 - retained)); fs.writeSync(fd, keep); retained += keep.length;
    } });
    exit = result.exitCode; status = exit === 0 ? "pass" : "fail";
  } catch (error: any) {
    errorText = String(error).slice(0, 4000);
    status = signal?.aborted ? "cancelled" : error.message.startsWith("timeout:") ? "timed_out" : "unknown";
  } finally { fs.closeSync(fd); }
  try { clean(root, candidate); if (git(root, "rev-parse", "--symbolic-full-name", "HEAD") !== branch) throw new Error("Branch changed"); } catch { status = "stale"; }
  const receipt: CheckReceipt = checkReceiptSchema.parse({ format: 1, id, check: input.check, candidate, branch, command: input.command, cwd,
    boundary: input.boundary, scope: input.scope, started_at: started, finished_at: new Date().toISOString(), status, exit_code: exit,
    output: "output.log", output_sha256: hash(fs.readFileSync(outputFile)), output_bytes: bytes, retained_bytes: retained,
    provenance: "harness_execution", environment_overrides: environmentOverrides, ...(errorText ? { error: errorText } : {}), ...(input.retry_of ? { retry_of: input.retry_of, retry_reason: input.retry_reason } : {}) });
  writeNew(path.join(directory, "receipt.json"), receipt);
  return { id, check: input.check, status, candidate, record: path.relative(root, path.join(directory, "receipt.json")), output: path.relative(root, outputFile) };
}
export function assessChecks(root: string, candidate: string, required: string[], attempts: string[]) {
  const checks = [...new Set(attempts)].map(id => readCheck(root, id));
  const latest = new Map<string, CheckReceipt>();
  for (const check of checks) {
    const prior = latest.get(check.check);
    if (!prior || check.finished_at >= prior.finished_at) latest.set(check.check, check);
  }
  const missing = required.filter(name => { const last = latest.get(name); return !last || last.candidate !== candidate || last.status !== "pass"; });
  let unchanged = true; try { clean(root, candidate); const branch = git(root, "rev-parse", "--symbolic-full-name", "HEAD"); if ([...latest.values()].some(c => c.branch !== branch)) unchanged = false; } catch { unchanged = false; }
  return { format: 1, candidate, status: !unchanged ? "stale" : missing.length ? "incomplete" : "complete", required, missing,
    checks: checks.map(c => ({ id: c.id, check: c.check, status: c.status, candidate: c.candidate, provenance: c.provenance })) };
}
