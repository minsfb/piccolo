import type { Resolved } from "./config.ts";
import { resolveAgent } from "./config.ts";

export function inspectConfig(resolved: Resolved, pointer?: string, type?: string) {
  const scope = "File configuration only; live package contributions require piccolo_inspect inside Pi. Model availability is checked at launch.";
  if (type) return { digest: resolved.digest, profile: resolved.profile, type, agent: resolveAgent(resolved, type), origins: resolved.origins, operations: resolved.operations, scope };
  if (pointer === undefined) return { ...resolved, scope };
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) throw new Error("Use an RFC 6901 JSON Pointer, e.g. /agents/reviewer/effort");
  let value: any = resolved.config;
  for (const key of pointer.slice(1).split("/").map(p => p.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error(`No configured value at ${pointer}`);
    value = value[key];
  }
  return { digest: resolved.digest, profile: resolved.profile, pointer, value,
    origins: Object.fromEntries(Object.entries(resolved.origins).filter(([p]) => p === pointer || p.startsWith(pointer + "/") || pointer.startsWith(p + "/"))),
    operations: resolved.operations.filter(o => o.path === pointer || o.path.startsWith(pointer + "/") || pointer.startsWith(o.path + "/")), scope };
}
