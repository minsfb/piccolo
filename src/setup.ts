import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { packageRoot } from "./config.ts";
import { agentDirectory, readSettings, registeredPackages, safePath } from "./onboarding.ts";

export const quietDefaults = { hideThinkingBlock: true, collapseChangelog: true, quietStartup: true } as const;
/** Seed native user defaults once; native /settings and project overrides retain ownership. */
export function applyQuietDefaults(home: string) {
  const file = safePath(home, "settings.json");
  const settings = readSettings(file);
  const added = Object.fromEntries(Object.entries(quietDefaults).filter(([key]) => !Object.hasOwn(settings, key)));
  if (!Object.keys(added).length) return added;
  const temporary = safePath(home, `settings.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...settings, ...added }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return added;
}

type Options = { pi?: string; deployment?: string; blackhole?: boolean; binDir?: string; noBin?: boolean; dryRun?: boolean };
export function setupPlan(options: Options = {}) {
  const home = agentDirectory();
  const deployment = options.deployment ?? "native";
  if (!["auto", "native"].includes(deployment)) throw new Error("Setup supports native Pi packages; install deployment contributions explicitly with Pi");
  const settingsFile = safePath(home, "settings.json");
  const settings = readSettings(settingsFile);
  const present = registeredPackages(settings, home);
  const wanted = [ { name: "piccolo", version: JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version, source: packageRoot },
    { name: "pi-subagents", version: "0.79.2", source: "npm:pi-subagents@0.79.2" },
    { name: "pi-harness-health", version: JSON.parse(fs.readFileSync(path.join(packageRoot, "packages/health/package.json"), "utf8")).version, source: path.join(packageRoot, "packages/health") },

    ...(options.blackhole ? [{ name: "pi-blackhole", version: "0.5.15", source: "npm:pi-blackhole@0.5.15" }] : []) ];
  for (const entry of wanted) {
    for (const installed of present.filter((p: any) => p.name === entry.name)) {
      if (installed.version !== entry.version || (entry.source.startsWith("/") && (!installed.path || fs.realpathSync(installed.path) !== fs.realpathSync(entry.source)))) throw new Error(`Conflicting ${entry.name} registration; reconcile it using native Pi package management before setup`);
    }
  }
  const bin = options.noBin ? undefined : path.resolve(options.binDir ?? path.join(os.homedir(), ".local/bin"), "piccolo");
  if (bin) {
    try { if (!fs.lstatSync(bin).isSymbolicLink() || path.resolve(path.dirname(bin), fs.readlinkSync(bin)) !== path.join(packageRoot, "bin/piccolo.mjs")) throw new Error(`Existing command is not owned by this checkout: ${bin}`); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  if (options.blackhole) safePath(home, "pi-blackhole/pi-blackhole-config.json");
  return { home, deployment: "native", bin, packages: wanted, missing: wanted.filter(entry => !present.some((p: any) => p.name === entry.name)), quiet_defaults: Object.fromEntries(Object.entries(quietDefaults).filter(([key]) => !Object.hasOwn(settings, key))), requires: "Close Pi sessions using this agent directory before setup. Restart afterward.", inference: false };
}
export function setup(options: Options = {}) {
  const plan = setupPlan(options);
  if (options.dryRun) return plan;
  fs.mkdirSync(plan.home, { recursive: true });
  const lock = safePath(plan.home, "piccolo-setup.lock");
  const descriptor = fs.openSync(lock, "wx", 0o600);
  const evidence = fs.mkdtempSync(path.join(plan.home, "piccolo-setup-"));
  const log = fs.openSync(path.join(evidence, "native.log"), "wx", 0o600);
  const run = (command: string, args: string[]) => {
    try { execFileSync(command, args, { cwd: plan.home, stdio: ["ignore", log, log], timeout: 180000 }); }
    catch { throw new Error(`Setup command failed; inspect ${evidence}/native.log. Completed native installs remain registered; no rollback or removal was attempted.`); }
  };
  try {
    // Revalidate after admission; never install from a stale pre-lock snapshot.
    const current = setupPlan(options);
    if (options.blackhole) {
      const file = safePath(plan.home, "pi-blackhole/pi-blackhole-config.json");
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ compaction: "off", memory: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      }
    }
    for (const entry of current.missing) run(options.pi ?? "pi", ["install", entry.source, "--approve"]);
    const installed = registeredPackages(readSettings(path.join(plan.home, "settings.json")), plan.home);
    for (const entry of plan.packages.filter(p => p.name === "pi-subagents" || p.name === "pi-blackhole")) {
      const registration = installed.find((p: any) => p.name === entry.name);
      if (!registration) throw new Error(`Native Pi did not register ${entry.name}; inspect ${evidence}`);
      const root = registration.path ?? path.join(plan.home, "npm/node_modules", entry.name);
      if (entry.name === "pi-subagents") run("python3", [path.join(packageRoot, "scripts", "subagents-supervisor-compat.py"), "--package-root", root]);
    }
    const quietDefaultsAdded = applyQuietDefaults(plan.home);
    if (plan.bin && !fs.existsSync(plan.bin)) {
      fs.mkdirSync(path.dirname(plan.bin), { recursive: true });
      fs.symlinkSync(path.join(packageRoot, "bin/piccolo.mjs"), plan.bin);
    }
    return { ...plan, quiet_defaults: quietDefaultsAdded, status: "configured", evidence, next: "Run piccolo init in a project, then pi. Ensure the command directory is on PATH." };
  } finally { fs.closeSync(log); fs.closeSync(descriptor); fs.unlinkSync(lock); }
}
