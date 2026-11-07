import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLayer, resolveLayers, packageRoot } from "../src/config.ts";
import { applyProfile, assertProfile } from "../src/profiles.ts";

const builtin = readLayer(path.join(packageRoot, "config/defaults.toml"))!;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-profile-test-"));
  const pkg = path.join(root, ".pi/npm/node_modules/pi-blackhole"); fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "index.ts"), "// inert test fixture, never imported\n");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "pi-blackhole", version: "0.5.15" }));
  return root;
}
test("Blackhole disables configured server compaction; baseline restores only owned fields", () => {
  const root = fixture();
  try {
    const settings = path.join(root, ".pi/settings.json");
    fs.writeFileSync(settings, JSON.stringify({ packages: ["fixture-package"], fixtureServerCompaction: { enabled: true, keep: 1 } }));
    const layer = { source: "test", value: { integration: { server_compaction: "settings", server_compaction_key: "fixtureServerCompaction" } } };
    const blackhole = resolveLayers(builtin, [layer], "blackhole");
    applyProfile(root, blackhole); assertProfile(root, blackhole);
    const current = JSON.parse(fs.readFileSync(settings, "utf8"));
    assert.equal(current.fixtureServerCompaction.enabled, false);
    current.fixtureServerCompaction.later = 2; fs.writeFileSync(settings, JSON.stringify(current));
    const baseline = resolveLayers(builtin, [layer], "baseline");
    applyProfile(root, baseline); assertProfile(root, baseline);
    const restored = JSON.parse(fs.readFileSync(settings, "utf8"));
    assert.deepEqual(restored.fixtureServerCompaction, { enabled: true, keep: 1, later: 2 });
    assert.deepEqual(restored.packages, ["fixture-package"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".pi/pi-blackhole-config.json"), "utf8")).compactionEngine, "pi-default");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("reject mismatched owner/server policy and detect native drift", () => {
  const root = fixture();
  try {
    assert.throws(() => resolveLayers(builtin, [], "blackhole", { compaction: { server: "inherit" } }), /must disable/);
    const r = resolveLayers(builtin, [{ source: "test", value: { integration: { server_compaction: "settings", server_compaction_key: "fixtureServerCompaction" } } }], "blackhole");
    assert.throws(() => assertProfile(root, r), /not materialized/);
    applyProfile(root, r);
    fs.writeFileSync(path.join(root, ".pi/settings.json"), JSON.stringify({ fixtureServerCompaction: { enabled: true } }));
    assert.throws(() => assertProfile(root, r), /must be disabled/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("pending execution blocks reconfiguration", () => {
  const root = fixture();
  try {
    fs.mkdirSync(path.join(root, ".piccolo/runs/pending"), { recursive: true });
    fs.writeFileSync(path.join(root, ".piccolo/runs/pending/launch.json"), "{}");
    assert.throws(() => applyProfile(root, resolveLayers(builtin)), /no terminal outcome/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("server setting adapters require a safe explicit key and baseline before key changes", () => {
  assert.throws(() => resolveLayers(builtin, [], undefined, { integration: { server_compaction: "settings" } }), /safe server_compaction_key/);
  assert.throws(() => resolveLayers(builtin, [], undefined, { integration: { server_compaction: "settings", server_compaction_key: "__proto__" } }), /safe server_compaction_key/);
  const root = fixture();
  try {
    const layer = { source: "test", value: { integration: { server_compaction: "settings", server_compaction_key: "fixtureServerCompaction" } } };
    const settings = path.join(root, ".pi/settings.json");
    fs.writeFileSync(settings, JSON.stringify({ fixtureServerCompaction: { enabled: true, keep: 1 } }));
    applyProfile(root, resolveLayers(builtin, [layer], "blackhole"));
    const before = fs.readFileSync(settings, "utf8");
    const changed = resolveLayers(builtin, [layer], "blackhole", { integration: { server_compaction_key: "otherCompaction" } });
    assert.throws(() => applyProfile(root, changed), /Restore the baseline/);
    assert.equal(fs.readFileSync(settings, "utf8"), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
