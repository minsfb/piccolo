import { Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { keyText, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const brief = (value: unknown, length = 160) => typeof value === "string" ? clean(value).replace(/\s+/g, " ").slice(0, length) : "";
const short = (value: unknown) => brief(value, 12);
const count = (value: unknown) => value && typeof value === "object" ? Object.keys(value).length : 0;
const object = (value: unknown): any => value && typeof value === "object" ? value : {};

/** Collapsed output is bounded in terminal columns, even for newline-free JSON. */
export function displayText(lines: string[], expanded = false, detail = "") {
  const text = clean(detail);
  const bounded = text.length > 120000 ? text.slice(0, 120000) + "\n[Display truncated; inspect the retained result for full details.]" : text;
  const full = new Text(bounded, 0, 0);
  return {
    invalidate() { full.invalidate(); },
    render(width: number) { return expanded ? full.render(width) : lines.map(line => truncateToWidth(clean(line).replace(/\s+/g, " "), Math.max(1, width))); },
  };
}

export function piccoloSummary(name: string, raw: unknown): string {
  const d = object(raw);
  if (d.truncated) return "Result truncated · inspect retained result/pages";
  if (name === "piccolo_remote" && d.outcome) return [brief(d.state, 24), brief(d.outcome.status, 40), short(d.id)].filter(Boolean).join(" · ");
  if (typeof d.state === "string") return [short(d.id), brief(d.kind, 24), brief(d.state, 40), d.stopping ? "stopping" : "", d.parent_review?.disposition ? `review ${brief(d.parent_review.disposition, 24)}` : ""].filter(Boolean).join(" · ");
  if (name === "piccolo_catalog") return `${Object.keys(d.agents ?? {}).length} agent types · ${Object.keys(d.jobs ?? {}).length} workflows`;
  if (Array.isArray(d.jobs)) return `${d.jobs.length} jobs shown / ${d.total ?? d.jobs.length} total · ${d.jobs.filter((j: any) => j.parent_review?.disposition === "pending").length} awaiting review on this page`;
  if (Array.isArray(d.models)) return `${d.models.length} models available`;
  if (Array.isArray(d.ready)) return `${d.ready.length} ready · ${count(d.waiting)} waiting · ${count(d.stale)} stale`;
  if (Array.isArray(d.observations)) return `${d.pending ?? 0} pending · ${d.unresolved ?? 0} unresolved · ${d.total ?? d.observations.length} workflow records`;
  if (Array.isArray(d.created)) return `${d.created.length} execution documents created`;
  if (d.workflow && d.stage) return `${brief(d.stage, 32)} · ${brief(d.type, 32)} · round ${d.round ?? "?"}`;
  if (d.next_offset !== undefined) return `Result page · ${d.next_offset === null ? "last page" : "more pages available"}`;
  if (d.status) return [brief(d.status, 40), d.candidate ? `candidate ${short(d.candidate)}` : "", brief(d.summary)].filter(Boolean).join(" · ");
  if (name === "piccolo_inspect") return "Configuration and origins available";
  if (name === "piccolo_evidence") return "Evidence recorded · expand for artifact references";
  return "Result available";
}

export function compactTool<T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition<T> {
  return { ...tool,
    renderCall(args: any, theme) {
      const kind = args?.action ?? args?.kind ?? args?.type;
      return displayText([theme.fg("toolTitle", `${tool.name}${kind ? ` · ${brief(kind, 48)}` : ""}`)]);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const d = object(result.details);
      const remote = tool.name === "piccolo_remote" ? object(d.outcome) : {};
      const status = remote.status ?? d.status ?? d.state;
      const error = d.error ?? remote.error;
      const failed = context?.isError || !!error || ["failed", "blocked", "unresolved", "needs_parent", "execution_error", "startup_error", "timeout", "timed_out", "cancelled", "interrupted"].includes(status);
      const content = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      const summary = isPartial ? (d.stage ? piccoloSummary(tool.name, d) : "Running…") : context?.isError && !status ? "Tool failed" : piccoloSummary(tool.name, d);
      const lines = [theme.fg(failed ? "warning" : "muted", `${failed ? "Attention · " : ""}${summary}`)];
      if (failed) lines.push(brief(error ?? content) || "Inspect details for the failure.");
      lines.push(theme.fg("dim", `${keyText("app.tools.expand")} details`));
      return displayText(lines, expanded, result.details === undefined ? content : JSON.stringify(result.details, null, 2));
    },
  };
}

export function jobNoticeRenderer(message: any, { expanded }: { expanded: boolean }) {
  const ids = message.details?.jobs;
  const summary = message.details?.recovery ? "Saved Jobs · /piccolo-jobs" : Array.isArray(ids) ? `${ids.length} job outcome${ids.length === 1 ? "" : "s"} ready for review · /piccolo-jobs` : "Job outcomes ready for review · /piccolo-jobs";
  return displayText([summary, `${keyText("app.tools.expand")} details`], expanded, typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2));
}
