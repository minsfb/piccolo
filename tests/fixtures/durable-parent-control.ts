import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Owned managed-runtime qualification only. Calls the installed Piccolo tools
 * through public executeTool, preserving native validation/hooks/permissions.
 */
export default function parentControl(pi: ExtensionAPI) {
  const root = process.env.PICCOLO_QUALIFICATION_ROOT;
  if (!root || !path.isAbsolute(root) || fs.realpathSync(root) !== root) throw new Error("Qualification root must be an explicit canonical owned directory");
  const directory = path.join(root, ".cache", "qualification-control");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stateFile = path.join(directory, "state.json");
  pi.on("session_start", (_event, ctx) => {
    if (ctx.cwd !== root) throw new Error("Qualification cwd mismatch");
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, pid: process.pid, session: ctx.sessionManager.getSessionId() }), { mode: 0o600 });
  });
  pi.registerTool({ name: "piccolo_test_control", label: "Owned qualification control", description: "Run the explicitly requested qualification step once and return its receipt.",
    parameters: Type.Object({ token: Type.String({ pattern: "^[a-f0-9-]{36}$" }), action: Type.Union(["submit", "recovery", "resume_reply", "suspend", "status"].map(action => Type.Literal(action))) }),
    async execute(_id, params, signal, _update, ctx) {
      if (ctx.cwd !== root) throw new Error("Qualification cwd mismatch");
      const receipt = path.join(directory, `${params.token}.json`), fingerprint = createHash("sha256").update(JSON.stringify(params)).digest("hex");
      if (fs.existsSync(receipt)) {
        const saved = JSON.parse(fs.readFileSync(receipt, "utf8"));
        if (saved.fingerprint !== fingerprint) throw new Error("Qualification token reused");
        return { content: [{ type: "text", text: JSON.stringify(saved.details) }], details: saved.details };
      }
      const call = async (tool: string, args: unknown) => {
        const result = await ctx.executeTool(tool, args, { signal });
        if (result.isError) throw new Error(`Qualification call failed: ${JSON.stringify(result.result.content).slice(0, 1000)}`);
        return result.result.details as any;
      };
      let state = JSON.parse(fs.readFileSync(stateFile, "utf8")), details: any;
      if (params.action === "submit") {
        const submitted = await call("piccolo_submit", { kind: "delegate", arguments: { type: "implementer",
          task: 'Use read to inspect codeword.txt. Then call ask_parent with question "May I write the proof?" and wait. After the parent replies PROCEED, use write to create .cache/proof.txt containing only the codeword, and return RECOVERY-DONE. Do not write anything before the reply.',
          overrides_toml: 'tools = ["read", "write"]\ntimeout_ms = 600000' } });
        state.job = submitted.id;
        fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
      }
      if (params.action === "recovery") details = await call("piccolo_jobs", { action: "recovery" });
      else if (params.action === "suspend") details = await call("piccolo_jobs", { action: "suspend" });
      else {
        if (!state.job) throw new Error("Qualification has no saved Job");
        if (params.action === "resume_reply") {
          await call("piccolo_jobs", { action: "resume" });
          await call("piccolo_jobs", { action: "message", id: state.job, text: "PROCEED", message_id: params.token });
        }
        const deadline = Date.now() + 120000;
        do {
          details = await call("piccolo_jobs", { action: "status", id: state.job });
          if (params.action === "submit" ? details.attention_total > 0 : !!details.outcome_revision) break;
          if (signal?.aborted) throw new Error("Qualification wait cancelled");
          await new Promise(resolve => setTimeout(resolve, 250));
        } while (Date.now() < deadline);
        if (params.action === "submit" ? !details.attention_total : !details.outcome_revision) throw new Error("Qualification wait timed out");
        if (details.outcome_revision) details = await call("piccolo_jobs", { action: "result", id: state.job });
      }
      const saved = { fingerprint, details };
      fs.writeFileSync(receipt, JSON.stringify(saved), { flag: "wx", mode: 0o600 });
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
}
