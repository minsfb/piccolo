import fs from "node:fs";
import { z } from "zod";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NativePolicy } from "./native-policy.ts";

export const policyConfigSchema = z.strictObject({
  version: z.literal(1),
  // Deployment revision covers imported dependencies and external policy binaries.
  revision: z.string().min(1).max(200),
  extensions: z.array(z.string().startsWith("/")).min(1).max(100),
});

export function configuredPolicy(value: unknown, directory: string, ctx: ExtensionContext, settings?: Record<string, unknown>) {
  const config = policyConfigSchema.parse(value);
  return new NativePolicy({ paths: config.extensions, revision: config.revision, directory,
    registry: ctx.modelRegistry, settings, isProjectTrusted: () => ctx.isProjectTrusted(),
  });
}

/** Deployment-owned configuration; no managed paths or credentials in Piccolo. */
export function localPolicy(directory: string, ctx: ExtensionContext, settings?: Record<string, unknown>, deployment?: { version: 1; revision: string; extensions: string[] }, managed = false) {
  managed ||= process.env.PICCOLO_REQUIRE_WORKER_POLICY === "1";
  const file = process.env.PICCOLO_WORKER_POLICY;
  if (file) return configuredPolicy(JSON.parse(fs.readFileSync(file, "utf8")), directory, ctx, settings);
  if (managed && !deployment?.extensions.length) throw new Error("Policy-required Durable workers need an explicit deployment contribution or PICCOLO_WORKER_POLICY. Configure the policy and restart Pi, or explicitly select [background] executor = \"native\".");
  if (deployment && !deployment.extensions.length) return undefined;
  if (deployment) return configuredPolicy(deployment, directory, ctx, settings);
  throw new Error("Configure integration.worker_policy or PICCOLO_WORKER_POLICY for Durable workers; [background] executor = \"native\" preserves native execution.");
}
