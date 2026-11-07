import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { effortSchema } from "./config.ts";

export function availableModels(ctx: ExtensionContext, filters: { provider?: string; input?: "text" | "image"; effort?: string } = {}) {
  if (filters.effort) effortSchema.parse(filters.effort);
  const models = ctx.modelRegistry.getAvailable().map(model => ({
    model: `${model.provider}/${model.id}`, provider: model.provider, name: model.name,
    input: model.input, context_window: model.contextWindow,
    thinking_levels: getSupportedThinkingLevels(model),
  })).filter(model => (!filters.provider || model.provider === filters.provider)
    && (!filters.input || model.input?.includes(filters.input))
    && (!filters.effort || model.thinking_levels.includes(filters.effort as any)));
  return { models, source: "Active native Pi model registry; no endpoint/authentication data exposed.",
    note: "Registration and configured authentication do not prove gateway entitlement, live inference, or model quality. Explicit delegation still preflights the selected model; no fallback is applied." };
}
