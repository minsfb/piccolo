import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { z } from "zod";
import { validationSchema, checkSpecSchema } from "./validation-schema.ts";

const text = z.string().min(1);
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const effortSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const context = z.enum(["fresh", "fork"]);
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/);
export const agentSchema = z.strictObject({
  description: text.optional(), model: text.optional(), effort: effortSchema.optional(),
  prompt: z.string().optional(), skills: z.array(text).optional(), tools: z.array(text).optional(),
  context: context.optional(), timeout_ms: count.optional(), max_depth: count.optional(),
  requirements: z.strictObject({ host: text.optional(), platform: z.enum(["darwin", "linux", "win32"]).optional(), input: z.array(z.enum(["text", "image"])).min(1).optional() }).optional(),
});
const stage = z.strictObject({ agents: z.array(name).min(1).optional(), needs: z.array(name).optional(), task: text.optional() });
const shape = {
  format: z.literal(1).optional(),
  defaults: z.strictObject({ context: context.optional(), timeout_ms: count.optional(), max_depth: count.optional(), tools: z.array(text).optional() }).optional(),
  models: z.record(name, z.strictObject({ model: text.optional(), effort: effortSchema.optional() })).optional(),
  agents: z.record(name, agentSchema).optional(),
  jobs: z.record(name, z.strictObject({ description: text.optional(), stages: z.record(name, stage).optional(), validation: validationSchema.optional() })).optional(),
  compaction: z.strictObject({ owner: z.enum(["pi", "blackhole"]).optional(), server: z.enum(["inherit", "off"]).optional(), memory: z.boolean().optional(), after_ratio: z.number().positive().max(1).optional(), after_tokens: count.optional(), mid_run: z.enum(["off", "resume", "pause"]).optional() }).optional(),
  integration: z.strictObject({ child_extensions: z.array(text).optional(), server_compaction: z.enum(["none", "settings"]).optional(), server_compaction_key: text.optional(), require_worker_policy: z.boolean().optional(), blackhole_extension: text.optional(),
    worker_policy: z.strictObject({ version: z.literal(1), revision: text, extensions: z.array(z.string().startsWith("/")).max(100) }).optional() }).optional(),
  extensions: z.record(name, z.record(z.string(), z.json())).optional(),
  evidence: z.strictObject({ max_return_chars: z.number().int().min(1000).max(100000).optional() }).optional(),
  pool: z.strictObject({ capacity: z.number().int().min(1).max(128).optional(), queue_timeout_ms: count.optional(), max_launches_per_session: count.optional() }).optional(),
  background: z.strictObject({ executor: z.enum(["native", "durable"]).optional(), notifications: z.enum(["follow_up", "notify_only"]).optional(), max_jobs_per_session: count.optional(), shutdown_timeout_ms: z.number().int().min(1000).max(60000).optional() }).optional(),
  hosts: z.record(name, z.strictObject({ hostname: text, cwd: text, transport: z.array(text).min(1).optional(), worker_identity: z.string().uuid().optional(), worker_transport: z.array(text).min(1).optional(), editor: z.enum(["vscode", "cursor"]).optional() })).optional(),
  workflow: z.strictObject({ engine: z.enum(["subagents", "extensible"]).optional() }).optional(),
  operations: z.strictObject({ remove: z.array(text).optional(), reset: z.array(text).optional() }).optional(),
};
export const patchSchema = z.strictObject(shape);
export const configSchema = z.strictObject({ ...shape, profile: text.optional(), profiles: z.record(name, patchSchema).optional() });
export type Agent = z.infer<typeof agentSchema>;
export type Config = z.infer<typeof configSchema>;
export type Layer = { source: string; value: unknown };
export type Resolved = { config: Config; origins: Record<string, string>; operations: Array<{ source: string; action: string; path: string }>; digest: string; profile?: string };
type ObjectValue = Record<string, any>;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const object = (v: unknown): v is ObjectValue => !!v && typeof v === "object" && !Array.isArray(v);
const escape = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");
function safeKeys(value: unknown): void {
  if (!object(value) && !Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error(`Forbidden configuration key: ${key}`);
    safeKeys(child);
  }
}
function validated(value: unknown, source: string): Config {
  safeKeys(value);
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${source}: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}
export function digest(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function merge(target: ObjectValue, patch: ObjectValue, source: string, origins: Record<string, string>, prefix = ""): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "operations" && !prefix) continue;
    const pointer = `${prefix}/${escape(key)}`;
    if (object(value)) {
      if (!object(target[key])) target[key] = {};
      merge(target[key], value, source, origins, pointer);
    } else {
      target[key] = structuredClone(value);
      for (const old of Object.keys(origins)) if (old === pointer || old.startsWith(pointer + "/")) delete origins[old];
      origins[pointer] = source;
    }
  }
}
function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) throw new Error(`Expected JSON Pointer: ${pointer}`);
  const keys = pointer.slice(1).split("/").map(k => k.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (keys.some(k => !k || forbidden.has(k)) || keys[0] === "operations") throw new Error(`Invalid operation path: ${pointer}`);
  return keys;
}
function getAt(root: ObjectValue, keys: string[]): any {
  let current: any = root;
  for (const key of keys) { if (!object(current) || !Object.hasOwn(current, key)) return undefined; current = current[key]; }
  return current;
}
export function resolveLayers(builtin: Layer, layers: Layer[] = [], profile?: string, invocation: unknown = {}, bootstrap = false): Resolved {
  const base = validated(builtin.value, builtin.source);
  const effective: ObjectValue = {};
  const origins: Record<string, string> = {};
  const operations: Resolved["operations"] = [];
  const apply = (layer: Layer) => {
    const parsed = validated(layer.value, layer.source);
    for (const action of ["reset", "remove"] as const) for (const pointer of parsed.operations?.[action] ?? []) {
      const keys = pointerParts(pointer);
      const existing = getAt(effective, keys);
      const replacement = getAt(base, keys);
      if (action === "remove" && existing === undefined) { if (bootstrap) continue; throw new Error(`${layer.source}: cannot remove absent ${pointer}`); }
      let parent = effective;
      for (const key of keys.slice(0, -1)) { if (!object(parent[key])) parent[key] = {}; parent = parent[key]; }
      delete parent[keys.at(-1)!];
      for (const old of Object.keys(origins)) if (old === pointer || old.startsWith(pointer + "/")) delete origins[old];
      if (action === "reset" && replacement !== undefined) merge(parent, { [keys.at(-1)!]: replacement }, `${layer.source} (reset to builtin)`, origins, keys.length > 1 ? "/" + keys.slice(0, -1).map(escape).join("/") : "");
      operations.push({ source: layer.source, action, path: pointer });
    }
    merge(effective, parsed, layer.source, origins);
  };
  apply(builtin);
  for (const layer of layers) apply(layer);
  const selectedProfile = profile ?? effective.profile;
  if (selectedProfile) {
    if (!effective.profiles?.[selectedProfile]) { if (!bootstrap) throw new Error(`Unknown profile: ${selectedProfile}`); }
    else apply({ source: `profile:${selectedProfile}`, value: effective.profiles[selectedProfile] });
  }
  apply({ source: "invocation", value: invocation });
  const config = validated(effective, "effective configuration");
  if (!bootstrap) validateReferences(config);
  return { config, origins, operations, digest: digest(config), ...(selectedProfile ? { profile: selectedProfile } : {}) };
}
export function resolveModel(config: Config, reference?: string, seen = new Set<string>()): { model?: string; effort?: z.infer<typeof effortSchema> } {
  if (!reference) return {};
  if (!reference.startsWith("alias:")) {
    if (!/^[^/\s]+\/\S+$/.test(reference)) throw new Error(`Model must be provider/id or alias:name: ${reference}`);
    return { model: reference };
  }
  const id = reference.slice(6);
  if (seen.has(id)) throw new Error(`Model alias cycle at ${id}`);
  const alias = config.models?.[id];
  if (!alias?.model) throw new Error(`Missing model alias: ${id}`);
  return { ...resolveModel(config, alias.model, new Set([...seen, id])), ...(alias.effort ? { effort: alias.effort } : {}) };
}
function validateReferences(config: Config): void {
  if (config.workflow?.engine === "extensible" && config.compaction?.owner === "blackhole") throw new Error("The upstream workflow experiment currently qualifies native Pi compaction only; select the baseline profile or subagents engine.");
  if (config.compaction?.owner === "blackhole" && config.compaction.server !== "off") throw new Error("Blackhole must disable the configured server-compaction path");
  if (config.compaction?.owner === "blackhole" && !config.integration?.server_compaction) throw new Error("Declare integration.server_compaction: settings, or none for a deployment without server compaction");
  if (config.integration?.server_compaction === "settings" && (!config.integration.server_compaction_key || forbidden.has(config.integration.server_compaction_key))) throw new Error("A settings adapter requires a safe server_compaction_key");
  for (const id of Object.keys(config.models ?? {})) resolveModel(config, `alias:${id}`);
  for (const agent of Object.values(config.agents ?? {})) resolveModel(config, agent.model);
  for (const [jobName, job] of Object.entries(config.jobs ?? {})) {
    for (const check of Object.values(job.validation?.checks ?? {})) checkSpecSchema.parse(check);
    for (const [stageName, stage] of Object.entries(job.stages ?? {})) {
      if (!stage.agents?.length) throw new Error(`${jobName}.${stageName}: requires agents`);
      for (const id of stage.agents) if (!config.agents?.[id]) throw new Error(`${jobName}.${stageName}: unknown agent ${id}`);
      for (const id of stage.needs ?? []) if (!job.stages?.[id]) throw new Error(`${jobName}.${stageName}: unknown predecessor ${id}`);
    }
  }
}
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function readLayer(file: string): Layer | undefined {
  try { return { source: file, value: parse(fs.readFileSync(file, "utf8")) }; }
  catch (error: any) { if (error.code === "ENOENT") return undefined; throw new Error(`${file}: ${error.message}`); }
}
export function loadConfig(project: string, options: { profile?: string; invocation?: unknown; userFile?: string; contributions?: Layer[] } = {}): Resolved {
  return captureConfig(project, options)(options);
}
/** Freeze the layered inputs, retaining origins and per-invocation merge rules. */
export function captureConfig(project: string, options: { userFile?: string; contributions?: Layer[] } = {}) {
  const xdg = process.env.XDG_CONFIG_HOME;
  const userFile = options.userFile ?? path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config"), "piccolo/config.toml");
  const layers = [...(options.contributions ?? []), ...[userFile, path.join(project, ".piccolo/config.toml")].map(readLayer).filter((l): l is Layer => !!l)];
  const builtin = structuredClone(readLayer(path.join(packageRoot, "config/defaults.toml"))!);
  const captured = structuredClone(layers);
  return (invocation: { profile?: string; invocation?: unknown } = {}) => resolveLayers(builtin, captured, invocation.profile, invocation.invocation);
}
export function resolveAgent(resolved: Resolved, id: string, override: unknown = {}): Agent {
  const agent = resolved.config.agents?.[id];
  if (!agent) throw new Error(`Unknown agent type: ${id}`);
  const patch = agentSchema.parse(override);
  const combined = { ...resolved.config.defaults, ...agent, ...patch, requirements: { ...agent.requirements, ...patch.requirements } };
  const model = resolveModel(resolved.config, combined.model);
  return { ...combined, ...model, ...(combined.effort ? { effort: combined.effort } : {}) };
}

/** Extension factories load before contributed aliases/profiles exist. Only the
 * file-selected engine is needed to register that engine's native lifecycle. */
export function bootstrapWorkflowEngine(project: string): "subagents" | "extensible" {
  const xdg = process.env.XDG_CONFIG_HOME;
  const user = path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config"), "piccolo/config.toml");
  const builtin = readLayer(path.join(packageRoot, "config/defaults.toml"))!;
  const layers = [user, path.join(project, ".piccolo/config.toml")].map(readLayer).filter((layer): layer is Layer => !!layer);
  return resolveLayers(builtin, layers, undefined, {}, true).config.workflow?.engine ?? "subagents";
}
