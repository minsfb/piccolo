#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";

try {
  const { values } = parseArgs({ options: { source: { type: "string" }, check: { type: "boolean" } } });
  if (!values.source) throw new Error("Usage: node scripts/sync-worktree-helper.mjs --source /path/to/envy-helper.mjs [--check]");
  const source = fs.readFileSync(values.source);
  const destination = fileURLToPath(new URL("../src/vendor/git-worktree.mjs", import.meta.url));
  if (values.check) {
    if (!source.equals(fs.readFileSync(destination))) throw new Error("Vendored Git placement helper differs from its canonical source");
  } else fs.writeFileSync(destination, source);
  console.log(JSON.stringify({ identical: true, sha256: createHash("sha256").update(source).digest("hex"), file: path.relative(process.cwd(), destination) }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
