import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { loadHealthConfig, resolveHealthConfig, selectsManagedWake } from "../packages/health/src/config.ts";

test("health layers merge nested defaults without mutating inputs or environment", () => {
  const before = { ...process.env };
  const first = { interval_ms: 9000, diagnostic: { enabled: true, model: "test/cheap", interval_ms: 8000 } };
  const second = { recovery: "observe", diagnostic: { max_calls: 2 } };
  const original = structuredClone([first, second]);
  const config = resolveHealthConfig([first, second, { interval_ms: 7000, diagnostic: { enabled: false } }]);
  assert.equal(config.interval_ms, 7000); assert.equal(config.recovery, "observe");
  assert.equal(config.diagnostic.model, "test/cheap"); assert.equal(config.diagnostic.interval_ms, 8000);
  assert.equal(config.diagnostic.max_calls, 2); assert.equal(config.diagnostic.enabled, false);
  assert.equal(config.diagnostic.max_tokens, 1024);
  assert.equal(config.compatibility, "off");
  assert.equal(resolveHealthConfig([{ compatibility: "managed-0.85.1" }]).compatibility, "managed-0.85.1");
  assert.equal(resolveHealthConfig([{ compatibility: "managed-0.86.1" }]).compatibility, "managed-0.86.1");
  assert.throws(() => resolveHealthConfig([{ compatibility: "managed-0.86.2" }]));
  assert.deepEqual([first, second], original); assert.deepEqual({ ...process.env }, before);
});

test("diagnostic inference is disabled by default and enabling requires an explicit registered model selector", () => {
  assert.equal(resolveHealthConfig([]).diagnostic.enabled, false);
  assert.equal(resolveHealthConfig([{ diagnostic: { enabled: false } }]).diagnostic.model, undefined);
  assert.throws(() => resolveHealthConfig([{ diagnostic: { enabled: true } }]), /explicit diagnostic.model/);
  const enabled = resolveHealthConfig([{ diagnostic: { enabled: true, model: "test/cheap" } }]);
  assert.equal(enabled.diagnostic.model, "test/cheap");
  // Resolution validates selector syntax; availability is checked only when inference runs.
  assert.throws(() => resolveHealthConfig([{ diagnostic: { enabled: true, model: "invalid selector" } }]), /diagnostic.model/);
});

test("unknown fields, invalid bounds, tables and unsafe keys are rejected without echoing secret values", () => {
  const secret = "TOKEN-NOT-FOR-CONFIG-ERRORS";
  for (const layer of [
    { mystery: secret }, { diagnostic: { mystery: secret } }, { interval_ms: secret },
    { interval_ms: 999 }, { attention_ms: 86400001 }, { retry_ms: 1.1 }, { max_attempts: 0 },
    { max_attempts: 21 }, { recovery: secret }, { compatibility: secret }, { diagnostic: { max_tokens: 4097 } },
    { diagnostic: { model: secret } }, { diagnostic: { max_calls: 101 } },
  ]) {
    assert.throws(() => resolveHealthConfig([layer]), error => {
      assert.ok(error instanceof Error); assert.equal(error.message.includes(secret), false); return true;
    });
  }
  for (const layer of [null, [], "table", JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: {} }])
    assert.throws(() => resolveHealthConfig([layer]));
  assert.equal(({} as any).polluted, undefined);
});

test("user TOML, trusted project TOML and integration override cascade without changing files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-health-config-"));
  const previous = process.env.XDG_CONFIG_HOME;
  const configHome = path.join(directory, "configuration"), project = path.join(directory, "project");
  fs.mkdirSync(path.join(configHome, "pi-harness-health"), { recursive: true });
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  const userFile = path.join(configHome, "pi-harness-health/config.toml"), projectFile = path.join(project, ".pi/health.toml");
  const userText = 'interval_ms = 9000\n[diagnostic]\nenabled = false\nmax_calls = 4\n';
  const projectText = 'interval_ms = 8000\n[diagnostic]\nmax_calls = 2\n';
  fs.writeFileSync(userFile, userText); fs.writeFileSync(projectFile, projectText);
  process.env.XDG_CONFIG_HOME = configHome;
  try {
    const environment = { ...process.env };
    const trusted = loadHealthConfig(project, true, { interval_ms: 7000 });
    assert.equal(trusted.interval_ms, 7000); assert.equal(trusted.diagnostic.max_calls, 2);
    const untrusted = loadHealthConfig(project, false);
    assert.equal(untrusted.interval_ms, 9000); assert.equal(untrusted.diagnostic.max_calls, 4);
    assert.equal(fs.readFileSync(userFile, "utf8"), userText); assert.equal(fs.readFileSync(projectFile, "utf8"), projectText);
    assert.deepEqual({ ...process.env }, environment);
    fs.writeFileSync(projectFile, 'token = "PRIVATE-VALUE\n');
    assert.throws(() => loadHealthConfig(project, true), error => {
      assert.ok(error instanceof Error); assert.equal(error.message.includes("PRIVATE-VALUE"), false); return true;
    });
    assert.equal(loadHealthConfig(project, false).interval_ms, 9000, "untrusted malformed project file is not read");
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("Piccolo defaults enable monitoring with compatibility patches off and editable overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-health-defaults-"));
  const userFile = path.join(root, "user.toml");
  fs.mkdirSync(path.join(root, ".piccolo"));
  const resolve = () => {
    const config = loadConfig(root, { userFile });
    return { health: resolveHealthConfig([config.config.extensions?.["pi-harness-health"] ?? {}]), config };
  };
  try {
    const initial = resolve();
    assert.equal(initial.health.enabled, true);
    assert.equal(initial.health.recovery, "wake");
    assert.equal(initial.health.compatibility, "off");
    assert.equal(initial.health.diagnostic.enabled, false);
    assert.equal(initial.config.config.background?.notifications, "follow_up");
    assert.match(initial.config.origins["/extensions/pi-harness-health/compatibility"], /config\/defaults.toml$/);
    assert.equal(resolveHealthConfig([]).compatibility, "off", "standalone installation remains opt-in");
    fs.writeFileSync(userFile, '[extensions.pi-harness-health]\ncompatibility="off"\nrecovery="observe"\n');
    assert.equal(resolve().health.compatibility, "off");
    assert.equal(resolve().health.recovery, "observe");
    fs.writeFileSync(path.join(root, ".piccolo/config.toml"), '[extensions.pi-harness-health]\nenabled=false\n');
    assert.equal(resolve().health.enabled, false);
    assert.equal(resolve().config.origins["/extensions/pi-harness-health/enabled"], path.join(root, ".piccolo/config.toml"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("managed selection uses qualified current adapters while explicit version/off keep their meaning", () => {
  assert.equal(resolveHealthConfig([{ compatibility: "managed" }]).compatibility, "managed");
  assert.equal(resolveHealthConfig([{ compatibility: "managed-1.4.0" }]).compatibility, "managed-1.4.0");
  assert.equal(selectsManagedWake("managed", "1.4.0"), true);
  assert.equal(selectsManagedWake("managed-1.3.0", "1.3.0"), true);
  assert.equal(selectsManagedWake("managed-1.3.0", "1.4.0"), false);
  assert.equal(selectsManagedWake("off", "1.4.0"), false);
});
