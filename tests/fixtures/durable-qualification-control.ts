import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NativePolicyDoc } from "../../src/durable/native-policy.ts";
import type { DurableWorker } from "../../src/durable/worker.ts";

/** Test-only control of an owned live fixture; never installed by the worker. */
export async function qualificationControl(worker: DurableWorker, directory: string) {
  const socket = path.join(directory, "qualification.sock");
  if (fs.existsSync(socket)) fs.unlinkSync(socket);
  const server = http.createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 16000) throw new Error("Fixture request too large"); }
      const input = JSON.parse(body);
      const task = (await worker.inspect(input.requestId)).task;
      const conversationId = (task?.state as any)?.checkpoint?.conversationId ?? (task?.state as any)?.outcome?.result?.conversationId;
      if (!conversationId) throw new Error("Fixture stage must still be active");
      const conversation = (await worker.harness.conversation(conversationId, context))!;
      let result: unknown;
      if (input.operation === "compact") {
        const id = await conversation.compact("Preserve fixture codewords and pending parent decisions.", context);
        const outcome = await worker.harness.waitForTask(id, context);
        result = { outcome: outcome.state.outcome, headKind: (await conversation.context(context)).head?.kind };
      } else if (input.operation === "policy") {
        const doc = await worker.harness.snapshot(NativePolicyDoc, conversationId, context);
        result = { identity: doc?.identity, modules: doc?.modules, pending: doc?.pending,
          notices: Object.values(doc?.messages ?? {}).map(message => ({ type: message.customType, bytes: JSON.stringify(message).length })),
          headKind: (await conversation.context(context)).head?.kind,
          receipts: Object.keys(doc?.receipts ?? {}).filter(key => key.startsWith("compaction:")) };
      } else throw new Error("Unknown fixture operation");
      res.end(JSON.stringify({ result }));
    } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { fs.chmodSync(socket, 0o600); resolve(); }); });
  return () => { server.close(); if (fs.existsSync(socket)) fs.unlinkSync(socket); };
}
