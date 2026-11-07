import { digest } from "../config.ts";
import type { TaskOutcome } from "@earendil-works/pi-durable";

/** The same revision identifies an outcome in live Jobs and suspended discovery. */
export function outcomeProjection(outcome?: TaskOutcome<any>, connectionError?: string, cancellationError?: string) {
  const result = outcome && "result" in outcome ? outcome.result : undefined;
  const originalError = outcome && "error" in outcome ? outcome.error?.message : connectionError;
  const error = cancellationError ? [originalError, `Cancellation unconfirmed: ${cancellationError}`].filter(Boolean).join("; ") : originalError;
  const state = cancellationError || result?.status === "unresolved" || (!outcome && connectionError) ? "unresolved" : !outcome ? "running" :
    outcome.status === "aborted" || result?.status === "interrupted" ? "cancelled" :
    outcome.status === "completed" && result?.status === "complete" ? "completed" : "needs_parent";
  return { state, result, error, revision: outcome ? digest({ state, result, error }) : undefined } as const;
}
