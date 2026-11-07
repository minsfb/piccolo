import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { digest, packageRoot, type Resolved } from "./config.ts";
import { projectRoot } from "./records.ts";

function read(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e: any) { if (e.code === "ENOENT") return undefined; throw e; }
}
function atomic(file: string, data: unknown) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing symlink: ${file}`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function blackholeExtension(cwd: string, resolved: Resolved): string | undefined {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
  const candidates = resolved.config.integration?.blackhole_extension ? [resolved.config.integration.blackhole_extension] : [path.join(cwd, ".pi/npm/node_modules/pi-blackhole/index.ts"), path.join(agentDir, "npm/node_modules/pi-blackhole/index.ts")];
  for (const file of candidates) if (path.isAbsolute(file) && fs.existsSync(file)) {
    const manifest = read(path.join(path.dirname(file), "package.json"));
    if (manifest?.name !== "pi-blackhole" || manifest.version !== "0.5.15") throw new Error("Compaction adapter requires pi-blackhole 0.5.15");
    return fs.realpathSync(file);
  }
  return undefined;
}
export function policy(resolved: Resolved) {
  return { compaction: resolved.config.compaction, adapter: resolved.config.integration?.server_compaction ?? "none", adapter_key: resolved.config.integration?.server_compaction_key, blackhole: resolved.config.extensions?.blackhole ?? {} };
}
export function profileChildExtensions(cwd: string, resolved: Resolved): string[] {
  const extensions = [...(resolved.config.integration?.child_extensions ?? [])];
  if (resolved.config.compaction?.owner === "blackhole") {
    const blackhole = blackholeExtension(cwd, resolved);
    if (!blackhole) throw new Error("Install pi-blackhole@0.5.15 with native Pi package management first");
    extensions.push(path.join(packageRoot, "extensions/piccolo.ts"), blackhole);
  }
  return [...new Set(extensions)];
}
export function applyProfile(cwd: string, resolved: Resolved): unknown {
  const runs = path.join(projectRoot(cwd), ".piccolo/runs");
  if (fs.existsSync(runs)) for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(runs, entry.name, "launch.json")) && !fs.existsSync(path.join(runs, entry.name, "outcome.json"))) throw new Error(`Run ${entry.name} has no terminal outcome. Reconcile it before changing compaction configuration.`);
  }
  const directory = path.join(cwd, ".pi");
  fs.mkdirSync(directory, { recursive: true });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Refusing symlinked .pi directory");
  const settingsFile = path.join(directory, "settings.json");
  const stateFile = path.join(directory, "piccolo-profile.json");
  const settings = read(settingsFile) ?? {};
  const prior = read(stateFile);
  const selected = policy(resolved);
  const key = selected.adapter_key;
  if (prior?.policy?.adapter === "settings" && prior.policy.compaction?.server === "off" && prior.policy.adapter_key !== key) throw new Error("Restore the baseline profile before changing the server compaction setting key");
  const saved = prior?.saved ?? { server_enabled: null, delegate: settings.subagents?.agentOverrides?.delegate?.subagentOnlyExtensions ?? [] };
  if (key && prior?.policy?.adapter_key !== key) saved.server_enabled = settings[key]?.enabled ?? null;
  const blackhole = resolved.config.compaction?.owner === "blackhole";
  const extension = blackholeExtension(cwd, resolved);
  if (blackhole && !extension) throw new Error("Install pi-blackhole@0.5.15 before configuring its profile");
  const options = selected.blackhole;
  const managedKeys = ["compaction", "compactionEngine", "memory", "compactAfterRatio", "compactAfterTokens", "midRunCompaction", "skipForProviders"];
  if (managedKeys.some(k => Object.hasOwn(options, k))) throw new Error("Use compaction fields instead of overriding owned Blackhole options in extensions.blackhole");
  const nativeBlackhole = {
    ...options, compaction: blackhole ? "auto" : "off", compactionEngine: blackhole ? "blackhole" : "pi-default",
    memory: blackhole && !!resolved.config.compaction?.memory,
    compactAfterRatio: resolved.config.compaction?.after_ratio ?? 0.6,
    compactAfterTokens: resolved.config.compaction?.after_tokens ?? 0,
    midRunCompaction: blackhole ? resolved.config.compaction?.mid_run ?? "resume" : "off",
    skipForProviders: [], debug: false, debugLog: false,
  };
  if (selected.adapter === "settings" && key) {
    if (resolved.config.compaction?.server === "off") settings[key] = { ...(settings[key] ?? {}), enabled: false };
    else if (saved.server_enabled === null) {
      if (settings[key]) {
        delete settings[key].enabled;
        if (!Object.keys(settings[key]).length) delete settings[key];
      }
    } else settings[key] = { ...(settings[key] ?? {}), enabled: saved.server_enabled };
  }
  const required = profileChildExtensions(cwd, resolved);
  const existing = settings.subagents?.agentOverrides?.delegate?.subagentOnlyExtensions ?? [];
  const retained = existing.filter((file: string) => !(prior?.child_extensions ?? []).includes(file) || saved.delegate.includes(file) || required.includes(file));
  if (required.length || retained.length || settings.subagents?.agentOverrides?.delegate) {
    settings.subagents ??= {}; settings.subagents.agentOverrides ??= {}; settings.subagents.agentOverrides.delegate ??= {};
    settings.subagents.agentOverrides.delegate.subagentOnlyExtensions = [...new Set([...retained, ...required])];
  }
  // State is committed last; a partial write is detected by assertProfile, never treated as activated.
  atomic(settingsFile, settings);
  if (extension) atomic(path.join(directory, "pi-blackhole-config.json"), nativeBlackhole);
  const state = { format: 1, profile: resolved.profile ?? "baseline", policy: selected, policy_digest: digest(selected), saved, blackhole_config: extension ? nativeBlackhole : null, child_extensions: required, created_at: new Date().toISOString() };
  atomic(stateFile, state);
  return state;
}
export function assertProfile(cwd: string, resolved: Resolved): void {
  const blackhole = resolved.config.compaction?.owner === "blackhole";
  const state = read(path.join(cwd, ".pi/piccolo-profile.json"));
  if (!state && !blackhole && !blackholeExtension(cwd, resolved)) return;
  if (!state || state.policy_digest !== digest(policy(resolved))) throw new Error("Compaction profile is not materialized for this cwd. Stop its Pi sessions, run piccolo configure, then restart.");
  if (state.blackhole_config && digest(read(path.join(cwd, ".pi/pi-blackhole-config.json")) ?? null) !== digest(state.blackhole_config)) throw new Error("Blackhole configuration drifted; reconfigure and restart this workspace.");
  if (resolved.config.integration?.server_compaction === "settings" && resolved.config.compaction?.server === "off" && read(path.join(cwd, ".pi/settings.json"))?.[resolved.config.integration.server_compaction_key!]?.enabled !== false) throw new Error("Configured server compaction must be disabled for this profile.");
  if (blackhole) {
    for (const key of Object.keys(process.env)) if (/^(PI_BLACKHOLE_|PI_VCC_|PI_OBSERVATIONAL_MEMORY_)/.test(key)) throw new Error(`Ambient ${key} may override the recorded Blackhole profile; remove it before launching.`);
  }
}
