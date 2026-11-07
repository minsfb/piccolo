import type { Context } from "@earendil-works/chord/context";

export class WorkerWaitCancelled extends Error {
  constructor() { super("Worker wait cancelled; the submitted operation remains active"); }
}
/** Cancel only this waiter. The operation keeps its original context, so a stop
 * deadline cannot withdraw an abort mark already queued on the mutation line.
 */
export function waitWithContext<T>(operation: Promise<T>, context: Context): Promise<T> {
  const signal = context.abortSignal;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(new WorkerWaitCancelled()); };
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}
