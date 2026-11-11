import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

const milliseconds = z.number().int().min(1000).max(86400000);
export const healthConfig = z.strictObject({
  enabled: z.boolean().default(true),
  interval_ms: milliseconds.default(5000),
  attention_ms: milliseconds.default(60000),
  compaction_ms: milliseconds.default(300000),
  tool_ms: milliseconds.default(900000),
  retry_ms: milliseconds.default(30000),
  max_attempts: z.number().int().min(1).max(20).default(3),
  max_wakes: z.number().int().min(1).max(10000).default(128),
  recovery: z.enum(["wake", "observe"]).default("wake"),
  compatibility: z.enum(["off", "native-v1", "managed", "managed-0.85.1", "managed-0.86.1", "managed-1.3.0", "managed-1.4.0"]).default("off"),
  diagnostic: z.strictObject({
    enabled: z.boolean().default(false),
    model: z.string().regex(/^[^/\s]+\/\S+$/).optional(),
    interval_ms: milliseconds.default(1800000),
    timeout_ms: milliseconds.default(60000),
    max_calls: z.number().int().min(1).max(100).default(12),
    max_tokens: z.number().int().min(128).max(4096).default(1024),
    prompt: z.string().max(4000).default(""),
  }).default({ enabled: false, interval_ms: 1800000, timeout_ms: 60000, max_calls: 12, max_tokens: 1024, prompt: "" }),
});
export type HealthConfig = z.infer<typeof healthConfig>;
function merge(a: any, b: any): any {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("Health configuration must be a table");
  const result = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid health configuration key");
    result[key] = value && typeof value === "object" && !Array.isArray(value) ? merge(result[key] ?? {}, value) : value;
  }
  return result;
}
export function resolveHealthConfig(layers: unknown[]) {
  let value: any = {};
  for (const layer of layers) value = merge(value, layer);
  const result = healthConfig.safeParse(value);
  if (!result.success) throw new Error(`Invalid health configuration fields: ${result.error.issues.map(i => i.path.join(".")).join(", ")}`);
  if (result.data.diagnostic.enabled && !result.data.diagnostic.model) throw new Error("Choose an explicit diagnostic.model before enabling health inference");
  return result.data;
}
export function loadHealthConfig(cwd: string, trusted: boolean, integration: unknown = {}) {
  const xdg = process.env.XDG_CONFIG_HOME;
  const home = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  const files = [path.join(home, "pi-harness-health/config.toml"), ...(trusted ? [path.join(cwd, ".pi/health.toml")] : [])];
  const layers: unknown[] = [];
  for (const file of files) {
    try {
      if (fs.statSync(file).size > 65536) throw new Error("Oversized health configuration");
      layers.push(parse(fs.readFileSync(file, "utf8")));
    } catch (error: any) { if (error.code !== "ENOENT") throw new Error("Cannot load health configuration; inspect configured TOML locally"); }
  }
  return resolveHealthConfig([...layers, integration]);
}

/** Selection grants no capability: installation still requires an exact captured profile. */
export function selectsManagedWake(compatibility: HealthConfig["compatibility"], version: string): boolean {
  return compatibility === "managed" || compatibility === `managed-${version}`;
}
