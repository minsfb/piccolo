import { assessmentSchema } from "./assessment.ts";
import { z } from "zod";
import { digest } from "../config.ts";
import { checkSpecSchema } from "../validation-schema.ts";

const text = z.string().min(1).max(100000);
const nodeName = z.string().regex(/^[a-zA-Z0-9_:-]+$/).refine(value => !["__proto__", "prototype", "constructor"].includes(value));
const message = z.json().refine(value => !!value && typeof value === "object" && !Array.isArray(value) &&
  ["system", "user", "assistant", "toolResult"].includes(String(value.role)) &&
  (typeof value.content === "string" || Array.isArray(value.content)) && typeof value.timestamp === "number", "Invalid captured model message");
export const workspaceSchema = z.strictObject({
  host: z.string().min(1).max(255),
  cwd: z.string().startsWith("/").max(4096),
  identity: z.string().uuid(),
});
export const stageSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9_:-]+$/),
  task: text,
  model: z.strictObject({ provider: text, modelId: text }),
  instructions: z.string().max(1000000),
  tools: z.array(z.string().min(1)).max(100),
  skills: z.array(z.string().min(1)).max(100).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  report: z.boolean(),
  timeoutMs: z.number().int().min(1000).max(86400000),
  context: z.array(message).max(10000).optional(),
  requirements: z.strictObject({ host: z.string().optional(), platform: z.enum(["darwin", "linux", "win32"]).optional(), input: z.array(z.enum(["text", "image"])).optional() }).optional(),
});
export type StageSpec = z.infer<typeof stageSchema>;
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
export const workflowSchema = z.strictObject({
  root: z.string().startsWith("/"), worktree: z.string().startsWith("/"), branch: text,
  base: sha, candidate: sha.optional(), task: text, maxRevisions: z.number().int().min(0).max(20),
  stages: z.strictObject({ implement: z.array(stageSchema).length(1), review: z.array(stageSchema).min(1).max(32), qa: z.array(stageSchema).min(1).max(32) }),
  checks: z.record(z.string(), checkSpecSchema), validationMode: z.enum(["required", "reported"]),
});
const nodeSchema = z.strictObject({
  attempt: z.number().int().min(1).optional(),
  needs: z.array(z.string()).max(1000),
  dependencies: z.array(sha).default([]),
  merges: z.record(z.string(), z.string()).default({}),
  work: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("workflow"), workflow: workflowSchema }),
    z.strictObject({ kind: z.literal("delegate"), stage: stageSchema, root: z.string().startsWith("/"), cwd: z.string().startsWith("/"), base: sha, branch: text }),
  ]),
  criterion: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("exact_text"), expected: z.string() }),
    z.strictObject({ kind: z.literal("required_checks") }),
    z.strictObject({ kind: z.literal("rubric"), description: text }),
  ]).optional(),
});
export const pipelineSchema = z.strictObject({
  experiment: z.strictObject({ name: text, manifestDigest: z.string(), taskDigest: z.string(),
    trials: z.record(z.string(), z.strictObject({ task: text, variant: text, repetition: z.number().int().min(1), configDigest: z.string() })) }).optional(),
  nodes: z.record(nodeName, nodeSchema),
  maxActive: z.number().int().min(1).max(8),
  source: z.strictObject({ root: z.string().startsWith("/"), base: sha, files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }),
  failFast: z.boolean(),
  timeoutMs: z.number().int().min(1000).max(86400000).optional(),
}).superRefine((pipeline, ctx) => {
  const done = new Set<string>(), active = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (active.has(id) || !pipeline.nodes[id]) { ctx.addIssue({ code: "custom", message: `Invalid pipeline dependency: ${id}` }); return; }
    active.add(id); for (const need of pipeline.nodes[id].needs) visit(need); active.delete(id); done.add(id);
  };
  if (!Object.keys(pipeline.nodes).length || Object.keys(pipeline.nodes).length > 1000) ctx.addIssue({ code: "custom", message: "Pipeline requires 1..1000 nodes" });
  for (const id of Object.keys(pipeline.nodes)) visit(id);
  const locations = Object.values(pipeline.nodes).map(node => node.work.kind === "workflow" ? node.work.workflow.worktree : node.work.cwd);
  if (new Set(locations).size !== locations.length) ctx.addIssue({ code: "custom", message: "Pipeline nodes need distinct worktrees" });
});
const envelope = {
  version: z.literal(1), registry: z.literal("piccolo-1"),
  requestId: z.string().uuid(), workspace: workspaceSchema,
  lifetime: z.enum(["session", "independent"]), owner: z.string().min(1).max(1024),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  cwd: z.string().startsWith("/").optional(),
  origin: z.strictObject({ taskId: text.optional(), parentRunId: text.optional() }).optional(),
  placement: z.strictObject({ workspace: workspaceSchema, transport: z.array(z.string().min(1)).min(1).max(100) }).optional(),
};
export const submissionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...envelope, kind: z.literal("delegate"), stage: stageSchema }),
  z.strictObject({ ...envelope, kind: z.literal("workflow"), workflow: workflowSchema }),
  z.strictObject({ ...envelope, kind: z.literal("schedule"), pipeline: pipelineSchema }),
  z.strictObject({ ...envelope, kind: z.literal("experiment"), pipeline: pipelineSchema }),
]);
export type WorkerSubmission = z.infer<typeof submissionSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export function fingerprint(input: WorkerSubmission): string { return digest(input); }
export const workerRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ workspace: workspaceSchema.optional(), operation: z.literal("assess"), requestId: z.string().uuid(), assessment: assessmentSchema }),
  z.strictObject({ workspace: workspaceSchema.optional(), operation: z.literal("export_schedule"), requestId: z.string().uuid() }),
  z.strictObject({ workspace: workspaceSchema.optional(), operation: z.literal("submit"), submission: submissionSchema }),
  z.strictObject({ workspace: workspaceSchema.optional(), operation: z.literal("inspect"), requestId: z.string().uuid() }),
  z.strictObject({ workspace: workspaceSchema.optional(), operation: z.literal("message"), requestId: z.string().uuid(), messageId: z.string().uuid(), text: text, target: z.string().optional() }),
  z.strictObject({ workspace: workspaceSchema.optional(), operation: z.literal("watch"), requestId: z.string().uuid(), revision: z.string(), timeoutMs: z.number().int().min(0).max(30000) }),
  z.strictObject({ workspace: workspaceSchema.optional(), operation: z.literal("abort"), requestId: z.string().uuid() }),
  z.strictObject({ workspace: workspaceSchema.optional(), operation: z.literal("info") }),
  z.strictObject({ workspace: workspaceSchema.optional(), operation: z.literal("close"), owner: z.string().min(1), mode: z.enum(["suspend", "cancel-session"]) }),
]);
