import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { parse } from "smol-toml";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { packageRoot, configSchema } from "./config.ts";
import { initializeRecords, projectRoot } from "./records.ts";
import { planWorktreeArea, prepareWorktreeArea } from "./worktree-placement.ts";

export const agentDirectory = () => path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent"));
const version = () => JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
export function safePath(root: string, relative: string): string {
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (!part || part === "." || part === "..") throw new Error("Invalid onboarding path");
    current = path.join(current, part);
    try { const stat = fs.lstatSync(current); if ((!stat.isDirectory() && !stat.isFile()) || (!stat.isDirectory() && current !== path.join(root, relative))) throw new Error(`Refusing unsafe onboarding path: ${current}`); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  return current;
}
export function readSettings(file: string): any {
  if (!fs.existsSync(file)) return {};
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data) || (data.packages !== undefined && !Array.isArray(data.packages))) throw new Error(`Invalid Pi settings: ${file}`);
  return data;
}
function source(value: any): string {
  const result = typeof value === "string" ? value : value?.source;
  if (typeof result !== "string") throw new Error("Invalid native package entry");
  return result;
}
export function registeredPackages(settings: any, base: string) {
  const manager = new DefaultPackageManager({ cwd: base, agentDir: base, settingsManager: SettingsManager.inMemory(settings) });
  return (settings.packages ?? []).map((entry: any) => {
    const raw = source(entry); const local = manager.getInstalledPath(raw, "user");
    let manifest: any;
    if (local && fs.existsSync(path.join(local, "package.json"))) manifest = JSON.parse(fs.readFileSync(path.join(local, "package.json"), "utf8"));
    const npm = /^npm:(pi-subagents|pi-blackhole)(?:@(.+))?$/.exec(raw);
    return { source: raw, path: local, name: npm?.[1] ?? manifest?.name, version: npm ? npm[2] : manifest?.version };
  });
}
export function assertNoPending(root: string) {
  for (const kind of ["jobs", "runs"]) {
    const home = safePath(root, `.piccolo/${kind}`);
    if (!fs.existsSync(home)) continue;
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Refusing linked execution records");
      if (entry.isDirectory() && fs.existsSync(path.join(home, entry.name, "launch.json")) && !fs.existsSync(path.join(home, entry.name, "outcome.json"))) throw new Error(`Reconcile unfinished ${kind}/${entry.name} before initializing this project`);
    }
  }
}
export function planProject(cwd: string) {
  const root = fs.realpathSync(projectRoot(cwd));
  for (const relative of [".gitignore", ".piccolo/config.toml", ".pi/settings.json", ".pi/piccolo-profile.json", ".pi/pi-blackhole-config.json", ".pi/piccolo-onboarding.json", ".cache/piccolo/onboarding"] ) safePath(root, relative);
  const config = path.join(root, ".piccolo/config.toml");
  if (fs.existsSync(config)) configSchema.parse(parse(fs.readFileSync(config, "utf8")));
  readSettings(path.join(root, ".pi/settings.json"));
  assertNoPending(root);
  const templates = fs.readdirSync(path.join(packageRoot, "templates/execution"));
  for (const file of templates) safePath(root, `.piccolo/${file}`);
  // Reject coordination files hidden by existing project/global Git rules. Never
  // rewrite those rules or silently force-add work records.
  const probes = [".piccolo/config.toml", ...templates.map(f => `.piccolo/${f}`), ".piccolo/runs/probe/launch.json", ".piccolo/jobs/probe/launch.json"];
  const gitRoot = fs.existsSync(path.join(root, ".git"));
  if (gitRoot) {
    try {
      const ignored = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: root, input: probes.join("\n") + "\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      if (ignored.trim()) throw new Error("Existing Git rules hide .piccolo execution records; remove that ignore rule before init");
    } catch (error: any) { if (error.status !== 1) throw error; }
  }
  const ignore = fs.existsSync(path.join(root, ".gitignore")) ? fs.readFileSync(path.join(root, ".gitignore"), "utf8") : "";
  const missingIgnores = ["/.pi/", "/.cache/"].filter(rule => !ignore.split(/\r?\n/).includes(rule));
  const worktreePlacement = gitRoot ? planWorktreeArea(root) : undefined;
  return { root, create: [ ...(!fs.existsSync(config) ? [".piccolo/config.toml"] : []), ...templates.filter(f => !fs.existsSync(path.join(root, ".piccolo", f))).map(f => `.piccolo/${f}`) ], missingIgnores, worktreePlacement, native_configuration: true, inference: false };
}
export function prepareProject(cwd: string) {
  const plan = planProject(cwd);
  fs.mkdirSync(path.join(plan.root, ".piccolo"), { recursive: true });
  if (plan.create.includes(".piccolo/config.toml")) fs.writeFileSync(path.join(plan.root, ".piccolo/config.toml"), "# Project overrides; machine and package defaults are inherited.\nformat = 1\n", { flag: "wx" });
  initializeRecords(plan.root);
  if (plan.missingIgnores.length) {
    const file = path.join(plan.root, ".gitignore"); const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    fs.appendFileSync(file, `${old && !old.endsWith("\n") ? "\n" : ""}\n# Piccolo runtime and raw evidence\n${plan.missingIgnores.join("\n")}\n`);
  }
  fs.mkdirSync(path.join(plan.root, ".cache/piccolo/onboarding"), { recursive: true });
  if (plan.worktreePlacement) prepareWorktreeArea(plan.root);
  return plan;
}
/** Inspect Pi's effective resources, including project filters on global packages.
 * Raw registrations are not installed paths: autoload:false inherits user scope. */
