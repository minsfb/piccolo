import assert from "node:assert/strict";
import test from "node:test";
import { verifyFirstRead, verifyFirstReadBatch } from "./fixtures/pipeline-read-gate.ts";

test("restart crash gate requires the first tool and exact implementer candidate identity", () => {
  const expected = { cwd: "/fixture/.worktrees/restart", path: "/fixture/.worktrees/restart/crash-canary.txt" };
  const stage = { cwd: expected.cwd, name: "implement" };
  assert.deepEqual(verifyFirstRead(expected, stage, "read", { path: "crash-canary.txt" }), {
    firstTool: "read", canaryPath: expected.path, stageCwd: expected.cwd,
  });
  for (const [identity, tool, args] of [
    [stage, "bash", { command: "true" }], [stage, "read", { path: "/fixture/crash-canary.txt" }],
    [{ ...stage, cwd: "/other" }, "read", { path: expected.path }],
    [{ ...stage, name: "review" }, "read", { path: expected.path }],
  ] as const) assert.throws(() => verifyFirstRead(expected, identity, tool, args), /first implementer tool/);
});

test("first-read qualification refuses rejected earlier attempts and parallel business tools", () => {
  const expected = { cwd: "/fixture/candidate", path: "/fixture/candidate/crash-canary.txt" }, stage = { cwd: expected.cwd, name: "implement" };
  const read = { name: "read", arguments: { path: "crash-canary.txt" } };
  assert.equal(verifyFirstReadBatch(expected, stage, "read", read.arguments, [read]).firstTool, "read");
  for (const calls of [[], [{ name: "write", arguments: {} }, read], [read, { name: "write", arguments: {} }], [{ name: "read", arguments: { path: "/other/crash-canary.txt" } }]])
    assert.throws(() => verifyFirstReadBatch(expected, stage, "read", read.arguments, calls));
});
