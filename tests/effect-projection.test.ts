import test from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry, type EntryId, type Tx } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { hasUncertainEffects } from "../src/durable/effects.ts";

// #38 A-13: stable history is not rescanned, but compaction never erases uncertainty.
test("effect projection scans only appended history and revalidates changed heads", async () => {
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: createModels(), env: () => undefined }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT); let first!: EntryId, visited = 0;
  const counted = { commit(read: (tx: Tx) => Promise<undefined>, context: Context) {
    return harness.commit(async tx => {
      const scan = tx.scanEntries.bind(tx);
      tx.scanEntries = async (...args) => { const page = await scan(...args); visited += page.items.length; return page; };
      return read(tx);
    }, context);
  } };
  try {
    await harness.commit(async tx => {
      for (let i = 0; i < 2005; i++) { const entry = await tx.appendEntry(root.id, { kind: "fixture", data: { i } }); if (!i) first = entry.id; }
    }, BACKGROUND_CONTEXT);
    assert.equal(await hasUncertainEffects(counted, root.id, BACKGROUND_CONTEXT), false); assert.equal(visited, 2005);
    visited = 0;
    assert.equal(await hasUncertainEffects(counted, root.id, BACKGROUND_CONTEXT), false); assert.equal(visited, 1);
    await harness.commit(tx => tx.appendEntry(root.id, { kind: "pi.tool-result", data: { diagnostics: [{ code: "interrupted" }] } }), BACKGROUND_CONTEXT);
    visited = 0; assert.equal(await hasUncertainEffects(counted, root.id, BACKGROUND_CONTEXT), true); assert.equal(visited, 2);
    visited = 0; assert.equal(await hasUncertainEffects(counted, root.id, BACKGROUND_CONTEXT), true); assert.equal(visited, 0);
    await harness.commit(tx => tx.appendEntry(root.id, { kind: "pi.compaction", head: first }), BACKGROUND_CONTEXT);
    assert.equal(await hasUncertainEffects(counted, root.id, BACKGROUND_CONTEXT), true); assert.ok(visited > 2000);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});

// #38 A-13: a fork computes its own history rather than copying a parent cursor.
test("effect projection respects the exact history inherited by a fork", async () => {
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: createModels(), env: () => undefined }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT);
  try {
    const safe = await harness.commit(tx => tx.appendEntry(root.id, { kind: "fixture", data: {} }), BACKGROUND_CONTEXT);
    const unsafe = await harness.commit(tx => tx.appendEntry(root.id, { kind: "pi.tool-result", data: { diagnostics: [{ code: "piccolo.unknown-effect" }] } }), BACKGROUND_CONTEXT);
    assert.equal(await hasUncertainEffects(harness, root.id, BACKGROUND_CONTEXT), true);
    const before = await harness.commit(tx => tx.forkConversation(root.id, safe.id, { ownership: { kind: "ownerless" } }), BACKGROUND_CONTEXT);
    const after = await harness.commit(tx => tx.forkConversation(root.id, unsafe.id, { ownership: { kind: "ownerless" } }), BACKGROUND_CONTEXT);
    assert.equal(await hasUncertainEffects(harness, before.id, BACKGROUND_CONTEXT), false);
    assert.equal(await hasUncertainEffects(harness, after.id, BACKGROUND_CONTEXT), true);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
