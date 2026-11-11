import type { Context } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type EntryId, type Tx, type ToolRegistration } from "@earendil-works/pi-durable";

const unknownEffect = "piccolo.unknown-effect";
export const EffectProjection = defineDoc<{ checkedThrough: EntryId | null; marker: EntryId | null; uncertain: boolean }>({
  kind: "piccolo.effect-projection", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ checkedThrough: null, marker: null, uncertain: false }),
});

function isUnknown(error: unknown) {
  const seen = new Set<object>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    if ("code" in error && error.code === "unknown") return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}

/** Compaction may hide receipts from model context, but cannot settle their effects. */
export async function hasUncertainEffects(session: { commit(read: (tx: Tx) => Promise<undefined>, context: Context): Promise<unknown> }, conversationId: ConversationId, context: Context) {
  let uncertain = false;
  await session.commit(async tx => {
    const projection = await tx.doc(EffectProjection, conversationId);
    const marker = (await tx.latestHeadMarker(conversationId))?.id ?? null;
    // A changed context boundary or fork must never trust another history's cursor.
    if (projection.marker !== marker) { projection.checkedThrough = null; projection.uncertain = false; projection.marker = marker; }
    if (projection.uncertain) { uncertain = true; return undefined; }
    const minimum = projection.checkedThrough;
    let cursor;
    do {
      const page = await tx.scanEntries({ conversationId, order: "ascending", ...(minimum !== null ? { minEntryId: minimum } : {}) }, 1000, cursor);
      uncertain = page.items.some(entry => entry.kind === "pi.tool-result" &&
        (entry.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics?.some(
          // Upstream's aborted receipt does not say whether execution began or
          // whether the tool was replay-safe. Conservatively require reconciliation.
          diagnostic => diagnostic.code === "interrupted" || diagnostic.code === "aborted" || diagnostic.code === unknownEffect));
      if (page.items.length) projection.checkedThrough = page.items.at(-1)!.id;
      if (uncertain) { projection.uncertain = true; break; }
      cursor = page.next;
    } while (cursor);
    return undefined;
  }, context);
  return uncertain;
}

/** Preserve transport uncertainty before native hooks or Durable stringify the error. */
export function preserveEffectUncertainty(tool: ToolRegistration): ToolRegistration {
  if (tool.replay === "safe") return tool;
  return { ...tool, async execute(args, api, context) {
    try { return await tool.execute(args, api, context); }
    catch (error) {
      if (isUnknown(error))
        api.diagnostic({ severity: "error", code: unknownEffect, message: "Tool effect is unknown; parent reconciliation is required before continuing." });
      throw error;
    }
  } };
}
