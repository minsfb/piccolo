import { defineTask, defineDoc, type TaskRecord, type TaskRuntime } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { WorkerSubmission } from "./contract.ts";
import { dispatchRemote, workerRequest, RemoteRejected, cacheDispatchState, type RemoteWorker } from "./remote.ts";
import fs from "node:fs";
import path from "node:path";
import { digest } from "../config.ts";

type Input = { root: string; target: RemoteWorker; submission: WorkerSubmission; observe?: boolean; cancel?: boolean; verifiedOutcome?: any; priorFailure?: string };
type State = { phase: "adopt" } | { phase: "cancel"; attempts: number; mayBeAdmitted?: boolean } | { phase: "dispatch"; attempts: number; mayBeAdmitted?: boolean; error?: string } | { phase: "watch"; attempts: number; mayBeAdmitted?: boolean; unresolvedSince?: number; poll?: number; snapshot?: any; error?: string; admissionError?: string };
export const RemoteSnapshots = defineDoc<{ requests: Record<string, any> }>({ kind: "piccolo.remote-snapshots", version: 1, scope: "session", initial: () => ({ requests: {} }) });

/** The request ID is committed in task input before the first network operation. No host failover. */
export const RemoteTask = defineTask<Input, State, any, {}>({
  name: "piccolo.remote", version: 1, initial: input => input.verifiedOutcome ? ({ phase: "adopt" }) : ({ phase: input.cancel ? "cancel" : input.observe ? "watch" : "dispatch", attempts: 0, mayBeAdmitted: !!input.observe }),
  phases: {
    async adopt(task, api, ctx) { await api.commit(() => ({ status: "terminal", outcome: task.input.verifiedOutcome }), ctx); },
    async cancel(task, api, ctx) { await cancelRemote(task, api, ctx); },
    async dispatch(task, api, ctx) {
      // A retained intent from an earlier process is not proof that submission
      // never reached the worker, even if its retry counter is still zero.
      let mayBeAdmitted = task.state.checkpoint.mayBeAdmitted ?? fs.existsSync(path.join(task.input.root, ".cache", "piccolo", "dispatch", `${task.input.submission.requestId}.json`));
      try {
        await dispatchRemote(task.input.root, task.input.target, task.input.submission, ctx.abortSignal, async () => {
          mayBeAdmitted = true;
          await api.commit(() => ({ status: "running", checkpoint: { ...task.state.checkpoint, mayBeAdmitted: true } }), ctx);
        });
        await api.commit(() => ({ status: "running", checkpoint: { phase: "watch", attempts: 0, mayBeAdmitted: true } }), ctx);
      } catch (error) {
        if (ctx.abortSignal?.aborted) throw error;
        if (error instanceof RemoteRejected) {
          const rejection = error.admission;
          if (rejection?.state === "rejected" && rejection.requestId === task.input.submission.requestId && rejection.fingerprint === digest(task.input.submission)) {
            try { cacheDispatchState(task.input.root, task.input.target, task.input.submission.requestId, "rejected", rejection); } catch { /* Advisory cache must not change admission semantics. */ }
            await api.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: error.message }, result: { status: "rejected", admission: rejection } } }), ctx); return;
          }
          if (mayBeAdmitted) {
            await api.commit(() => ({ status: "running", checkpoint: { phase: "watch", attempts: 0, mayBeAdmitted: true,
              error: `Remote admission is uncertain; inspecting the original worker. ${String(error).slice(0, 800)}`, admissionError: String(error).slice(0, 800) } }), ctx);
            return;
          }
          await api.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: error.message }, result: { status: "rejected", source: "preflight" } } }), ctx);
          return;
        }
        await api.sleep(api.now() + Math.min(30000, 1000 * (task.state.checkpoint.attempts + 1)), ctx);
        // A lost reply may follow successful admission. The original ID makes resubmission idempotent.
        await api.commit(() => ({ status: "running", checkpoint: { phase: "dispatch", attempts: task.state.checkpoint.attempts + 1, mayBeAdmitted, error: String(error).slice(0, 1000) } }), ctx);
      }
    },
    async watch(task, api, ctx) {
      try {
        const info = await workerRequest(task.input.target, { operation: "info" }, ctx.abortSignal);
        let snapshot = await workerRequest(task.input.target, { operation: "inspect", requestId: task.input.submission.requestId }, ctx.abortSignal);
        for (;;) {
        if (snapshot.task && snapshot.fingerprint !== digest(task.input.submission)) throw new Error("Remote observation fingerprint mismatch");
        if (!snapshot.task && task.state.checkpoint.unresolvedSince === undefined) {
          await api.commit(() => ({ status: "running", checkpoint: { ...task.state.checkpoint, unresolvedSince: api.now() } }), ctx); return;
        }
        if (!snapshot.task && api.now() - task.state.checkpoint.unresolvedSince! >= 300000) {
          await api.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: "Original worker has no confirmed task after bounded observation" }, result: {
            status: "unresolved", requestId: task.input.submission.requestId, workspace: task.input.target.workspace,
            summary: "Retain the original assignment and reconcile. Missing status is not proof of non-admission.",
          } } }), ctx); return;
        }
        const previous = (await api.snapshot(RemoteSnapshots, ctx))?.requests[task.input.submission.requestId];
        if (previous === undefined || digest(previous) !== digest(snapshot))
        await api.commit(async tx => {
          const doc = await tx.doc(RemoteSnapshots);
          if (JSON.stringify(doc.requests[task.input.submission.requestId]) !== JSON.stringify(snapshot)) doc.requests[task.input.submission.requestId] = snapshot;
          return undefined;
        }, ctx);
        const outcome = snapshot.task?.state?.status === "terminal" ? snapshot.task.state.outcome : undefined;
        if (outcome) {
          try { cacheDispatchState(task.input.root, task.input.target, task.input.submission.requestId, "terminal", outcome); } catch { /* Privacy/metadata failures do not erase a verified outcome. */ }
          await api.commit(() => ({ status: "terminal", outcome }), ctx);
          return;
        }
        if (snapshot.task && (task.state.checkpoint.attempts || task.state.checkpoint.error || task.state.checkpoint.unresolvedSince !== undefined)) {
          await api.commit(() => ({ status: "running", checkpoint: { phase: "watch", attempts: 0, mayBeAdmitted: true } }), ctx); return;
        }
        if (info.protocol?.watch === true) {
          const watched = await workerRequest(task.input.target, { operation: "watch", requestId: task.input.submission.requestId, revision: digest(snapshot), timeoutMs: 30000 }, ctx.abortSignal);
          if (watched.revision !== digest(watched.snapshot)) throw new Error("Remote watch revision does not identify its snapshot");
          snapshot = watched.snapshot;
        } else {
          await api.sleep(api.now() + 1000, ctx);
          snapshot = await workerRequest(task.input.target, { operation: "inspect", requestId: task.input.submission.requestId }, ctx.abortSignal);
        }
        }
      } catch (error) {
        if (ctx.abortSignal?.aborted) throw error;
        if (task.state.checkpoint.attempts >= 12) {
          await api.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: String(error).slice(0, 1000) }, result: {
            status: "unresolved", requestId: task.input.submission.requestId, workspace: task.input.target.workspace,
            summary: "Remote observation remains unconfirmed. Reconnect to the original worker; this is not proof of non-admission.",
          } } }), ctx);
          return;
        }
        await api.sleep(api.now() + Math.min(30000, 1000 * (task.state.checkpoint.attempts + 1)), ctx);
        await api.commit(() => ({ status: "running", checkpoint: { ...task.state.checkpoint, attempts: task.state.checkpoint.attempts + 1,
          error: [task.state.checkpoint.admissionError, String(error)].filter(Boolean).join("; ").slice(0, 1000) } }), ctx);
      }
    },
  },
  async abort(task, api, ctx) { await cancelRemote(task, api, ctx); },
});

