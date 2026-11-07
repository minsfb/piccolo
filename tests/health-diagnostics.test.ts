import test from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../packages/health/src/diagnostics.ts";
import { resolveHealthConfig } from "../packages/health/src/config.ts";

const settings = resolveHealthConfig([{ diagnostic: { enabled: true, model: "test/cheap" } }]).diagnostic;
async function result(text: string) {
  const ctx: any = { modelRegistry: {
    getAvailable: () => [{ provider: "test", id: "cheap" }],
    complete: async (_model: unknown, input: any, options: any) => {
      assert.equal(input.tools, undefined);
      assert.equal(options.maxTokens, settings.max_tokens);
      return { stopReason: "stop", content: [{ type: "text", text }] };
    },
  } };
  return diagnose(ctx, settings, { incidents: [] }, new AbortController().signal);
}
test("diagnostic contract accepts exact JSON and one whole-response JSON fence", async () => {
  const object = { assessment: "needs_parent", confidence: "high" };
  for (const text of [JSON.stringify(object), "```json\n" + JSON.stringify(object) + "\n```"])
    assert.deepEqual(await result(text), object);
});
test("diagnostic contract rejects commentary, extra fields and unbounded output", async () => {
  for (const text of [
    'Here is the result: {"assessment":"healthy","confidence":"high"}',
    '{"assessment":"healthy","confidence":"high","command":"restart"}',
    '```json\n{"assessment":"healthy","confidence":"high"}\n```\nRun something',
    "x".repeat(2049),
  ]) await assert.rejects(result(text));
});
