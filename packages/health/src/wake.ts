/** Optional, explicitly installed Pi 0.85.1 compatibility bridge. No private
 * runtime lookup, editor manipulation, or unsafe sendMessage fallback. */
export const WAKE_BRIDGE = Symbol.for("pi.harness.health.wake.v1");
export type WakeRequest = { sessionId: string; id: string; content: string };
export type WakeReceipt = { id: string; status: "accepted" | "busy" | "stale" | "duplicate" | "unsupported" | "invalid" };
let managed: { status: string; supports(context: unknown): boolean; request(context: unknown, request: WakeRequest): WakeReceipt } | undefined;
/** The package calls this only after explicit compatibility opt-in. */
export function registerManagedWake(adapter: typeof managed): void { managed = adapter?.status === "installed" ? adapter : undefined; }
export function hasParentWake(context: unknown, allowManaged = true): boolean {
  try { return typeof (context as any)?.[WAKE_BRIDGE] === "function" || (allowManaged && managed?.supports(context) === true); }
  catch { return false; }
}
export function requestParentWake(context: unknown, request: WakeRequest, allowManaged = true): WakeReceipt {
  try {
    const bridge = (context as any)?.[WAKE_BRIDGE];
    if (typeof bridge !== "function") return (allowManaged ? managed?.request(context, request) : undefined) ?? { id: request.id, status: "unsupported" };
    return bridge(request);
  } catch { return { id: request.id, status: "stale" }; }
}
