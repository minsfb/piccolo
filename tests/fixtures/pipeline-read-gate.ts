import path from "node:path";

/** The crash boundary must be the first implementer tool in this candidate. */
export function verifyFirstRead(expected: { cwd: string; path: string }, stage: { cwd: string; name: string }, tool: string, args: unknown) {
  const supplied = args && typeof args === "object" && "path" in args ? (args as { path: unknown }).path : undefined;
  const canaryPath = typeof supplied === "string" ? path.resolve(stage.cwd, supplied) : undefined;
  if (stage.cwd !== expected.cwd || stage.name !== "implement" || tool !== "read" || canaryPath !== expected.path)
    throw new Error("Owned restart requires its first implementer tool to read the exact candidate canary");
  return { firstTool: "read", canaryPath, stageCwd: stage.cwd };
}

export function verifyFirstReadBatch(expected: { cwd: string; path: string }, stage: { cwd: string; name: string }, tool: string, args: unknown, calls: Array<{ name: string; arguments: unknown }>) {
  if (calls.length !== 1 || calls[0].name !== tool) throw new Error("Owned restart requires a single first tool call before its crash gate");
  verifyFirstRead(expected, stage, calls[0].name, calls[0].arguments);
  return verifyFirstRead(expected, stage, tool, args);
}