export async function resolveInstalledPackages(cwd: string) {
  const home = agentDirectory();
  readSettings(safePath(home, "settings.json")); readSettings(safePath(cwd, ".pi/settings.json"));
  const manager = new DefaultPackageManager({ cwd, agentDir: home,
    settingsManager: SettingsManager.create(cwd, home, { projectTrusted: true }) });
  const resources = await manager.resolve(async missing => { throw new Error(`Package is not installed or version mismatched: ${missing}. Install it explicitly before init.`); });
  const packages = new Map<string, { path: string; source: string; name?: string; version?: string }>();
  for (const resource of Object.values(resources).flat()) {
    const { metadata } = resource;
    if (metadata.origin !== "package" || !metadata.baseDir) continue;
    const root = fs.realpathSync(metadata.baseDir);
    const file = path.join(root, "package.json");
    if (!fs.existsSync(file)) continue; // Native single-file extensions are valid.
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    packages.set(root, { path: root, source: metadata.source, name: manifest.name, version: manifest.version });
  }
  return [...packages.values()];
}
export async function verifyDeployment(cwd: string) {
  const all = await resolveInstalledPackages(cwd);
  const core = all.filter(p => p.name === "piccolo");
  if (!core.length || core.some(p => p.path !== fs.realpathSync(packageRoot))) throw new Error("This Piccolo checkout is not the sole registered core. Run piccolo setup, or reconcile another project/core registration first.");
  const sub = all.filter(p => p.name === "pi-subagents");
  if (!sub.length) throw new Error("Installed pi-subagents resources are missing. Run piccolo setup or check native package filters before init.");
  const supervisorPatch = JSON.parse(fs.readFileSync(path.join(packageRoot, "scripts/subagents-supervisor-patch.json"), "utf8"));
  for (const entry of all) {
    if (entry.name === "pi-subagents") for (const [file, expected] of Object.entries(supervisorPatch) as Array<[string, { patched: string }]>) {
      const installed = path.join(entry.path, file);
      if (!fs.existsSync(installed) || createHash("sha256").update(fs.readFileSync(installed)).digest("hex") !== expected.patched) throw new Error("Installed pi-subagents supervisor compatibility patch is not ready. Close Pi and run piccolo setup, or patch the stopped project installation explicitly.");
    }
    const required = entry.name === "pi-subagents" ? { version: "0.79.2", file: "src/runs/background/binary-bootstrap.js", hash: "e599d7012c98f470b1e3f579e4c2ac5477beab6b4856e772134a63df810e8130" }
      : entry.name === "pi-blackhole" ? { version: "0.5.15", file: "index.ts", hash: "fd386003c4f88da2ca25c0de97042294ed4b8b6621cf3ce550180b58621b0637" } : undefined;
    if (required && (entry.version !== required.version || !fs.existsSync(path.join(entry.path, required.file)) ||
      createHash("sha256").update(fs.readFileSync(path.join(entry.path, required.file))).digest("hex") !== required.hash)) {
      throw new Error(`Installed ${entry.name} version or compatibility patch is not ready. Run piccolo setup for global packages, or reconcile the project installation before init.`);
    }
  }
  return { packages: all };
}
/** Uses native command dispatch after discovering the command. No free-text prompt
 * is submitted, and no model response is necessary for configuration. */
