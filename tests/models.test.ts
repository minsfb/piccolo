import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { availableModels } from "../src/models.ts";
import { validateAgentRuntime } from "../src/delegation.ts";
import { resolveLayers, resolveAgent } from "../src/config.ts";

test("provider discovery exposes native capabilities without credentials or routing", () => {
  const text = { provider: "custom", id: "text", name: "Text", input: ["text"], reasoning: false, contextWindow: 1000, apiKey: "MUST_NOT_EXPOSE", baseUrl: "MUST_NOT_EXPOSE" };
  const image = { ...text, provider: "google", id: "image", input: ["text", "image"] };
  const ctx = { model: text, modelRegistry: { getAvailable: () => [text, image] } } as unknown as ExtensionContext;
  assert.deepEqual(availableModels(ctx, { input: "image" }).models.map(m => m.model), ["google/image"]);
  assert.equal(availableModels(ctx, { provider: "custom", effort: "off" }).models.length, 1);
  assert.equal(availableModels(ctx, { effort: "xhigh" }).models.length, 0);
  assert.ok(!JSON.stringify(availableModels(ctx)).includes("MUST_NOT_EXPOSE"));
  assert.throws(() => availableModels(ctx, { effort: "invented" }));
  assert.throws(() => validateAgentRuntime({ requirements: { input: ["image"] } }, ctx), /does not support required image/);
  assert.equal(validateAgentRuntime({ model: "google/image", requirements: { input: ["image"] } }, ctx).model, "google/image");
  assert.equal(ctx.model?.provider, "custom", "discovery/preflight must not change parent selection");
});

test("portable aliases and explicit invocation override preserve capability requirements", () => {
  const resolved = resolveLayers({ source: "builtin", value: { agents: { screenshot: { requirements: { input: ["image"] } } } } },
    [{ source: "project", value: { models: { vision: { model: "new-provider/vision" } }, agents: { screenshot: { model: "alias:vision" } } } }]);
  assert.equal(resolveAgent(resolved, "screenshot").model, "new-provider/vision");
  const override = resolveAgent(resolved, "screenshot", { model: "other-provider/image" });
  assert.equal(override.model, "other-provider/image");
  assert.deepEqual(override.requirements?.input, ["image"]);
});
