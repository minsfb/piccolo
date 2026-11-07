import { z } from "zod";
import { DEFAULT_COMPACTION_POLICY, type CompactionPolicy } from "@earendil-works/pi-durable";

export const compactionSchema = z.strictObject({ enabled: z.boolean(), reserveTokens: z.number().int().min(1),
  keepRecentTokens: z.number().int().min(1), backgroundTokens: z.number().int().min(0) });

/** One immutable policy per worker: Durable 1.3 has no per-conversation setting. */
export function nativeCompaction(settings: Record<string, unknown>): CompactionPolicy {
  const native = z.object({ enabled: z.boolean().optional(), reserveTokens: z.number().int().min(1).optional(),
    keepRecentTokens: z.number().int().min(1).optional() }).parse(settings.compaction ?? {});
  return compactionSchema.parse({ ...DEFAULT_COMPACTION_POLICY, backgroundTokens: 0, ...native });
}
