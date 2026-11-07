import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { projectSessionsDirectory } from "pi-extensible-workflows/persistence";
import { digest } from "./config.ts";
import { git, requireCandidate, reportSchema } from "./workflow.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const states = z.enum(["queued", "running", "pausing", "paused", "awaiting_input", "completed", "failed", "stopped", "interrupted", "budget_exhausted"]);
const attention = new Set(["paused", "awaiting_input", "completed", "failed", "stopped", "interrupted", "budget_exhausted"]);
export const workflowHome = (root: string) => path.join(root, ".cache/piccolo/workflow-host");

function checked(root: string, relative: string, create = false): string {
  let current = fs.realpathSync(root);
  for (const part of relative.split(path.sep)) {
    if (!part || part === "." || part === "..") throw new Error("Invalid workflow storage path");
    current = path.join(current, part);
    if (create) { try { fs.mkdirSync(current); } catch (e: any) { if (e.code !== "EEXIST") throw e; } }
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Workflow storage must not be symlinked"); }
    catch (e: any) { if (e.code !== "ENOENT") throw e; }
  }
  return current;
}
function read(file: string): { value: any; sha256: string } {
  if (!fs.lstatSync(file).isFile()) throw new Error("Workflow record must be a regular file");
  // Nonblocking open also covers replacement by a FIFO after the lstat.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error("Workflow record must be a regular file of at most 8 MiB");
    const data = fs.readFileSync(fd);
    if (data.length > 8 * 1024 * 1024) throw new Error("Workflow record grew past its limit");
    return { value: JSON.parse(data.toString("utf8")), sha256: createHash("sha256").update(data).digest("hex") };
  } finally { fs.closeSync(fd); }
}
function entries(directory: string): string[] {
  try {
    const values = fs.readdirSync(directory, { withFileTypes: true });
    if (values.length > 4096) throw new Error("Workflow reconciliation limit exceeded; archive/reconcile explicitly");
    return values.filter(v => uuid.test(v.name)).map(v => v.name).sort();
  } catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
}
function immutable(file: string, value: unknown) {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    try { fs.linkSync(temporary, file); }
    catch (e: any) { if (e.code !== "EEXIST") throw e; if (digest(read(file).value) !== digest(value)) throw new Error("Conflicting immutable workflow receipt"); }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export type WorkflowObservation = {
  format: 1; id: string; session: string; run: string; state: z.infer<typeof states>;
  source_sha256: string; source: string; models: string[]; agent_states: Record<string, number>;
};
export function reconcileWorkflows(root: string) {
  root = fs.realpathSync(root);
  const sessions = projectSessionsDirectory(root, workflowHome(root));
  checked(root, path.relative(root, sessions));
  const observations: Array<WorkflowObservation & { acknowledged: boolean; needs_attention: boolean }> = [];
  const missing_state: Array<{ session: string; run: string }> = [];
  let count = 0;
  for (const session of entries(sessions)) {
    const runs = checked(root, path.relative(root, path.join(sessions, session, "runs")));
    for (const run of entries(runs)) {
      if (++count > 4096) throw new Error("Workflow reconciliation limit exceeded");
      const source = path.relative(root, path.join(runs, run, "state.json"));
      let record: ReturnType<typeof read>;
      try { record = read(checked(root, source)); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; missing_state.push({ session, run }); continue; }
      const value = record.value;
      if (value.id !== run || value.sessionId !== session || path.resolve(value.cwd) !== root) throw new Error("Workflow source identity mismatch");
      const state = states.parse(value.state);
      if (!Array.isArray(value.agents) || value.agents.length > 1024) throw new Error("Invalid workflow agent inventory");
      const models = new Set<string>(); const agent_states: Record<string, number> = Object.create(null);
      for (const agent of value.agents) {
        if (typeof agent.state !== "string" || !new Set(["queued", "running", "waiting_for_child", "paused", "retrying", "completed", "failed", "cancelled"]).has(agent.state)) throw new Error("Invalid workflow agent state");
        agent_states[agent.state] = (agent_states[agent.state] ?? 0) + 1;
        if (agent.model) {
          if (typeof agent.model.provider !== "string" || typeof agent.model.model !== "string") throw new Error("Invalid workflow model identity");
          const model = `${agent.model.provider}/${agent.model.model}`;
          if (model.length > 512 || !/^[^/\s]+\/\S+$/.test(model)) throw new Error("Invalid workflow model identity");
          models.add(model);
          if (models.size > 64) throw new Error("Workflow model inventory limit exceeded");
        }
      }
      const snapshot = { format: 1 as const, session, run, state, source_sha256: record.sha256, source, models: [...models].sort(), agent_states };
      const observation: WorkflowObservation = { ...snapshot, id: digest(snapshot) };
      const directory = checked(root, ".piccolo/workflow-inbox", true);
      immutable(path.join(directory, `${observation.id}.json`), observation);
      const acknowledgment = path.join(directory, `${observation.id}.ack.json`);
      let acknowledged = false;
      if (fs.existsSync(acknowledgment)) {
        const ack = read(acknowledgment).value;
        if (ack.format !== 1 || ack.receipt !== observation.id || typeof ack.note !== "string" || ack.note.length > 2000) throw new Error("Invalid workflow acknowledgment");
        acknowledged = true;
      }
      observations.push({ ...observation, acknowledged, needs_attention: attention.has(state) && !acknowledged });
    }
  }
  const inboxDirectory = checked(root, ".piccolo/workflow-inbox");
  const missing_sources: string[] = [];
  if (fs.existsSync(inboxDirectory)) {
    const files = fs.readdirSync(inboxDirectory);
    if (files.length > 16384) throw new Error("Workflow receipt inventory limit exceeded; archive explicitly");
    for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
      const receipt = read(path.join(inboxDirectory, file)).value;
      const { id, ...snapshot } = receipt;
      if (id !== file.slice(0, -5) || digest(snapshot) !== id || !uuid.test(receipt.session) || !uuid.test(receipt.run)) throw new Error("Invalid retained workflow receipt");
      const expectedSource = path.relative(root, path.join(sessions, receipt.session, "runs", receipt.run, "state.json"));
      if (receipt.source !== expectedSource) throw new Error("Invalid retained workflow source path");
      if (!fs.existsSync(checked(root, receipt.source))) missing_sources.push(id);
    }
  }
  return { format: 1, observations, missing_sources, missing_state, pending: observations.filter(v => v.needs_attention).map(v => v.id),
    unresolved: observations.filter(v => !attention.has(v.state)).map(v => v.id),
    note: "Persisted state is an observation, not proof a worker is alive or that code is correct. No work is replayed." };
}
export function acknowledgeWorkflow(root: string, receipt: string, note: string) {
  if (!hash.test(receipt) || !note.trim() || note.length > 2000) throw new Error("Require an exact receipt and a nonempty note of at most 2000 characters");
  const current = reconcileWorkflows(root);
  const observation = current.observations.find(v => v.id === receipt);
  if (!observation) throw new Error("Receipt is stale or absent; inspect current workflow state before acknowledgment");
  const directory = checked(root, ".piccolo/workflow-inbox", true);
  immutable(path.join(directory, `${receipt}.ack.json`), { format: 1, receipt, note });
  return { receipt, acknowledged: true, run: observation.run, state: observation.state };
}

