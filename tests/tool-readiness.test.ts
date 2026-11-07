import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { toolReadiness } from "../src/tool-readiness.ts";
test("missing stock search tools surface fallback guidance without installation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-tools-"));
  try {
    const missing = toolReadiness(["read", "grep", "find"], root, root);
    assert.equal(missing.tools.every(t => !t.available), true); assert.match(missing.message!, /do not repeat/);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.deepEqual(toolReadiness(["read"], root, root).tools, []);
    fs.writeFileSync(path.join(root, "fdfind"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    assert.equal(toolReadiness(["find"], root, root).tools[0].available, true);
  } finally { fs.rmSync(root, { recursive: true }); }
});