// The persisted input selects this phase before scheduling. A repaired terminal
// observer therefore cannot resume observation or dispatch while cancellation is pending.
async function cancelRemote(task: TaskRecord<Input, State, any>, api: TaskRuntime<Input, State, any, {}>, ctx: Context) {
  if (task.input.verifiedOutcome) {
    await api.commit(() => ({ status: "terminal", outcome: task.input.verifiedOutcome }), ctx); return;
  }
  try {
    const receipt = await workerRequest(task.input.target, { operation: "abort", requestId: task.input.submission.requestId }, ctx.abortSignal);
    if (receipt.state?.status !== "terminal") throw new Error("Remote worker did not confirm terminal cancellation");
    try { cacheDispatchState(task.input.root, task.input.target, task.input.submission.requestId, "terminal", receipt.state.outcome); } catch { /* Advisory cache only. */ }
    await api.commit(async tx => {
      const snapshots = await tx.doc(RemoteSnapshots), id = task.input.submission.requestId, previous = snapshots.requests[id];
      snapshots.requests[id] = { ...previous, fingerprint: digest(task.input.submission), taskId: receipt.id,
        task: { id: receipt.id, kind: receipt.kind, state: receipt.state },
        children: previous?.children ?? [], messages: previous?.messages ?? [], attention: [] };
      return { status: "terminal", outcome: receipt.state.outcome };
    }, ctx);
  } catch (error) {
    if (ctx.abortSignal?.aborted) throw error;
    if (error instanceof RemoteRejected && error.admission?.state === "rejected" && error.admission.requestId === task.input.submission.requestId && error.admission.fingerprint === digest(task.input.submission)) {
      try { cacheDispatchState(task.input.root, task.input.target, task.input.submission.requestId, "rejected", error.admission); } catch { /* Advisory only. */ }
      await api.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: error.admission!.error ?? "Original worker durably rejected this Job before admission" }, result: {
        status: "rejected", admission: error.admission!, ...(task.input.priorFailure ? { previousFailure: task.input.priorFailure } : {}),
      } } }), ctx); return;
    }
    await api.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: String(error) }, result: { status: "unresolved", requestId: task.input.submission.requestId,
      workspace: task.input.target.workspace, summary: "Remote cancellation is unconfirmed. Reconnect to the original worker and inspect this request." } } }), ctx);
  }
}
