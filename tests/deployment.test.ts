import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolveLayers, digest } from "../src/config.ts";
import { inspectConfig } from "../src/inspection.ts";
import { remoteRequest, remoteStatus, remoteWorker, transportRequest } from "../src/remote.ts";
import { navigation } from "../src/evidence.ts";

test("inspection reports effective value and provenance after profile and invocation", () => {
  const resolved = resolveLayers({ source: "builtin", value: { agents: { reviewer: { model: "alias:review" } }, models: { review: { model: "provider/model" } } } },
    [{ source: "project", value: { profiles: { fast: { agents: { reviewer: { effort: "low" } } } } } }], "fast", { agents: { reviewer: { effort: "medium" } } });
  const result = inspectConfig(resolved, "/agents/reviewer/effort") as any;
  assert.equal(result.value, "medium"); assert.equal(result.origins["/agents/reviewer/effort"], "invocation");
  assert.equal((inspectConfig(resolved, undefined, "reviewer") as any).agent.model, "provider/model");
  assert.throws(() => inspectConfig(resolved, "/agents/missing"), /No configured value/);
  assert.throws(() => inspectConfig(resolved, "/agents/~2"), /JSON Pointer/);
  const arrays = resolveLayers({ source: "builtin", value: { agents: { reviewer: { tools: ["read"] } } } });
  assert.equal((inspectConfig(arrays, "/agents/reviewer/tools/0") as any).origins["/agents/reviewer/tools"], "builtin");
});

