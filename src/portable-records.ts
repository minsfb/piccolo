import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { writeNew } from "./records.ts";

const uuid = z.string().uuid(), sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const disposition = z.enum(["complete", "changes_requested", "blocked", "challenge", "partial", "needs_parent", "interrupted"]);
function directory(root: string, parts: string[], create = false) {
  let current = fs.realpathSync(root);
  for (const part of parts) {
    current = path.join(current, part);
    if (create) { try { fs.mkdirSync(current); } catch (error: any) { if (error.code !== "EEXIST") throw error; } }
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Execution record directories must not be linked");
  }
  return current;
}
function read(file: string) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error("Unsupported execution record file");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("Invalid execution-record JSON"); }
}
/** Export only categorical fields. Never copy task text, shell output, model
 * identities, machine paths, branch names, resolved configuration or free text.
 */
export function exportWorkflow(root: string, id: string) {
  uuid.parse(id); root = fs.realpathSync(root);
  const record = directory(root, [".piccolo", "workflows", id]);
  const launch = read(path.join(record, "launch.json")), outcome = read(path.join(record, "outcome.json"));
  if (launch.id !== id || outcome.id !== id) throw new Error("Workflow identity mismatch");
  const files = fs.readdirSync(record).filter(file => /^[0-9]{4}\.json$/.test(file)).sort();
  if (files.length > 1000) throw new Error("Workflow summary exceeds stage limit");
  const stages = files.map(file => {
    const value = read(path.join(record, file));
    const stage = z.enum(["preflight", "implement", "review", "qa", "revision_requested", "validation"]).parse(value.stage);
    return { stage, record: `.piccolo/workflows/${id}/${file}`,
      ...(value.round !== undefined ? { round: z.number().int().nonnegative().max(20).parse(value.round) } : {}),
      ...(value.report ? { reported_status: disposition.parse(value.report.status), candidate: sha.parse(value.report.commit ?? value.candidate), evidence_items: z.array(z.unknown()).max(30).parse(value.report.evidence ?? []).length } : {}),
      ...(stage === "validation" ? { check_status: z.enum(["pass", "fail", "timed_out", "cancelled", "unknown", "stale"]).parse(value.receipt?.status), required: z.boolean().parse(value.required), attempt: uuid.parse(value.receipt?.id) } : {}) };
  });
  const validation = outcome.validation;
  const summary = { format: 1, kind: "workflow_summary", id, candidate: sha.parse(outcome.candidate), base: sha.parse(outcome.base),
    disposition: disposition.parse(outcome.status), stages,
    validation: validation ? { status: z.enum(["not_configured", "complete", "incomplete", "stale"]).parse(validation.status),
      required_count: z.array(z.string()).max(1000).parse(validation.required ?? []).length,
      missing_count: z.array(z.string()).max(1000).parse(validation.missing ?? []).length } : { status: "legacy_worker_reports" },
    ...(launch.resolved?.digest ? { config_digest: z.string().regex(/^[a-f0-9]{64}$/).parse(launch.resolved.digest) } : {}),
    local_evidence: `.piccolo/workflows/${id}`, publication_approved: false,
    scope: "Portable execution index. Stage verdicts are worker reports; command receipts remain local. Review original evidence, coverage and accepted exceptions before publication." };
  const destination = path.join(directory(root, [".piccolo", "ledger"], true), `${id}.json`);
  writeNew(destination, summary);
  return { file: path.relative(root, destination), summary };
}
/** Audit the index, not the working tree. Findings never include matched values.
 * This is a focused execution-record check, not a general secrets/DLP scanner.
 */
export function auditStagedRecords(root: string, policyFile?: string) {
  const policy = (() => { try { return policyFile ? z.strictObject({ format: z.literal(1), restricted_literals: z.array(z.string().min(1).max(1000)).max(100) }).parse(read(policyFile)) : { restricted_literals: [] }; } catch { throw new Error("Invalid records audit policy"); } })();
  const git = (...args: string[]) => {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024, timeout: 30000 }); }
    catch { throw new Error("Cannot inspect staged execution records; resolve index conflicts or Git read failures, then retry the audit"); }
  };
  const files = git("diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB", "-z").split("\0").filter(file => file.startsWith(".piccolo/"));
  const findings: Array<{ file: string; code: string }> = [];
  for (const file of files) {
    const safeFile = policy.restricted_literals.some(value => file.includes(value)) || /(?:authorization|password|token|api[_-]?key)[:=]|\/(?:Users|home)\//i.test(file)
      ? `[redacted path sha256:${createHash("sha256").update(file).digest("hex")}]` : file;
    if (/^\.piccolo\/(jobs|runs|workflows)\//.test(file)) { findings.push({ file: safeFile, code: "raw_execution_record_requires_review" }); continue; }
    const content = git("show", `:${file}`);
    if (/\/(?:Users|home)\/[^\s/]+\//.test(content)) findings.push({ file: safeFile, code: "machine_absolute_path" });
    if (/(?:api[_-]?key|access[_-]?token|authorization|password)\s*["']?\s*[:=]\s*["']?[^\s"']+/i.test(content)) findings.push({ file: safeFile, code: "credential_like_field" });
    if (policy.restricted_literals.some(value => content.includes(value) || file.includes(value))) findings.push({ file: safeFile, code: "project_policy_literal" });
    if (/https?:\/\/[^\s/@]+:[^\s/@]+@/.test(content)) findings.push({ file: safeFile, code: "credential_url" });
  }
  return { status: findings.length ? "needs_review" : "pass", files_checked: files.length, findings,
    publication_approved: false, scope: "Staged .piccolo files only. No credentials or matched values are printed. A pass is not an external-sharing audit or authorization." };
}
