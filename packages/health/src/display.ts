import { Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { keyText } from "@earendil-works/pi-coding-agent";

const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const brief = (value: unknown, length = 140) => typeof value === "string" ? clean(value).replace(/\s+/g, " ").slice(0, length) : "";
export function healthSummary(value: any): string {
  if (!value || typeof value !== "object") return "Health details available";
  if (value.storage_failed) return "Health recording failed · automatic recovery disabled";
  if (value.component) return `${brief(value.component, 30)}/${brief(value.code, 40)} · ${brief(value.disposition, 24)} · ${brief(value.id, 12)}`;
  const incidents = Array.isArray(value.incidents) ? value.incidents : [];
  const unresolved = incidents.filter((i: any) => !["resolved", "superseded"].includes(i.disposition)).length;
  return `Health ${value.active ? "active" : "inactive"} · ${unresolved} unresolved in view${value.incidents_truncated ? " (truncated)" : ""}${value.active && value.recovery === "wake" && !value.wake_capability ? " · automatic wake unavailable" : ""}`;
}
function view(lines: string[], expanded: boolean, detail: string) {
  const text = clean(detail);
  const full = new Text(text.length > 120000 ? text.slice(0, 120000) + "\n[Display truncated; inspect retained health records.]" : text, 0, 0);
  return { invalidate() { full.invalidate(); }, render(width: number) { return expanded ? full.render(width) : lines.map(line => truncateToWidth(clean(line).replace(/\s+/g, " "), Math.max(1, width))); } };
}
export const healthRenderers = {
  renderCall(args: any) { return view([`harness_health · ${brief(args.action, 32)}${args.disposition ? ` · ${brief(args.disposition, 24)}` : ""}`], false, ""); },
  renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial?: boolean }, _theme: any, context: any) {
    const content = result.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ?? "";
    const lines = [context?.isError ? `Health check failed · ${brief(content)}` : isPartial ? "Checking harness health…" : healthSummary(result.details)];
    const incidents = result.details?.incidents;
    if (Array.isArray(incidents) && incidents.length === 1) lines.push(healthSummary(incidents[0]));
    lines.push(`${keyText("app.tools.expand")} details`);
    return view(lines, expanded, result.details === undefined ? content : JSON.stringify(result.details, null, 2));
  },
};
export function healthMessageRenderer(message: any, { expanded }: { expanded: boolean }) {
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
  let value = message.details;
  if (!value) { try { value = JSON.parse(content); } catch { /* Older text remains available expanded. */ } }
  return view([healthSummary(value), `${keyText("app.tools.expand")} details`], expanded, content);
}