test("remote rejects wrong host, traversal and changed identities without launching", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-remote-"));
  try {
    const request = { format: 1, action: "start", id: randomUUID(), hostname: os.hostname(), cwd, task: "synthetic" };
    assert.throws(() => remoteRequest({ ...request, hostname: "wrong-host.invalid" }), /wrong host/);
    assert.throws(() => remoteRequest({ ...request, id: "../../escape" }));
    execFileSync("git", ["init", "-q", cwd]); fs.writeFileSync(path.join(cwd, ".gitignore"), ".cache/\n");
    const job = path.join(cwd, ".piccolo/remote-jobs", request.id); fs.mkdirSync(job, { recursive: true });
    fs.writeFileSync(path.join(job, "launch.json"), JSON.stringify({ cwd, request_digest: digest(request), session: path.join(cwd, ".cache/session.jsonl") }));
    // Retrying an acknowledged or ambiguous identity must inspect, never spawn.
    assert.equal(remoteRequest(request).state, "unresolved");
    assert.throws(() => remoteRequest({ ...request, task: "different" }), /different request/);
    fs.symlinkSync(job, path.join(cwd, ".piccolo/remote-jobs", "00000000-0000-4000-8000-000000000001"));
    assert.throws(() => remoteStatus(cwd, "00000000-0000-4000-8000-000000000001"), /real directory/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("worker retains native identity and terminal evidence; rejects a duplicate worker", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-worker-"));
  const previousPath = process.env.PATH;
  try {
    const id = randomUUID();
    const job = path.join(cwd, ".piccolo/remote-jobs", id), raw = path.join(cwd, ".cache/piccolo/remote", id);
    fs.mkdirSync(job, { recursive: true }); fs.mkdirSync(raw, { recursive: true });
    const request = { format: 1, action: "start", id, hostname: os.hostname(), cwd, task: "SYNTHETIC-ONLY", model: "fixture/model", timeout_ms: 1000 };
    const session = path.join(raw, "session.jsonl");
    fs.writeFileSync(path.join(job, "launch.json"), JSON.stringify({ cwd, session, request_digest: digest(request) }));
    fs.writeFileSync(path.join(raw, "request.json"), JSON.stringify(request));
    const bin = path.join(cwd, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nconst fs=require('fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(input!=='SYNTHETIC-ONLY')process.exit(7);fs.writeFileSync(process.argv[process.argv.indexOf('--session')+1],'fixture');console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'fixture',model:'model',stopReason:'stop',content:[{type:'text',text:'OK'}]}}));});\n`, { mode: 0o700 });
    process.env.PATH = bin;
    await remoteWorker(cwd, id);
    const result = remoteStatus(cwd, id);
    assert.equal(result.state, "terminal"); assert.equal(result.outcome.status, "completed");
    assert.deepEqual(result.outcome.models, ["fixture/model"]);
    assert.equal(result.outcome.response, "OK");
    await assert.rejects(remoteWorker(cwd, id), /EEXIST/);
  } finally { process.env.PATH = previousPath; fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("transport sends JSON on stdin and navigation uses explicit installed scheme", async () => {
  const request = { format: 1 as const, action: "status" as const, id: randomUUID(), hostname: "fixture", cwd: "/fixture" };
  const result = await transportRequest([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], request);
  assert.deepEqual(result, request);
  assert.equal(navigation("/tmp/a b.png", "fixture", true, "vscode").code_url, "vscode://file/tmp/a%20b.png");
});

test("transport preserves split UTF-8 and reaps a TERM-ignoring oversized sender", async () => {
  const request = { format: 1 as const, action: "status" as const, id: randomUUID(), hostname: "fixture", cwd: "/fixture" };
  const unicode = await transportRequest([process.execPath, "-e", "process.stdout.write(Buffer.from([34,226]));setTimeout(()=>process.stdout.write(Buffer.from([130,172,34])),30)"], request);
  assert.equal(unicode, "€");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-transport-"));
  try {
    const pidFile = path.join(root, "pid");
    const code = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});process.stdout.write('x'.repeat(1100000));setInterval(()=>{},100);`;
    await assert.rejects(transportRequest([process.execPath, "-e", code], request), /too large/);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("worker timeout escalates against descendants even after its leader exits", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-timeout-"));
  const previousPath = process.env.PATH;
  let descendant: number | undefined;
  try {
    const id = randomUUID(), job = path.join(cwd, ".piccolo/remote-jobs", id), raw = path.join(cwd, ".cache/piccolo/remote", id);
    fs.mkdirSync(job, { recursive: true }); fs.mkdirSync(raw, { recursive: true });
    const request = { format: 1, action: "start", id, hostname: os.hostname(), cwd, task: "fixture", timeout_ms: 1000 };
    fs.writeFileSync(path.join(job, "launch.json"), JSON.stringify({ cwd, session: path.join(raw, "session.jsonl"), request_digest: digest(request) }));
    fs.writeFileSync(path.join(raw, "request.json"), JSON.stringify(request));
    const bin = path.join(cwd, "bin"); fs.mkdirSync(bin);
    const pidFile = path.join(cwd, "descendant.pid"), beat = path.join(cwd, "beat");
    const childCode = `const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.writeFileSync(${JSON.stringify(beat)},String(Date.now())),20);`;
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nrequire('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},100);\n`, { mode: 0o700 });
    process.env.PATH = bin;
    await remoteWorker(cwd, id);
    descendant = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(remoteStatus(cwd, id).outcome.status, "timed_out");
    const last = fs.readFileSync(beat, "utf8");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(fs.readFileSync(beat, "utf8"), last, "descendant must stop before the timeout receipt");
  } finally {
    if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
    process.env.PATH = previousPath; fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("oversized native diagnostic leaves a bounded inspectable failure receipt", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-error-"));
  const previousPath = process.env.PATH;
  try {
    const id = randomUUID(), job = path.join(cwd, ".piccolo/remote-jobs", id), raw = path.join(cwd, ".cache/piccolo/remote", id);
    fs.mkdirSync(job, { recursive: true }); fs.mkdirSync(raw, { recursive: true });
    const request = { format: 1, action: "start", id, hostname: os.hostname(), cwd, task: "fixture", timeout_ms: 1000 };
    fs.writeFileSync(path.join(job, "launch.json"), JSON.stringify({ cwd, session: path.join(raw, "session.jsonl"), request_digest: digest(request) }));
    fs.writeFileSync(path.join(raw, "request.json"), JSON.stringify(request));
    const bin = path.join(cwd, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'fixture',model:'model',stopReason:'error',errorMessage:'x'.repeat(1100000)}})+'\\n');\n`, { mode: 0o700 });
    process.env.PATH = bin;
    await remoteWorker(cwd, id);
    const result = remoteStatus(cwd, id);
    assert.equal(result.outcome.status, "failed");
    assert.match(result.outcome.error, /exceeds 1 MiB/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 10000);
    assert.ok(fs.statSync(path.join(raw, "stdout.jsonl")).size > 1048576);
  } finally { process.env.PATH = previousPath; fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("endpoint preserves a request split inside a multibyte workspace path", async () => {
  const { spawn } = await import("node:child_process");
  const { packageRoot } = await import("../src/config.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-endpoint-"));
  try {
    const cwd = path.join(root, "€"), id = randomUUID(), job = path.join(cwd, ".piccolo/remote-jobs", id);
    fs.mkdirSync(job, { recursive: true });
    fs.writeFileSync(path.join(job, "launch.json"), JSON.stringify({ cwd, session: path.join(cwd, "session.jsonl"), request_digest: "fixture" }));
    const input = Buffer.from(JSON.stringify({ format: 1, action: "status", id, hostname: os.hostname(), cwd }));
    const split = input.indexOf(Buffer.from("€")) + 1;
    const child = spawn(process.execPath, [path.join(packageRoot, "bin/remote-endpoint.mjs")]);
    let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", c => output += c);
    let error = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", c => error += c);
    const closed = new Promise(resolve => child.once("close", resolve));
    child.stdin.write(input.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 30));
    child.stdin.end(input.subarray(split));
    assert.equal(await closed, 0, error);
    assert.equal(JSON.parse(output).cwd, cwd);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("several large native model identities cannot overflow terminal status", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-model-bounds-"));
  const previousPath = process.env.PATH;
  try {
    const id = randomUUID(), job = path.join(cwd, ".piccolo/remote-jobs", id), raw = path.join(cwd, ".cache/piccolo/remote", id);
    fs.mkdirSync(job, { recursive: true }); fs.mkdirSync(raw, { recursive: true });
    const request = { format: 1, action: "start", id, hostname: os.hostname(), cwd, task: "fixture", timeout_ms: 1000 };
    fs.writeFileSync(path.join(job, "launch.json"), JSON.stringify({ cwd, session: path.join(raw, "session.jsonl"), request_digest: digest(request) }));
    fs.writeFileSync(path.join(raw, "request.json"), JSON.stringify(request));
    const bin = path.join(cwd, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nfor(let i=0;i<3;i++)process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'fixture',model:String(i)+'x'.repeat(600000),stopReason:'stop',content:[{type:'text',text:'OK'}]}})+'\\n');\n`, { mode: 0o700 });
    process.env.PATH = bin;
    await remoteWorker(cwd, id);
    const result = remoteStatus(cwd, id);
    assert.equal(result.outcome.status, "failed");
    assert.match(result.outcome.error, /identity exceeds/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 10000);
    assert.equal(result.outcome.models.length, 0);
  } finally { process.env.PATH = previousPath; fs.rmSync(cwd, { recursive: true, force: true }); }
});