export async function configureWithPi(root: string, pi = "pi") {
  const token = randomUUID(); const home = fs.mkdtempSync(path.join(root, ".cache/piccolo/onboarding/run-"));
  const log = fs.openSync(path.join(home, "native.log"), "wx", 0o600);
  const argv = ["--approve", "--mode", "rpc", "--session", path.join(home, "session.jsonl")];
  const child = spawn(pi, argv, { cwd: root, env: { ...process.env, PI_OFFLINE: "1" }, stdio: ["pipe", "pipe", log] });
  let buffer = "", sent = false, failure: Error | undefined;
  const send = (value: unknown) => child.stdin!.write(JSON.stringify(value) + "\n");
  child.stdin!.on("error", () => {});
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { failure = new Error(`Native onboarding timed out; inspect ${home}`); child.kill("SIGTERM"); }, 90000);
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 100000);
    child.on("error", error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.stdout!.on("data", data => {
      fs.writeSync(log, data); buffer += data.toString();
      if (buffer.length > 2 * 1024 * 1024) { failure = new Error("Oversized native onboarding output"); child.kill("SIGTERM"); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "extension_error") { failure = new Error(`Native extension failed during onboarding; inspect ${home}`); child.kill("SIGTERM"); }
        if (event.type === "agent_start") { failure = new Error("Unexpected inference during onboarding"); child.kill("SIGTERM"); }
        if (event.type === "response" && event.id === "commands" && !sent) {
          sent = true;
          if (!event.success || !event.data?.commands?.some((c: any) => c.name === "piccolo-onboard" && c.source === "extension" &&
            typeof c.sourceInfo?.path === "string" && fs.existsSync(c.sourceInfo.path) &&
            fs.realpathSync(c.sourceInfo.path) === fs.realpathSync(path.join(packageRoot, "extensions/piccolo.ts")))) {
            failure = new Error("Piccolo onboarding command did not load. Check package filters/order and native.log; no prompt was submitted."); child.stdin!.end();
          } else send({ type: "prompt", id: "configure", message: `/piccolo-onboard ${token}` });
        }
      }
    });
    child.on("close", code => { clearTimeout(timer); clearTimeout(killTimer); if (failure) reject(failure); else if (code !== 0) reject(new Error(`Native Pi exited ${code}; inspect ${home}`)); else resolve(); });
  });
  send({ type: "get_commands", id: "commands" });
  try { await exited; } finally { fs.closeSync(log); }
  const result = readSettings(safePath(root, ".pi/piccolo-onboarding.json"));
  if (result.token !== token || result.piccolo !== version() || result.cwd !== root) throw new Error(`Native configuration receipt missing or mismatched; inspect ${home}`);
  return { ...result, evidence: home, next: "Run pi from this project. Use piccolo_submit for session-owned jobs." };
}
