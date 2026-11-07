import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DurableWorker } from "../../src/durable/worker.ts";
import durableWorkerExtension from "../../integrations/durable-worker.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Owned qualification only: pause one safe read before business effects and
 * expose bounded phase metadata. Never installed in a normal Piccolo worker. */
export default function pipelineControl(pi: ExtensionAPI) {
  const root = process.env.PICCOLO_PIPELINE_FIXTURE_ROOT;
  if (!root || fs.realpathSync(root) !== root) throw new Error("Explicit canonical pipeline fixture required");
  const directory = path.join(root, ".cache", "qualification");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const original = DurableWorker.open.bind(DurableWorker);
  DurableWorker.open = async options => {
    if (options.workspace.cwd !== root) throw new Error("Qualification workspace mismatch");
    const tools = options.tools?.map(tool => tool.name !== "read" ? tool : { ...tool, execute: async (args: any, api: any, context: any) => {
      const marker = path.join(directory, "paused-read.json");
      if (path.basename(args.path) === "crash-canary.txt" && fs.existsSync(path.join(directory, "enable-crash-read")) && !fs.existsSync(marker)) {
        fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, taskId: api.taskId }), { flag: "wx", mode: 0o600 });
        await new Promise<void>((_resolve, reject) => context.abortSignal.addEventListener("abort", () => reject(new Error("Owned safe-read gate interrupted")), { once: true }));
      }
      return tool.execute(args, api, context);
    } });
    const worker = await original({ ...options, tools });
    const socket = path.join(directory, "control.sock");
    if (fs.existsSync(socket)) fs.unlinkSync(socket);
    const server = http.createServer(async (_req, res) => {
      try {
        const graph = await worker.harness.inspect(BACKGROUND_CONTEXT);
        const tasks = graph.tasks.slice(0, 1000).map(({ record }: any) => ({ id: record.id, kind: record.kind, owner: record.owner,
          state: record.state.status, phase: record.state.checkpoint?.phase, name: record.input?.spec?.name,
          terminalStatus: record.state.outcome?.status, errorName: record.state.outcome?.error?.name }));
        res.end(JSON.stringify({ result: { tasks, total: graph.tasks.length } }));
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error instanceof Error ? error.name : "Error" })); }
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { fs.chmodSync(socket, 0o600); resolve(); }); });
    const close = worker.close.bind(worker);
    worker.close = async (...args) => { try { return await close(...args); } finally { server.close(); if (fs.existsSync(socket)) fs.unlinkSync(socket); } };
    return worker;
  };
  // One extension module graph guarantees the fault hook and production entry
  // point share the same Worker class under the managed loader.
  durableWorkerExtension(pi);
}
