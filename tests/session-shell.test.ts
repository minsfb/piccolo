import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { sessionShell, createSessionShell, parseShellReceipt } from "../src/session-shell.ts";

const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-shell-suite-"));
after(() => fs.rmSync(suiteRoot, { recursive: true, force: true }));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) { if (check()) return; await delay(50); }
  assert.fail("Condition did not become true within five seconds");
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("session shell preserves output and nonzero command status", async () => {
  let output = "";
  const result = await sessionShell.exec("echo retained; exit 7", suiteRoot, { onData: data => output += data.toString() });
  assert.equal(result.exitCode, 7); assert.match(output, /retained/);
});
test("session shell timeout and explicit abort stop their commands", async () => {
  await assert.rejects(sessionShell.exec("sleep 30", suiteRoot, { timeout: 0.1, onData() {} }), /timeout/);
  const controller = new AbortController();
  const result = sessionShell.exec("sleep 30", suiteRoot, { signal: controller.signal, onData() {} });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(result, /aborted/);
});
test("concurrent short shells drain independent completion receipts", async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => sessionShell.exec(`exit ${i}`, suiteRoot, { onData() {} })));
  assert.deepEqual(results.map(result => result.exitCode), Array.from({ length: 12 }, (_, i) => i));
});
test("abrupt owning runtime death stops ordinary shell descendants", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-shell-"));
  const receipt = path.join(root, "sleep.pid");
  const source = `import {sessionShell} from ${JSON.stringify(new URL("../src/session-shell.ts", import.meta.url).href)}; await sessionShell.exec('sleep 30 & echo $! > sleep.pid; wait', ${JSON.stringify(root)}, {onData(){}});`;
  const parent = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], { stdio: "ignore" });
  let sleeper: number | undefined;
  try {
    await until(() => fs.existsSync(receipt));
    sleeper = Number(fs.readFileSync(receipt, "utf8").trim());
    assert.ok(alive(sleeper));
    const ended = new Promise(resolve => parent.once("exit", resolve));
    parent.kill("SIGKILL"); await ended;
    await until(() => !alive(sleeper!));
  } finally {
    parent.kill("SIGKILL");
    if (sleeper && alive(sleeper)) process.kill(sleeper, "SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("receipt failures are categorical and retain per-command output evidence", async () => {
  for (const payload of ["", "{", JSON.stringify({ format: 1, id: "wrong" }), "x".repeat(4097)]) {
    const root = fs.mkdtempSync(path.join(suiteRoot, "fault-"));
    const script = path.join(root, "fault.py");
    fs.writeFileSync(script, `import json,sys\nr=json.loads(sys.stdin.readline())\nprint('retained fault output',flush=True)\nopen(r['receipt'],'w').write(${JSON.stringify(payload)})\n`);
    await assert.rejects(createSessionShell("python3", script).exec("unused", root, { onData() {} }), /receipt.*shell evidence:/);
    const directory = path.join(root, ".cache/piccolo/shell", fs.readdirSync(path.join(root, ".cache/piccolo/shell"))[0]);
    assert.match(fs.readFileSync(path.join(directory, "output.log"), "utf8"), /retained fault output/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "outcome.json"), "utf8")).status, "failed");
  }
  assert.throws(() => parseShellReceipt("", "id"), /missing receipt/);
  assert.throws(() => parseShellReceipt("{", "id"), /malformed receipt/);
});

test("forking launchers can close extra descriptors without losing shell completion", async () => {
  const root = fs.mkdtempSync(path.join(suiteRoot, "launcher-"));
  const launcher = path.join(root, "launcher");
  fs.writeFileSync(launcher, '#!/usr/bin/env python3\nimport subprocess,sys\nr=subprocess.run([sys.executable,*sys.argv[1:]],close_fds=True)\nsys.exit(0 if r.returncode < 0 else r.returncode)\n', { mode: 0o700 });
  let output = "";
  const result = await createSessionShell(launcher).exec("echo launcher-ok; exit 6", root, { onData: b => output += b.toString() });
  assert.equal(result.exitCode, 6); assert.match(output, /launcher-ok/);
  assert.equal(fs.readdirSync(path.join(root, ".cache/piccolo/shell")).length, 1);
});

test("signal termination is not normal success and timeout kills a TERM-ignoring descendant", async () => {
  const root = fs.mkdtempSync(path.join(suiteRoot, "descendant-"));
  await assert.rejects(sessionShell.exec("kill -TERM $$", root, { onData() {} }), /signal/);
  await assert.rejects(sessionShell.exec("bash -c 'trap \"\" TERM; echo $$ > owned.pid; exec sleep 30' & wait", root, { timeout: 0.3, onData() {} }), /timeout/);
  const pid = Number(fs.readFileSync(path.join(root, "owned.pid"), "utf8"));
  await until(() => !alive(pid));
});
