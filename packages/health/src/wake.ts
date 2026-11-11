/** Optional, explicitly installed Pi 0.85.1 compatibility bridge. No private
 * runtime lookup, editor manipulation, or unsafe sendMessage fallback. */
export const WAKE_BRIDGE = Symbol.for("pi.harness.health.wake.v1");
export type WakeRequest = { sessionId: string; id: string; content: string };
export type WakeReceipt = { id: string; status: "accepted" | "busy" | "stale" | "duplicate" | "unsupported" | "invalid" };
let managed: { status: string; supports(context: unknown): boolean; request(context: unknown, request: WakeRequest): WakeReceipt } | undefined;
/** The package calls this only after explicit compatibility opt-in. */
export function registerManagedWake(adapter: typeof managed): void { managed = adapter?.status === "installed" ? adapter : undefined; }
type NativeAdmission = { version: 1; contract: "pi.completion-admission/v1"; enqueue(request: { id: string; message: { customType: string; content: string; display: boolean } }): { version: 1; id: string; status: "accepted" | "queued" | "busy" | "stale" } };
function nativeAdmission(context: unknown): NativeAdmission | undefined {
  const value = (context as { turnAdmission?: NativeAdmission })?.turnAdmission;
  return value?.version === 1 && value.contract === "pi.completion-admission/v1" && typeof value.enqueue === "function" ? value : undefined;
}
export function hasParentWake(context: unknown, allowManaged = true, allowNative = false): boolean {
  try { return (allowNative && !!nativeAdmission(context)) || typeof (context as any)?.[WAKE_BRIDGE] === "function" || (allowManaged && managed?.supports(context) === true); }
  catch { return false; }
}
export function requestParentWake(context: unknown, request: WakeRequest, allowManaged = true, allowNative = false): WakeReceipt {
  try {
    const native = allowNative ? nativeAdmission(context) : undefined;
    if (native) {
      if ((context as any)?.sessionManager?.getSessionId() !== request.sessionId) return { id: request.id, status: "stale" };
      const receipt = native.enqueue({ id: request.id, message: { customType: "harness-health-status", content: request.content, display: true } });
      if (receipt.version !== 1 || receipt.id !== request.id || !["accepted", "queued", "busy", "stale"].includes(receipt.status)) return { id: request.id, status: "invalid" };
      return { id: request.id, status: receipt.status === "queued" ? "accepted" : receipt.status };
    }
    const bridge = (context as any)?.[WAKE_BRIDGE];
    if (typeof bridge !== "function") return (allowManaged ? managed?.request(context, request) : undefined) ?? { id: request.id, status: "unsupported" };
    return bridge(request);
  } catch { return { id: request.id, status: "stale" }; }
}
