import { defineDoc, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export const SupervisorDoc = defineDoc<{ requests: Record<string, { conversationId: number; question: string; answer: string | null }> }>({
  kind: "piccolo.supervisor", version: 1, scope: "session", initial: () => ({ requests: {} }),
});

/** A safe wait on a persisted parent decision; it never repeats an external effect. */
export const askParent = defineTool({
  name: "ask_parent", description: "Ask the owning parent for a required decision and wait. The question and reply survive worker restart.",
  replay: "safe", parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 2000 }) }),
  async execute(args, api, ctx) {
    const id = String(api.taskId);
    await api.commit(async tx => {
      const doc = await tx.doc(SupervisorDoc);
      if (Object.entries(doc.requests).some(([key, request]) => key !== id && request.conversationId === api.conversationId && request.answer === null)) throw new Error("This stage is already waiting for a parent decision");
      doc.requests[id] ??= { conversationId: api.conversationId, question: args.question, answer: null };
    }, ctx);
    const watch = await api.watchDoc(SupervisorDoc, ctx);
    if (!watch) throw new Error("Parent decision document unavailable");
    try {
      if (watch.value?.requests[id]?.answer != null) return { output: [{ type: "text", text: watch.value.requests[id].answer! }] };
      const answer = await new Promise<string>((resolve, reject) => {
        watch.start(async value => { if (value?.requests[id]?.answer != null) resolve(value.requests[id].answer!); });
        void watch.closed.then(reason => reject(new Error(`Parent decision wait ended: ${reason.reason}`)));
      });
      return { output: [{ type: "text", text: answer }] };
    } finally { await watch.stop(); }
  },
});
