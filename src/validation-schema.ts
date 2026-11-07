import { z } from "zod";
export const checkName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/);
export const checkSpecSchema = z.strictObject({
  command: z.string().min(1).max(16000), cwd: z.string().min(1).max(2000).default("."),
  boundary: z.enum(["isolated", "integration", "live"]), scope: z.string().min(1).max(2000),
  timeout_ms: z.number().int().positive().max(86400000).default(900000), required: z.boolean().default(true),
});
export const validationSchema = z.strictObject({ mode: z.enum(["required", "reported"]).optional(), checks: z.record(checkName, checkSpecSchema.partial()).optional() });
export const checkInputSchema = checkSpecSchema.omit({ required: true }).extend({
  check: checkName, candidate: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  retry_of: z.string().uuid().optional(), retry_reason: z.string().min(1).max(2000).optional(),
}).refine(v => Boolean(v.retry_of) === Boolean(v.retry_reason), "Retry requires both a prior check ID and a reason");
