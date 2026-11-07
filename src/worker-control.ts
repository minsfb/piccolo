// Process-local rendezvous shared by the host extension and its SDK child
// extensions. It grants no network endpoint or cross-process execution route.
import { randomUUID } from "node:crypto";
export type FollowUp = { id: string; text: string; state: "queued" | "delivered" | "rejected"; error?: string };
export type WorkerControl = {
  id: string; attached: boolean; closed: boolean; tools?: string[];
  sharedContext?: import("@earendil-works/pi-ai").Message[];
  phase?: "waiting" | "starting" | "active";
  send?: (message: FollowUp) => void;
  pending: FollowUp[];
  update: (event: { kind: string; [key: string]: unknown }) => void;
};
const key = Symbol.for("piccolo.worker-controls.v1");
export function workerControls(): Map<string, WorkerControl> {
  const global = globalThis as any;
  return global[key] ??= new Map<string, WorkerControl>();
}
export function createWorkerControl(update: WorkerControl["update"], tools?: string[]) {
  const control: WorkerControl = { id: randomUUID(), tools, attached: false, closed: false, pending: [], update: event => update(structuredClone(event)) };
  workerControls().set(control.id, control);
  return control;
}
export function queueWorkerMessage(control: WorkerControl, text: string): FollowUp {
  if (control.closed) throw new Error("Worker ended; follow-up cannot restart it");
  if (!text.trim() || text.length > 16000) throw new Error("Follow-up must contain 1..16000 characters");
  const message: FollowUp = { id: randomUUID(), text, state: "queued" };
  control.pending.push(message); control.update({ kind: "message_queued", message });
  if (control.send) control.send(message);
  return message;
}
export function closeWorkerControl(control: WorkerControl) {
  control.closed = true; control.send = undefined;
  let failure: unknown;
  for (const message of control.pending) if (message.state === "queued") {
    message.state = "rejected"; message.error = "Worker ended before delivery";
    try { control.update({ kind: "message_rejected", message }); } catch (error) { failure ??= error; }
  }
  workerControls().delete(control.id);
  if (failure) throw failure;
}
