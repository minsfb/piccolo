import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { DurableWorker } from "../src/durable/worker.ts";
import { serveWorker } from "../src/durable/service.ts";
import { configSchema } from "../src/config.ts";

test("host validation rejects missing transports and half-specified Durable pairs", () => {
  const base = { hostname: "worker.example.invalid", cwd: "/workspace" };
  for (const host of [base, { ...base, worker_identity: randomUUID() }, { ...base, worker_transport: ["transport"] }, { ...base, transport: ["native"], worker_identity: randomUUID() }])
    assert.equal(configSchema.safeParse({ hosts: { worker: host } }).success, false);
  assert.equal(configSchema.safeParse({ hosts: { worker: { ...base, transport: ["native"] } } }).success, true);
  assert.equal(configSchema.safeParse({ hosts: { worker: { ...base, worker_identity: randomUUID(), worker_transport: ["transport"] } } }).success, true);
});

test("production worker rejects missing or mismatched workspace before control mutations", async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pd-protocol-")));
  const workspace = { host: os.hostname(), cwd: directory, identity: randomUUID() };
  const worker = await DurableWorker.open({ workspace, models: createModels(), storage: new MemoryStorage(), tools: [], env: () => undefined });
  const socket = path.join(directory, "worker.sock"); let releases = 0;
  const server = await serveWorker(worker, workspace, socket, async () => { releases++; });
  const send = (value: unknown) => new Promise<{ code: number; body: any }>((resolve, reject) => {
    const request = http.request({ socketPath: socket, path: "/v1", method: "POST" }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ code: response.statusCode!, body: JSON.parse(text) }));
    });
    request.on("error", reject); request.end(JSON.stringify(value));
  });
  try {
    for (const identity of [undefined, { ...workspace, identity: randomUUID() }]) {
      const result = await send({ operation: "close", mode: "suspend", owner: "fixture", ...(identity ? { workspace: identity } : {}) });
      assert.equal(result.code, 400); assert.ok(result.body.error); assert.equal(releases, 0);
    }
    const current = await send({ operation: "info", workspace });
    assert.equal(current.code, 200); assert.equal(current.body.result.protocol.watch, true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await worker.close("suspend"); fs.rmSync(directory, { recursive: true, force: true }); }
});
