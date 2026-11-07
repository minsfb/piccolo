import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLayers, resolveAgent, readLayer, loadConfig, packageRoot } from "../src/config.ts";

const builtin = readLayer(path.join(packageRoot, "config/defaults.toml"))!;
test("layers preserve omitted defaults; arrays and invocation panels replace", () => {
  const resolved = resolveLayers(builtin, [
    { source: "user", value: { agents: { reviewer: { model: "alias:review", skills: ["a", "b"] } }, models: { review: { model: "p/m", effort: "high" } } } },
    { source: "project", value: { agents: { reviewer: { skills: ["c"] } }, profiles: { quick: { agents: { reviewer: { effort: "low" } } } } } },
  ], "quick", { agents: { reviewer: { effort: "medium" } }, jobs: { implementation: { stages: { review: { agents: ["reviewer", "qa"] } } } } });
  assert.equal(resolved.config.background?.executor, "durable");
  assert.equal(resolveLayers(builtin, [{ source: "comparison", value: { background: { executor: "native" } } }]).config.background?.executor, "native");
  const agent = resolveAgent(resolved, "reviewer");
  assert.equal(agent.model, "p/m"); assert.equal(agent.effort, "medium");
  assert.deepEqual(agent.skills, ["c"]); assert.equal(agent.context, "fresh");
  assert.deepEqual(resolved.config.jobs!.implementation.stages!.review.agents, ["reviewer", "qa"]);
  assert.equal(resolved.origins["/agents/reviewer/effort"], "invocation");
  assert.equal(resolved.origins["/agents/reviewer/skills"], "project");
});
test("reset restores builtin fields while remove deletes inherited optional definitions", () => {
  const r = resolveLayers(builtin, [
    { source: "user", value: { agents: { reviewer: { tools: ["write"] }, spare: { model: "p/m" } } } },
    { source: "project", value: { operations: { reset: ["/agents/reviewer/tools"], remove: ["/agents/spare"] } } },
  ]);
  assert.deepEqual(r.config.agents!.reviewer.tools, ["read", "grep", "find", "ls", "bash"]);
  assert.equal(r.config.agents!.spare, undefined);
  assert.match(r.origins["/agents/reviewer/tools"], /reset to builtin/);
  assert.throws(() => resolveLayers(builtin, [], undefined, { operations: { remove: ["/agents/reviewer"] } }), /unknown agent/);
});
test("reject misspellings, unsafe keys, unknown references, and alias cycles", () => {
  assert.throws(() => resolveLayers(builtin, [{ source: "bad.toml", value: { agents: { reviewer: { efort: "high" } } } }]), /bad.toml/);
  assert.throws(() => resolveLayers(builtin, [], undefined, JSON.parse('{"agents":{"__proto__":{}}}')), /Forbidden/);
  assert.throws(() => resolveLayers(builtin, [], undefined, { models: { a: { model: "alias:b" }, b: { model: "alias:a" } } }), /cycle/);
  assert.throws(() => resolveLayers(builtin, [], undefined, { agents: { reviewer: { model: "alias:missing" } } }), /Missing model alias/);
  assert.throws(() => resolveLayers(builtin, [], "missing"), /Unknown profile/);
});
test("file loading distinguishes absent from invalid TOML and does not rewrite files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-config-test-"));
  try {
    fs.mkdirSync(path.join(root, ".piccolo"));
    const file = path.join(root, ".piccolo/config.toml");
    const content = '# preserve comment\n[agents.reviewer]\neffort = "high"\n';
    fs.writeFileSync(file, content);
    const r = loadConfig(root, { userFile: path.join(root, "absent.toml") });
    assert.equal(resolveAgent(r, "reviewer").effort, "high");
    assert.equal(fs.readFileSync(file, "utf8"), content);
    fs.writeFileSync(file, 'not TOML = [');
    assert.throws(() => loadConfig(root, { userFile: path.join(root, "absent.toml") }), /config.toml/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Switching runtimes is an explicit native-session deployment choice.
test("workflow engine is opt-in and rejects invented implementations", () => {
  assert.equal(resolveLayers({ source: "builtin", value: {} }).config.workflow, undefined);
  assert.equal(resolveLayers({ source: "builtin", value: {} }, [{ source: "project", value: { workflow: { engine: "extensible" } } }]).config.workflow?.engine, "extensible");
  assert.throws(() => resolveLayers({ source: "builtin", value: { workflow: { engine: "unknown" } } }));
  assert.throws(() => resolveLayers({ source: "builtin", value: { workflow: { engine: "extensible" }, compaction: { owner: "blackhole", server: "off" }, integration: { server_compaction: "settings", server_compaction_key: "fixtureServerCompaction" } } }), /native Pi compaction only/);
});
