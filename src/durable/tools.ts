import { Type } from "typebox";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { createCodingTools, createBashTool, type BashPrepare } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { askParent } from "./supervisor.ts";

export async function workerTools(prepareBash?: BashPrepare): Promise<readonly ToolRegistration[]> {
  const coding = createCodingTools({ images: await createNodePhotonImages() });
  const ls = defineTool({ name: "ls", description: "List a directory in the worker environment.", replay: "safe",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    async execute(args, api, ctx) {
      if (!api.env) throw new Error("Worker execution environment unavailable");
      const entries = getOrThrow(await api.env.listDir(args.path ?? ".", ctx));
      return { output: [{ type: "text", text: entries.slice(0, 1000).map(entry => `${entry.name}${entry.kind === "directory" ? "/" : ""}`).join("\n") }],
        ...(entries.length > 1000 ? { diagnostics: [{ severity: "warn" as const, message: "Listing limited to 1000 entries" }] } : {}) };
    },
  });
  const search = (name: "find" | "grep") => defineTool({ name, description: name === "find" ? "Find file paths containing a literal pattern." : "Search text files for a literal pattern; bounded results.", replay: "safe",
    parameters: Type.Object({ pattern: Type.String({ minLength: 1 }), path: Type.Optional(Type.String()) }),
    async execute(args, api, ctx) {
      if (!api.env) throw new Error("Worker execution environment unavailable");
      if (!api.env.listFiles) throw new Error("Environment does not support file listing");
      const directory = getOrThrow(await api.env.absolutePath(args.path ?? ".", ctx));
      const listing = getOrThrow(await api.env.listFiles(directory, { maxEntries: 10000, maxBytes: 1000000, gitignore: true }, ctx));
      const results: string[] = [];
      let scanned = 0, truncated = listing.truncated;
      for (const file of listing.entries) {
        if (name === "find") { if (file.path.includes(args.pattern)) results.push(file.path); }
        else if (file.kind === "file") {
          if (++scanned > 1000) { truncated = true; break; }
          const full = getOrThrow(await api.env.joinPath([directory, file.path], ctx));
          const info = getOrThrow(await api.env.fileInfo(full, ctx));
          if (info.size > 1024 * 1024) { truncated = true; continue; }
          const content = await api.env.readTextFile(full, ctx);
          if (!content.ok || content.value.includes("\0")) continue;
          for (const [index, line] of content.value.split("\n").entries()) if (line.includes(args.pattern)) {
            results.push(`${file.path}:${index + 1}: ${line.slice(0, 500)}`);
            if (results.length >= 100) break;
          }
        }
        if (results.length >= 100) { truncated = true; break; }
      }
      return { output: [{ type: "text", text: results.join("\n") || "No matches in inspected files." }],
        ...(truncated ? { diagnostics: [{ severity: "warn" as const, message: "Search was bounded; narrow the path or pattern for complete results." }] } : {}) };
    },
  });
  // Upstream coding tools default to unsafe. Reads may be repeated after a crash;
  // writes, edits and shell commands retain the conservative upstream policy.
  return [...coding.tools!.map(tool => tool.name === "read" ? { ...tool, replay: "safe" as const } : tool.name === "bash" && prepareBash ? createBashTool({ prepare: prepareBash }) : tool), ls, search("find"), search("grep"), askParent];
}
