import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { packageRoot } from "./config.ts";

const read = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; } };
const hash = (file: string) => { try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return undefined; } };
export function subagentsPublicExport(cwd: string, name: "background-work"): string | undefined {
  const home = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
  for (const root of [path.join(cwd, ".pi"), home]) {
    const candidates = [path.join(root, "npm/node_modules/pi-subagents")];
    for (const value of read(path.join(root, "settings.json"))?.packages ?? []) {
      const source = typeof value === "string" ? value : value?.source;
      if (typeof source === "string" && (path.isAbsolute(source) || source.startsWith("."))) candidates.push(path.resolve(path.dirname(root) === cwd ? cwd : root, source));
    }
    for (const directory of candidates) {
      const manifest = path.join(directory, "package.json");
      const metadata = read(manifest);
      if (metadata?.name !== "pi-subagents") continue;
      // Resolve the declared public export directly: managed Bun does not
      // consistently resolve package self-references through createRequire.
      const declaration = metadata.exports?.[`./${name}`];
      const exported = typeof declaration === "string" ? declaration : declaration?.import ?? declaration?.default;
      if (typeof exported !== "string" || !exported.startsWith("./")) throw new Error(`Unsupported pi-subagents public export: ${name}`);
      const destination = path.resolve(directory, exported);
      if (!destination.startsWith(path.resolve(directory) + path.sep)) throw new Error("Package export escapes its package directory");
      return destination;
    }
  }
  return undefined;
}
export function runtimeSnapshot(cwd: string, piVersion: unknown) {
  const home = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
  const roots = [path.join(cwd, ".pi"), home];
  const candidates = new Set<string>([packageRoot]);
  for (const root of roots) {
    for (const name of ["pi-subagents", "pi-blackhole"]) candidates.add(path.join(root, "npm/node_modules", name));
    for (const value of read(path.join(root, "settings.json"))?.packages ?? []) {
      const source = typeof value === "string" ? value : value?.source;
      if (typeof source === "string" && path.isAbsolute(source)) candidates.add(source);
    }
  }
  const packages = [];
  for (const directory of candidates) {
    const manifest = read(path.join(directory, "package.json"));
    if (!manifest?.name || !manifest.version) continue;
    packages.push({ name: manifest.name, version: manifest.version, manifest_sha256: hash(path.join(directory, "package.json")),
      ...(manifest.name === "pi-subagents" ? { compatibility_source_sha256: hash(path.join(directory, "src/runs/background/binary-bootstrap.js")), supervisor_sources_sha256: Object.fromEntries(Object.keys(read(path.join(packageRoot, "scripts/subagents-supervisor-patch.json")) ?? {}).map(file => [file, hash(path.join(directory, file)) ?? null])) } : {}),
      ...(manifest.name === "pi-blackhole" ? { compatibility_source_sha256: hash(path.join(directory, "index.ts")) } : {}) });
  }
  return { pi: typeof piVersion === "string" ? piVersion : "unavailable from host SDK", node: process.versions.node, bun: process.versions.bun, packages,
    discovery: "Observed manifests in project/user native npm roots and configured absolute local packages; not an exhaustive loaded-extension inventory" };
}
