import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { durablePool } from "../src/durable/pool.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workerInstructions, validateWorkerSkills } from "../src/durable/resources.ts";
import type { StageSpec } from "../src/durable/contract.ts";

test("worker instructions discover ordinary Pi package skills at the target", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-worker-resources-")));
  const packageRoot = path.join(root, "package"), target = path.join(root, "target");
  const prior = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    fs.mkdirSync(path.join(packageRoot, "skills", "worker-only"), { recursive: true });
    fs.mkdirSync(path.join(target, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-package", version: "1.0.0", pi: { skills: ["skills"] } }));
    fs.writeFileSync(path.join(packageRoot, "skills", "worker-only", "SKILL.md"), "---\nname: worker-only\ndescription: Target-only fixture skill.\n---\nWORKER_SKILL_CANARY\n");
    fs.writeFileSync(path.join(target, ".pi", "settings.json"), JSON.stringify({ packages: [packageRoot] }));
    fs.writeFileSync(path.join(target, "AGENTS.md"), "TARGET_INSTRUCTION_CANARY\n");
    const spec = { skills: ["worker-only"] } as StageSpec;
    await validateWorkerSkills(target, spec);
    const instructions = await workerInstructions(target, spec);
    assert.match(instructions, /WORKER_SKILL_CANARY/); assert.match(instructions, /TARGET_INSTRUCTION_CANARY/);
    assert.ok(instructions.includes(path.join(packageRoot, "skills", "worker-only", "SKILL.md")));
    await assert.rejects(validateWorkerSkills(target, { skills: ["missing"] } as StageSpec), /Unavailable worker skill/);
  } finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reacquiring Durable slots does not exhaust a long-lived worker's native session launch counter", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pd-long-lived-pool-"));
  const workspace = { host: os.hostname(), cwd: fs.realpathSync(root), identity: randomUUID() };
  const resources = durablePool(workspace, { capacity: 1, max_launches_per_session: 1 }, root);
  try {
    for (const id of [1, 2, 1, 3]) { await resources.acquire(id, BACKGROUND_CONTEXT); resources.release(id); }
  } finally { resources.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
