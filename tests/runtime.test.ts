import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateAgentRuntime } from "../src/delegation.ts";

test("runtime inheritance uses the current parent; explicit unsupported effort never clamps", () => {
  const model = { provider: "fixture", id: "plain", reasoning: false };
  const ctx = { model, modelRegistry: { getAvailable: () => [model] } } as unknown as ExtensionContext;
  assert.equal(validateAgentRuntime({}, ctx).model, "fixture/plain");
  assert.equal(validateAgentRuntime({ effort: "off" }, ctx).effort, "off");
  assert.throws(() => validateAgentRuntime({ effort: "xhigh" }, ctx), /Unsupported effort/);
  assert.throws(() => validateAgentRuntime({ model: "fixture/missing" }, ctx), /unavailable/);
  assert.throws(() => validateAgentRuntime({ requirements: { host: "wrong-host.invalid" } }, ctx), /not this host/);
});

test("native public exports resolve conditional JavaScript entries and reject package escapes", async () => {
  const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const { subagentsPublicExport } = await import("../src/runtime.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-exports-"));
  const native = path.join(root, ".pi/npm/node_modules/pi-subagents");
  fs.mkdirSync(native, { recursive: true });
  const write = (value: unknown) => fs.writeFileSync(path.join(native, "package.json"), JSON.stringify({ name: "pi-subagents", exports: { "./background-work": value } }));
  try {
    write({ types: "./src/api/background-work.d.ts", default: "./src/api/background-work.js" });
    assert.equal(subagentsPublicExport(root, "background-work"), path.join(native, "src/api/background-work.js"));
    write("./../foreign.js");
    assert.throws(() => subagentsPublicExport(root, "background-work"), /escapes/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
