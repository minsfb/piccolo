import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
/** Probe only stock search executables; no download, installation or PATH edits. */
export function toolReadiness(active: string[], agentDirectory: string, searchPath = process.env.PATH ?? "") {
  const needed = [{ tool: "grep", binary: "rg", aliases: ["rg"] }, { tool: "find", binary: "fd", aliases: ["fd", "fdfind"] }].filter(v => active.includes(v.tool));
  const tools = needed.map(item => {
    const paths = [path.join(agentDirectory, "bin", item.binary), ...searchPath.split(path.delimiter).filter(Boolean).flatMap(dir => item.aliases.map(alias => path.join(dir, alias)))];
    const executable = paths.find(file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
    const probe = executable ? spawnSync(executable, ["--version"], { timeout: 2000, maxBuffer: 4096, stdio: "pipe" }) : undefined;
    return { tool: item.tool, binary: item.binary, available: !!probe && !probe.error && probe.status === 0 };
  });
  const missing = tools.filter(v => !v.available).map(v => v.binary);
  return { tools, message: missing.length ? `Stock search executable readiness: ${missing.join(", ")} unavailable. Configured provider tools may supply their own implementation. If a search tool reports unavailable, use focused project-approved reads or available bash/Python fallbacks; do not repeat failing searches or install machine tooling. Respect project-specific search restrictions.` : undefined };
}
