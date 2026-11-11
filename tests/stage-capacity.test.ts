import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createStageTask, stageActivity } from "../src/durable/stage.ts";

// #38 CAP-001: each capacity round releases losing waiters, never their tasks.
test("capacity queue rounds cancel and drain all losing task wait registrations", async () => {
  const queued = createStageTask(() => ({ tools: [] })).definition.phases.queued!;
  const active = new Set<number>(), cancelled: number[] = [];
  let maximum = 0;
  for (let round = 0; round < 4; round++) {
    const releases = new Map<number, () => void>(); let committed = false;
    const api = {
      waitForTask(id: number, ctx: Context) {
        active.add(id); maximum = Math.max(maximum, active.size);
        return new Promise<void>((resolve, reject) => {
          const release = () => { active.delete(id); ctx.abortSignal?.removeEventListener("abort", abort); resolve(); };
          const abort = () => { active.delete(id); cancelled.push(id); reject(new Error("Owned wait cancelled")); };
          releases.set(id, release); ctx.abortSignal?.addEventListener("abort", abort, { once: true });
        });
      },
      async commit(change: () => unknown) { assert.deepEqual(change(), { status: "running", checkpoint: { phase: "create" } }); committed = true; },
      abortTask() { throw new Error("Capacity waiting must not abort an execution"); },
    };
    // Only the queued phase's read-only checkpoint and public runtime methods are needed.
    const waiting = queued({ state: { checkpoint: { active: [1, 2, 3] } } } as never, api as never, BACKGROUND_CONTEXT);
    releases.get(1)!(); await waiting;
    assert.equal(active.size, 0); assert.equal(committed, true);
  }
  assert.equal(maximum, 3); assert.equal(cancelled.filter(id => id === 2).length, 4); assert.equal(cancelled.filter(id => id === 3).length, 4);
  assert.equal(stageActivity({ state: { status: "running", checkpoint: { phase: "create" } } }), "starting");
});
