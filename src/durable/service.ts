import { assessTrial } from "./assessment.ts";
import fs from "node:fs";
import http from "node:http";
import { digest } from "../config.ts";
import { workerRequestSchema, type Workspace } from "./contract.ts";
import type { DurableWorker } from "./worker.ts";
import { exportRoadmap } from "./roadmap-export.ts";
import { git } from "../workflow.ts";
import { owningRepository } from "../worktree-placement.ts";

/** Private Unix-socket protocol; the external transport carries requests to the owning host. */
export async function serveWorker(worker: DurableWorker, workspace: Workspace, socket: string, closed: () => Promise<void>) {
  // Call only after obtaining the store's exclusive owner lock. A dead owner's socket is then stale.
  if (fs.existsSync(socket)) { if (!fs.lstatSync(socket).isSocket()) throw new Error("Worker socket path is occupied"); fs.unlinkSync(socket); }
  let closing = false;
  const server = http.createServer(async (request, response) => {
    let submittedId: string | undefined;
    try {
      if (request.method !== "POST" || request.url !== "/v1") throw new Error("Expected POST /v1");
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error("Worker request exceeds 8 MiB"); chunks.push(chunk); }
      const value = workerRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (closing) throw new Error("Worker is closing");
      if (digest(value.workspace) !== digest(workspace)) throw new Error("Worker workspace identity mismatch");
      submittedId = value.operation === "submit" ? value.submission.requestId : "requestId" in value ? value.requestId : undefined;
      let result: unknown;
      switch (value.operation) {
        case "info": {
          let head: string | null = null;
          let worktreeOwner: string | null = null;
          try { head = git(workspace.cwd, "rev-parse", "HEAD"); } catch { /* Delegates may use a workspace without Git. */ }
          try { worktreeOwner = owningRepository(workspace.cwd); } catch { /* Unusual layouts need an explicit worktree destination. */ }
          result = { version: 1, registry: "piccolo-1", workspace, head, worktreeOwner, pid: process.pid, protocol: { watch: true }, capabilities: worker.capabilities(), runtime: "pi-durable/1.3.0", env: "pi-env/1.3.0" }; break;
        }
        case "submit": submittedId = value.submission.requestId; const admission = await worker.submit(value.submission); result = { taskId: admission.taskId, fingerprint: admission.fingerprint }; break;
        case "assess": result = await assessTrial(worker, value.requestId, value.assessment); break;
        case "export_schedule": result = await exportRoadmap(worker, value.requestId); break;
        case "inspect": result = await worker.status(value.requestId); break;
        case "message": result = await worker.message(value.requestId, value.messageId, value.text, value.target); break;
        case "abort": result = await worker.abort(value.requestId); break;
        case "watch": {
          let changed = false, wake: (() => void) | undefined;
          const unsubscribe = worker.harness.subscribeCommits(() => { changed = true; wake?.(); });
          try {
            const initial = await worker.status(value.requestId);
            if (digest(initial) === value.revision && value.timeoutMs && !changed && !response.destroyed) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              await new Promise<void>(resolve => {
                const done = () => { clearTimeout(timer); response.off("close", done); resolve(); };
                wake = done;
                response.once("close", done);
                timer = setTimeout(done, value.timeoutMs);
              });
            }
          } finally { unsubscribe(); }
          const snapshot = await worker.status(value.requestId);
          result = { revision: digest(snapshot), snapshot }; break;
        }
        case "close": closing = true; await worker.close(value.mode, value.owner); result = { closed: true }; break;
      }
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ result }));
      if (closing) server.close(() => { void closed(); });
    } catch (error) {
      let admission: Awaited<ReturnType<typeof worker.rejection>>;
      try { if (submittedId) admission = await worker.rejection(submittedId); } catch { /* Failed storage cannot prove non-admission. */ }
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error), ...(admission ? { admission } : {}) }));
      if (closing) server.close(() => { void closed(); });
    }
  });
  server.requestTimeout = 35000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { fs.chmodSync(socket, 0o600); resolve(); }); });
  return server;
}