export function verifyWorkflowCandidate(root: string, receipt: string) {
  root = fs.realpathSync(root);
  if (!hash.test(receipt)) throw new Error("Require an exact workflow receipt");
  const observation = reconcileWorkflows(root).observations.find(v => v.id === receipt);
  if (!observation || observation.state !== "completed") throw new Error("Require a current completed workflow receipt");
  if (Object.keys(observation.agent_states).some(state => state !== "completed") || observation.agent_states.completed !== 4) throw new Error("Expected four completed native agents for the qualified recipe");
  const runDirectory = path.dirname(observation.source);
  const result = read(checked(root, path.join(runDirectory, "result.json")));
  const value = result.value;
  if (value.status !== "review_ready" || typeof value.workspace?.path !== "string" || typeof value.workspace?.branch !== "string" || !value.workspace.branch.trim()) throw new Error("Workflow did not produce the qualified implementation recipe result");
  const worktree = path.resolve(value.workspace.path);
  const owned = path.join(root, runDirectory, "worktrees") + path.sep;
  if (!worktree.startsWith(owned)) throw new Error("Candidate is not this run's owned worktree; reconcile borrowed work explicitly");
  checked(root, path.relative(root, worktree));
  const implementation = reportSchema.parse(value.implementation);
  const candidate = implementation.commit;
  if (implementation.status !== "complete" || !candidate) throw new Error("Implementation has no complete candidate");
  if (!value.reviews || typeof value.reviews !== "object" || Array.isArray(value.reviews) || Object.keys(value.reviews).length !== 2) throw new Error("Expected the qualified two-reviewer recipe");
  for (const item of [value.implementation, ...Object.values(value.reviews), value.qa]) {
    const report = reportSchema.parse(item);
    if (report.status !== "complete" || report.commit !== candidate || !report.evidence.length) throw new Error("Every stage must identify the same candidate and supporting evidence");
  }
  const common = (cwd: string) => fs.realpathSync(path.resolve(cwd, git(cwd, "rev-parse", "--git-common-dir")));
  if (common(root) !== common(worktree)) throw new Error("Candidate belongs to another repository");
  requireCandidate(worktree, candidate, value.workspace.branch);
  const proof = { format: 1, receipt, run: observation.run, source_sha256: observation.source_sha256, result_sha256: result.sha256,
    candidate, branch: value.workspace.branch, worktree, scope: "Git identity/cleanliness and structured stage reports. Does not independently rerun QA or prove task correctness." };
  const directory = checked(root, ".piccolo/workflow-inbox", true);
  immutable(path.join(directory, `${digest(proof)}.candidate.json`), proof);
  return proof;
}

export function workflowNotice(root: string): string | undefined {
  try {
    const inbox = reconcileWorkflows(root);
    if (inbox.pending.length || inbox.unresolved.length || inbox.missing_sources.length || inbox.missing_state.length)
      return `Workflow records need coordination: ${inbox.pending.length} unacknowledged outcomes, ${inbox.unresolved.length} unresolved active states, ${inbox.missing_sources.length} receipts whose upstream source is missing, ${inbox.missing_state.length} run directories without state. Use piccolo_workflow_inbox to inspect before deciding on follow-up. Do not infer live workers or replay incomplete work.`;
  } catch (error) {
    return `Workflow reconciliation needs attention: ${String(error).slice(0, 1000)}. The coordinator remains available to inspect and repair records; no execution or acknowledgment was inferred.`;
  }
}
