import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { packageRoot } from "./config.ts";
export const upstreamVersion = "5.14.0";
export const upstreamPatchedHash = "5414c2036a4f7e889fe77971757748cbf83b1540304b0a281f1d96ce65f2f6ed";
export function assertUpstream() {
  const entry = path.join(packageRoot, "node_modules/pi-extensible-workflows/dist/src/index.js");
  const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(entry), "../../package.json"), "utf8"));
  if (manifest.version !== upstreamVersion || createHash("sha256").update(fs.readFileSync(entry)).digest("hex") !== upstreamPatchedHash)
    throw new Error("Workflow runtime is not the qualified patched 5.14.0 package. Close Pi and run scripts/patch-workflows.py after installing dependencies.");
}
