import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Context, type ToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage, defineTool } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NativePolicy, NativePolicyDoc } from "../src/durable/native-policy.ts";
import { DurableWorker } from "../src/durable/worker.ts";

async function fixture(source: string, answer: (context: Context) => string | ToolCall | ToolCall[], execute = async (_args: any, _api?: any, _context?: any) => ({ output: [{ type: "text" as const, text: "original" }] })) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-policy-")));
  const extension = path.join(directory, "policy.mjs"); fs.writeFileSync(extension, source);
  const workspace = { host: os.hostname(), cwd: directory, identity: randomUUID() };
  const model: any = { id: "test", provider: "test", api: "openai-completions", name: "Test", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const models = createModels(); models.getModel = () => model;
  models.streamSimple = (_model, context) => {
    const stream = createAssistantMessageEventStream(), output = answer(context);
    const message: AssistantMessage = { role: "assistant", content: typeof output === "string" ? [{ type: "text", text: output }] : Array.isArray(output) ? output : [output], api: "openai-completions", provider: "test", model: "test", stopReason: typeof output === "string" ? "stop" : "toolUse", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); return stream;
  };
  const policy = new NativePolicy({ paths: [extension], directory, revision: "fixture-v1", registry: { find: () => model } as any, isProjectTrusted: () => false });
  const tool = defineTool({ name: "read", description: "Fixture", parameters: Type.Object({ path: Type.String() }), replay: "safe", execute });
  const worker = await DurableWorker.open({ workspace, models, tools: [tool], storage: new MemoryStorage(), env: () => undefined, policy });
  const request = () => ({ version: 1, registry: "piccolo-1", requestId: randomUUID(), workspace, lifetime: "independent", owner: "test", configDigest: "0".repeat(64), kind: "delegate", stage: { name: "test", task: "Read", model: { provider: "test", modelId: "test" }, instructions: "Base instructions", tools: ["read"], thinkingLevel: "off", report: false, timeoutMs: 10000 } });
  return { worker, policy, directory, request, async close() { await worker.close("suspend"); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test("native policy preserves hidden rules, prompt sections, context files and stage identities", async () => {
  const seen: string[] = [];
  const f = await fixture(`export default pi => {
    pi.on('before_agent_start', (event, ctx) => {
      pi.sendMessage({customType:'visible-context',content:'DISPLAYED_CONTEXT',display:true},{triggerTurn:false});
      event.systemPromptOptions.sections.policy = 'POLICY_SECTION';
      event.systemPromptOptions.contextFiles.push({path:'RULES.md',content:'CONTEXT_RULE'});
      return {message:{customType:'rules',content:'HIDDEN_RULE ' + ctx.sessionManager.getSessionFile(),display:false}};
    });
  }`, context => { const text = JSON.stringify(context); seen.push(text); assert.match(text, /POLICY_SECTION/); assert.match(text, /CONTEXT_RULE/); assert.match(text, /HIDDEN_RULE/); assert.match(text, /DISPLAYED_CONTEXT/); return "done"; });
  try {
    for (let i = 0; i < 2; i++) { const r = f.request(); await f.worker.submit(r); const result = await f.worker.wait(r.requestId); assert.equal((result.state.outcome as any).result?.status, "complete", JSON.stringify({result,context: await (await f.worker.harness.conversation((result.state.outcome as any).result?.conversationId, BACKGROUND_CONTEXT))?.context(BACKGROUND_CONTEXT)})); }
    assert.notEqual(seen[0].match(/HIDDEN_RULE ([^" ]+)/)?.[1], seen[1].match(/HIDDEN_RULE ([^" ]+)/)?.[1]);
  } finally { await f.close(); }
});

test("native policy blocks a tool without executing it or poisoning the next request", async () => {
  let effects = 0, requests = 0;
  const f = await fixture(`export default pi => pi.on('tool_call', () => ({block:true,reason:'DENIED'}));`, context => {
    if (requests++ === 0) return { type: "toolCall", id: "call", name: "read", arguments: { path: "before" } };
    assert.match(JSON.stringify(context), /DENIED/); return "blocked honestly";
  }, async () => { effects++; return { output: [] }; });
  try { const r = f.request(); await f.worker.submit(r); const result = await f.worker.wait(r.requestId); assert.equal((result.state.outcome as any).result?.status, "complete", JSON.stringify({result,context: await (await f.worker.harness.conversation((result.state.outcome as any).result?.conversationId, BACKGROUND_CONTEXT))?.context(BACKGROUND_CONTEXT)})); assert.equal(effects, 0); }
  finally { await f.close(); }
});

test("native policy persists transformed tool results", async () => {
  let requests = 0;
  const f = await fixture(`export default pi => {
    pi.on('tool_result', e => ({content:[...e.content,{type:'text',text:'POST_RULE'}]}));
  }`, context => {
    if (requests++ === 0) return { type: "toolCall", id: "call", name: "read", arguments: { path: "before" } };
    assert.match(JSON.stringify(context), /POST_RULE/); return "done";
  }, async args => { assert.equal(args.path, "before"); return { output: [{ type: "text", text: "read" }] }; });
  try {
    const r = f.request(); await f.worker.submit(r); const result = await f.worker.wait(r.requestId);
    assert.equal((result.state.outcome as any).result?.status, "complete", JSON.stringify({result,context: await (await f.worker.harness.conversation((result.state.outcome as any).result?.conversationId, BACKGROUND_CONTEXT))?.context(BACKGROUND_CONTEXT)}));
    const doc = await f.worker.harness.snapshot(NativePolicyDoc, (result.state.outcome as any).result.conversationId, BACKGROUND_CONTEXT);
    assert.equal(Object.keys(doc?.receipts ?? {}).filter(key => key.startsWith("request:")).length, 1);
    const transcript = await (await f.worker.harness.conversation((result.state.outcome as any).result.conversationId, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT);
    assert.match(JSON.stringify(transcript.messages), /POST_RULE/); assert.equal(doc?.pending, null);
  } finally { await f.close(); }
});

test("unsupported policy events prevent model execution", async () => {
  let calls = 0;
  const f = await fixture(`export default pi => pi.on('before_provider_request', () => {});`, () => { calls++; return "must not run"; });
  try { const r = f.request(); await f.worker.submit(r); const result = await f.worker.wait(r.requestId); assert.notEqual((result.state.outcome as any).result?.status, "complete"); assert.equal(calls, 0); }
  finally { await f.close(); }
});

test("native argument rewrites cannot change the recorded execution intent", async () => {
  let calls = 0, effects = 0;
  const f = await fixture(`export default pi => pi.on('tool_call', e => {e.input.path = 'different-target';});`, () => {
    calls++; return { type: "toolCall", id: "call", name: "read", arguments: { path: "original-target" } };
  }, async () => { effects++; return { output: [] }; });
  try {
    const r = f.request(); await f.worker.submit(r); const result = await f.worker.wait(r.requestId);
    assert.notEqual((result.state.outcome as any).result?.status, "complete"); assert.equal(effects, 0); assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("request receipts follow changed transcripts and pending policy effects stop recovery", async () => {
  const f = await fixture(`export default pi => pi.on('before_agent_start', e => ({message:{customType:'rules',content:'RULE_FOR:'+e.prompt,display:false}}));`, () => "done");
  try {
    const r = f.request(); await f.worker.submit(r); const result = await f.worker.wait(r.requestId);
    const conversationId = (result.state.outcome as any).result.conversationId;
    const api = { conversationId, taskId: 999 } as any;
    const first = await f.policy.beforeRequest([{ role: "user", content: "first", timestamp: 1 }], api, BACKGROUND_CONTEXT);
    const second = await f.policy.beforeRequest([{ role: "user", content: "second", timestamp: 2 }], api, BACKGROUND_CONTEXT);
    assert.match(JSON.stringify(first), /RULE_FOR:first/); assert.match(JSON.stringify(second), /RULE_FOR:second/);
    await f.worker.harness.commit(async tx => { (await tx.doc(NativePolicyDoc, conversationId)).pending = "interrupted-rule-discovery"; }, BACKGROUND_CONTEXT);
    await assert.rejects(f.policy.beforeRequest([{ role: "user", content: "third", timestamp: 3 }], api, BACKGROUND_CONTEXT), /reconciliation/);
  } finally { await f.close(); }
});

test("notification-only compaction resets run once and native metadata consumers reject", async () => {
  for (const inspectMetadata of [false, true]) {
    const f = await fixture(`import fs from 'node:fs'; export default pi => pi.on('session_before_compact', (e,ctx) => {
      ${inspectMetadata ? 'void e.preparation;' : ''}
      fs.appendFileSync(ctx.cwd+'/reset-count', 'x');
    });`, () => "done");
    try {
      const r = f.request(); await f.worker.submit(r); const result = await f.worker.wait(r.requestId);
      const api = { conversationId: (result.state.outcome as any).result.conversationId, taskId: 999 } as any;
      const compaction = { reason: "manual", entries: [], messages: [], firstKept: 1 } as any;
      if (inspectMetadata) {
        await assert.rejects(f.policy.beforeCompact(compaction, api, BACKGROUND_CONTEXT), /Native policy failed/);
        assert.equal(fs.existsSync(path.join(f.directory, "reset-count")), false);
      } else {
        await f.policy.beforeCompact(compaction, api, BACKGROUND_CONTEXT);
        await f.policy.beforeCompact(compaction, api, BACKGROUND_CONTEXT);
        assert.equal(fs.readFileSync(path.join(f.directory, "reset-count"), "utf8"), "x");
      }
    } finally { await f.close(); }
  }
});


test("parallel tool callbacks serialize without treating live hooks as interrupted", async () => {
  let requests = 0, effects = 0;
  const f = await fixture(`export default pi => pi.on('tool_call', async () => {await new Promise(r=>setTimeout(r,30));});`, () => {
    if (requests++ === 0) return ['one','two'].map(id => ({type:'toolCall' as const,id,name:'read',arguments:{path:id}}));
    return 'done';
  }, async () => { effects++; return {output:[{type:'text',text:'observed'}]}; });
  try { const r=f.request(); await f.worker.submit(r); const result=await f.worker.wait(r.requestId);
    assert.equal((result.state.outcome as any).result?.status,'complete'); assert.equal(effects,2);
  } finally { await f.close(); }
});

test("shell identity preparation waits for a parallel policy callback", { timeout: 10000 }, async () => {
  let requests = 0, prepared = false;
  const f = await fixture(`import fs from 'node:fs'; import path from 'node:path';
    export default pi => pi.on('tool_result', async (event, ctx) => {
      if (event.input.path !== 'other') return;
      fs.writeFileSync(path.join(ctx.cwd, 'callback-entered'), 'yes');
      while (!fs.existsSync(path.join(ctx.cwd, 'release-callback'))) await new Promise(r => setTimeout(r, 5));
    });`, () => {
    if (requests++ === 0) return ['shell', 'other'].map(id => ({ type: 'toolCall' as const, id, name: 'read', arguments: { path: id } }));
    return 'done';
  }, async (args, api, context) => {
    if (args.path === 'shell') {
      while (!fs.existsSync(path.join(f.directory, 'callback-entered'))) await new Promise(r => setTimeout(r, 5));
      const execution = { env: {} } as any;
      const pending = Promise.resolve(f.policy.prepareBash(execution, api, context));
      let settled = false;
      pending.then(() => { settled = true; }, () => { settled = true; });
      try { await new Promise(r => setTimeout(r, 20)); assert.equal(settled, false); }
      finally { fs.writeFileSync(path.join(f.directory, 'release-callback'), 'yes'); }
      await pending;
      assert.match(execution.env.PI_SESSION_ID, /^[0-9a-f-]{36}$/);
      prepared = true;
    }
    return { output: [{ type: 'text', text: 'observed' }] };
  });
  try {
    const r = f.request(); await f.worker.submit(r); const result = await f.worker.wait(r.requestId);
    assert.equal((result.state.outcome as any).result?.status, 'complete'); assert.equal(prepared, true);
  } finally { fs.writeFileSync(path.join(f.directory, 'release-callback'), 'yes'); await f.close(); }
});


test("a new stage rejects policy source drift before any model request", async () => {
  let calls = 0;
  const f = await fixture(`export default pi => pi.on('before_agent_start', () => undefined);`, () => { calls++; return "done"; });
  try {
    const first = f.request(); await f.worker.submit(first); await f.worker.wait(first.requestId); assert.equal(calls, 1);
    fs.writeFileSync(path.join(f.directory, "policy.mjs"), `export default pi => pi.on('before_agent_start', () => ({message:{customType:'drift',content:'NEW_POLICY',display:false}}));`);
    const next = f.request(); await f.worker.submit(next); const result = await f.worker.wait(next.requestId);
    assert.notEqual((result.state.outcome as any).result?.status, "complete");
    assert.equal(calls, 1, "Changed policy files cannot run under the stored fingerprint");
  } finally { await f.close(); }
});
