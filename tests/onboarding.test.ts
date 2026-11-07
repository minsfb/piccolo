import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { planProject, prepareProject, configureWithPi, verifyDeployment, resolveInstalledPackages } from "../src/onboarding.ts";
import { setupPlan } from "../src/setup.ts";
import { packageRoot, bootstrapWorkflowEngine, loadConfig } from "../src/config.ts";

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-onboard-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}
function put(root: string, name: string, value: string) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), value); }

test("project planning is read-only; initialization preserves edits and is repeatable from a subdirectory", () => {
  const root = fixture();
  try {
    put(root, ".gitignore", "build/\n# keep my comments\n"); put(root, ".piccolo/design.md", "my actual design");
    put(root, ".piccolo/config.toml", '# keep config comments\nformat=1\nprofile="from-package"\n');
    put(root, ".pi/settings.json", JSON.stringify({ theme: "custom", packages: [{ source: "npm:example", extensions: [] }] }));
    fs.mkdirSync(path.join(root, "src"));
    const before = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    const plan = planProject(path.join(root, "src")); assert.equal(plan.root, root);
    assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), before);
    assert.equal(plan.worktreePlacement?.ownerRoot, root);
    assert.equal(fs.existsSync(path.join(root, ".worktrees")), false);
    prepareProject(root);
    const first = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    assert.match(first, /\/\.worktrees\//);
    assert.ok(fs.statSync(path.join(root, ".worktrees")).isDirectory());
    prepareProject(root); assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), first);
    assert.equal(fs.readFileSync(path.join(root, ".piccolo/design.md"), "utf8"), "my actual design");
    assert.match(fs.readFileSync(path.join(root, ".piccolo/config.toml"), "utf8"), /keep config comments/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".pi/settings.json"), "utf8")).theme, "custom");
    assert.deepEqual(planProject(root).create, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("bad config, symlinks, hidden ledgers and unfinished work fail before initialization", () => {
  for (const scenario of ["config", "link", "ignore", "pending", "settings"]) {
    const root = fixture();
    try {
      if (scenario === "config") put(root, ".piccolo/config.toml", 'unknown = "field"');
      if (scenario === "settings") put(root, ".pi/settings.json", '[]');
      if (scenario === "ignore") put(root, ".gitignore", '.piccolo/\n');
      if (scenario === "pending") put(root, ".piccolo/jobs/active/launch.json", '{}');
      if (scenario === "link") { fs.mkdirSync(path.join(root, "elsewhere")); fs.symlinkSync(path.join(root, "elsewhere"), path.join(root, ".piccolo")); }
      assert.throws(() => prepareProject(root));
      assert.equal(fs.existsSync(path.join(root, ".piccolo/roadmap.md")), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("machine dry run exposes native operations and refuses conflicting package/command ownership", async () => {
  const root = fixture(); const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const result = setupPlan({ binDir: path.join(root, "bin") });
    assert.equal(result.deployment, "native");
    assert.deepEqual(setupPlan({ deployment: "auto", noBin: true }).packages, result.packages);
    assert.throws(() => setupPlan({ deployment: "unknown", noBin: true }), /install deployment contributions explicitly/);
    assert.deepEqual(result.missing.map(entry => entry.name), ["piccolo", "pi-subagents", "pi-harness-health"]); assert.equal(result.inference, false);
    assert.equal(fs.existsSync(path.join(root, "settings.json")), false);
    put(root, "settings.json", JSON.stringify({ packages: ["npm:pi-subagents@0.99.0"] }));
    assert.throws(() => setupPlan({ deployment: "native", noBin: true }), /Conflicting/);
    put(root, "settings.json", '{}'); put(root, "bin/piccolo", "unrelated command");
    assert.throws(() => setupPlan({ deployment: "native", binDir: path.join(root, "bin") }), /not owned/);
    put(root, "settings.json", JSON.stringify({ packages: [packageRoot, "npm:pi-subagents@0.79.2"] }));
    await assert.rejects(verifyDeployment(root), /not installed/);
  } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; fs.rmSync(root, { recursive: true, force: true }); }
});

test("native onboarding requires discovered command and matching receipt without inference", async () => {
  for (const mode of ["success", "missing", "stale", "prompt", "foreign"]) {
    const root = fixture();
    try {
      prepareProject(root);
      const fake = path.join(root, "fake-pi");
      const script = `#!${process.execPath}\nconst fs=require('fs');const readline=require('readline');
if(process.env.PI_OFFLINE!=='1')process.exit(5);
const lines=readline.createInterface({input:process.stdin});
lines.on('line',l=>{const r=JSON.parse(l);fs.appendFileSync('requests.jsonl',l+'\\n');
if(r.type==='get_commands') console.log(JSON.stringify({type:'response',id:'commands',success:true,data:{commands:${mode === 'missing' ? '[]' : JSON.stringify([{name:'piccolo-onboard',source:mode === 'prompt' ? 'prompt' : 'extension',sourceInfo:{path:mode === 'foreign' ? fake : path.join(packageRoot, 'extensions/piccolo.ts')}}])}}}));
else {if(!r.message.startsWith('/piccolo-onboard '))process.exit(4);fs.mkdirSync('.pi',{recursive:true});fs.writeFileSync('.pi/piccolo-onboarding.json',JSON.stringify({token:${mode === 'stale' ? '"stale"' : 'r.message.split(" ")[1]'},piccolo:${JSON.stringify(JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version)},cwd:process.cwd(),inference:false}));process.exit(0);}
});`;
      fs.writeFileSync(fake, script, { mode: 0o700 });
      if (mode === "success") assert.equal((await configureWithPi(root, fake)).inference, false);
      else await assert.rejects(configureWithPi(root, fake), ["missing", "prompt", "foreign"].includes(mode) ? /did not load/ : /mismatched/);
      const requests = fs.readFileSync(path.join(root, "requests.jsonl"), "utf8").trim().split('\n').map(s => JSON.parse(s));
      assert.equal(requests.length, ["missing", "prompt", "foreign"].includes(mode) ? 1 : 2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("extension bootstrap defers package references but keeps file engine merge operations", () => {
  const root = fixture(); const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, "user");
  try {
    put(root, "user/piccolo/config.toml", '[workflow]\nengine="extensible"\n');
    put(root, ".piccolo/config.toml", 'profile="package_profile"\n[agents.local]\nmodel="alias:package_model"\n[operations]\nremove=["/workflow"]\n');
    assert.equal(bootstrapWorkflowEngine(root), "subagents");
    assert.throws(() => loadConfig(root), /Unknown profile/);
    const resolved = loadConfig(root, { contributions: [{ source: "test package", value: { profiles: { package_profile: {} }, models: { package_model: { model: "provider/model" } } } }] });
    assert.equal(resolved.profile, "package_profile");
  } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; fs.rmSync(root, { recursive: true, force: true }); }
});

test("setup refuses unknown patch bytes without replacing registrations or leaving a lock", async () => {
  const { setup } = await import("../src/setup.ts");
  const root = fixture(); const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  try {
    const local = path.join(root, 'subagents');
    put(root, 'subagents/package.json', JSON.stringify({ name: 'pi-subagents', version: '0.79.2' }));
    put(root, 'subagents/src/slash/delegation-request.js', 'unknown source');
    put(root, 'settings.json', JSON.stringify({ theme: 'keep', packages: [packageRoot, local, path.join(packageRoot, 'packages/health'), 'npm:unrelated'] }));
    const fakePi = path.join(root, 'must-not-install');
    const marker = path.join(root, 'installer-called');
    fs.writeFileSync(fakePi, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected install');process.exit(99);\n`, { mode: 0o700 });
    assert.throws(() => setup({ pi: fakePi, deployment: 'native', binDir: path.join(root, 'bin') }), /Setup command failed/);
    assert.equal(fs.existsSync(marker), false, 'patch test must not invoke a package installer');
    const evidence = fs.readdirSync(root).find(name => name.startsWith('piccolo-setup-'))!;
    assert.match(fs.readFileSync(path.join(root, evidence, 'native.log'), 'utf8'), /Unrecognized supervisor bridge source; refusing to modify it/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).theme, 'keep');
    assert.equal(fs.existsSync(path.join(root, 'bin/piccolo')), false);
    assert.equal(fs.existsSync(path.join(root, 'piccolo-setup.lock')), false);
    assert.equal(fs.readFileSync(path.join(local, 'src/slash/delegation-request.js'), 'utf8'), 'unknown source');
  } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; fs.rmSync(root, { recursive: true, force: true }); }
});


test("deployment checks native project paths and installed compatibility before initialization", async () => {
  const root = fixture(); const old = process.env.PI_CODING_AGENT_DIR;
  const agent = path.join(root, "agent"); process.env.PI_CODING_AGENT_DIR = agent;
  try {
    put(root, "agent/settings.json", JSON.stringify({ packages: ["npm:pi-subagents@0.79.2"] }));
    put(root, ".pi/settings.json", JSON.stringify({ packages: [path.relative(path.join(root, ".pi"), packageRoot)] }));
    // Relative core is accepted; rejection is for genuinely absent subagents.
    await assert.rejects(verifyDeployment(root), /not installed/);
    put(root, "agent/npm/node_modules/pi-subagents/package.json", JSON.stringify({ name: "pi-subagents", version: "0.79.2", pi: { extensions: ["index.ts"] } }));
    put(root, "agent/npm/node_modules/pi-subagents/src/runs/background/binary-bootstrap.js", "unpatched");
    put(root, "agent/npm/node_modules/pi-subagents/index.ts", "export default () => {};");
    await assert.rejects(verifyDeployment(root), /compatibility patch/);
    put(root, "other-core/index.ts", "export default () => {};\n");
    put(root, "other-core/package.json", JSON.stringify({ name: "piccolo", version: "1.8.0", pi: { extensions: ["index.ts"] } }));
    put(root, "agent/settings.json", JSON.stringify({ packages: [packageRoot, "npm:pi-subagents@0.79.2"] }));
    put(root, ".pi/settings.json", JSON.stringify({ packages: ["../other-core"] }));
    await assert.rejects(verifyDeployment(root), /sole registered core/);
    assert.equal(fs.existsSync(path.join(root, ".piccolo")), false);
  } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; fs.rmSync(root, { recursive: true, force: true }); }
});


test("native project filters inherit global package roots and unversioned delta identity", async () => {
  const root = fixture(); const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  try {
    put(root, "agent/settings.json", JSON.stringify({ packages: [packageRoot, "npm:pi-subagents@0.79.2", "npm:onboarding-fixture@1.0.0"] }));
    for (const [name, version] of [["pi-subagents", "0.79.2"], ["onboarding-fixture", "1.0.0"]]) {
      put(root, `agent/npm/node_modules/${name}/package.json`, JSON.stringify({ name, version, pi: { extensions: ["index.ts"] } }));
      put(root, `agent/npm/node_modules/${name}/index.ts`, "export default () => {};\n");
    }
    put(root, ".pi/settings.json", JSON.stringify({ packages: [
      { source: "npm:pi-subagents", autoload: false, extensions: [] },
      { source: "npm:onboarding-fixture", autoload: false, extensions: ["-index.ts"] },
    ] }));
    const packages = await resolveInstalledPackages(root);
    assert.equal(packages.find(p => p.name === "onboarding-fixture")?.path, path.join(root, "agent/npm/node_modules/onboarding-fixture"));
    assert.equal(packages.find(p => p.name === "pi-subagents")?.version, "0.79.2");
    // Unversioned project delta inherits the pin; only our deliberately absent patch fails.
    await assert.rejects(verifyDeployment(root), /compatibility patch/);
    assert.equal(fs.existsSync(path.join(root, ".pi/npm")), false);
  } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; fs.rmSync(root, { recursive: true, force: true }); }
});


test("setup recognizes native bare relative and git-installed registrations before mutation", () => {
  const root = fixture(); const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    for (const [source, local] of [["subagents", "subagents"], ["git:https://example.invalid/team/subagents", "git/example.invalid/team/subagents"]]) {
      put(root, `${local}/package.json`, JSON.stringify({ name: "pi-subagents", version: "0.99.0" }));
      put(root, "settings.json", JSON.stringify({ packages: [source] }));
      assert.throws(() => setupPlan({ deployment: "native", noBin: true }), /Conflicting pi-subagents/);
      assert.equal(fs.existsSync(path.join(root, "npm")), false);
    }
    put(root, "subagents/package.json", JSON.stringify({ name: "pi-subagents", version: "0.79.2" }));
    put(root, "settings.json", JSON.stringify({ packages: ["subagents"] }));
    assert.equal(setupPlan({ deployment: "native", noBin: true }).missing.some(p => p.name === "pi-subagents"), false);
  } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; fs.rmSync(root, { recursive: true, force: true }); }
});


test("default health registration uses its manifest and repeated setup accepts the installed package", () => {
  const root = fixture(); const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const health = path.join(packageRoot, "packages/health");
    const version = JSON.parse(fs.readFileSync(path.join(health, "package.json"), "utf8")).version;
    const first = setupPlan({ deployment: "native", noBin: true });
    assert.equal(first.packages.find(p => p.name === "pi-harness-health")?.version, version);
    put(root, "settings.json", JSON.stringify({ packages: [packageRoot, "npm:pi-subagents@0.79.2", health] }));
    assert.deepEqual(setupPlan({ deployment: "native", noBin: true }).missing, []);
    put(root, "other-health/package.json", JSON.stringify({ name: "pi-harness-health", version }));
    put(root, "settings.json", JSON.stringify({ packages: [path.join(root, "other-health")] }));
    assert.throws(() => setupPlan({ deployment: "native", noBin: true }), /Conflicting pi-harness-health/);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quiet native defaults fill omissions once and preserve explicit and unrelated settings", async () => {
  const { applyQuietDefaults, quietDefaults } = await import("../src/setup.ts");
  const root = fixture();
  try {
    assert.deepEqual(applyQuietDefaults(root), quietDefaults);
    const file = path.join(root, "settings.json");
    const first = fs.readFileSync(file, "utf8");
    assert.deepEqual(applyQuietDefaults(root), {}); assert.equal(fs.readFileSync(file, "utf8"), first);
    put(root, "settings.json", JSON.stringify({ hideThinkingBlock: false, quietStartup: false, theme: "light", packages: ["fixture"], compaction: { enabled: false } }));
    assert.deepEqual(applyQuietDefaults(root), { collapseChangelog: true });
    const actual = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(actual.hideThinkingBlock, false); assert.equal(actual.quietStartup, false);
    assert.equal(actual.theme, "light"); assert.deepEqual(actual.packages, ["fixture"]); assert.deepEqual(actual.compaction, { enabled: false });
    const target = path.join(root, "other.json"); fs.renameSync(file, target); fs.symlinkSync(target, file);
    assert.throws(() => applyQuietDefaults(root), /unsafe onboarding path/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
