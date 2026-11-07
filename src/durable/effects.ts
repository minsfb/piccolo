import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Tx, ToolRegistration } from "@earendil-works/pi-durable";

const unknownEffect = "piccolo.unknown-effect";

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
    let cursor;
    do {
      const page = await tx.scanEntries({ conversationId }, 1000, cursor);
      uncertain = page.items.some(entry => entry.kind === "pi.tool-result" &&
        (entry.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics?.some(
          // Upstream's aborted receipt does not say whether execution began or
          // whether the tool was replay-safe. Conservatively require reconciliation.
          diagnostic => diagnostic.code === "interrupted" || diagnostic.code === "aborted" || diagnostic.code === unknownEffect));
      if (uncertain) break;
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
