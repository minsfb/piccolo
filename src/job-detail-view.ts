import { Key, matchesKey, Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const limit = 120000;
function fullDetailText(value: any): string {
  const output = value?.result?.result;
  const summary = output?.kind === "text" && typeof output.text === "string" ? output.text : undefined;
  const serialized = JSON.stringify(value, null, 2) ?? "No result available yet.";
  const text = clean(summary ? `Output\n\n${summary}\n\nDetails\n${serialized}` : serialized);
  return text;
}
export function detailTruncated(value: unknown): boolean { return fullDetailText(value).length > limit; }
export function detailText(value: unknown): string {
  const text = fullDetailText(value);
  return text.length <= limit ? text : text.slice(0, limit) + "\n\n[Display truncated. Inspect this job's retained .piccolo/jobs/<id>/outcome.json for full details.]";
}

/** A read-only native Pi component. Dismissal only resolves the UI promise. */
export class JobDetailView {
  private text: Text;
  private offset = 0;
  private lines: string[] = [];
  private page = 1;
  private title: string;
  private height: () => number;
  private redraw: () => void;
  private close: () => void;
  constructor(title: string, value: unknown, height: () => number, redraw: () => void, close: () => void) {
    this.title = clean(title); this.height = height; this.redraw = redraw; this.close = close;
    this.text = new Text(detailText(value), 0, 0);
  }
  invalidate() { this.text.invalidate(); }
  render(width: number): string[] {
    width = Math.max(1, width);
    this.page = Math.max(1, this.height() - 6);
    this.lines = this.text.render(width);
    this.offset = Math.max(0, Math.min(this.offset, this.lines.length - this.page));
    return [truncateToWidth(this.title, width), "", ...this.lines.slice(this.offset, this.offset + this.page), "",
      truncateToWidth(`↑↓ scroll · PgUp/PgDn · Home/End · Esc/Enter back (${this.offset + 1}–${Math.min(this.offset + this.page, this.lines.length)}/${this.lines.length})`, width)];
  }
  handleInput(data: string) {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("c"))) { this.close(); return; }
    if (matchesKey(data, Key.up)) this.offset--;
    else if (matchesKey(data, Key.down)) this.offset++;
    else if (matchesKey(data, Key.pageUp)) this.offset -= this.page;
    else if (matchesKey(data, Key.pageDown)) this.offset += this.page;
    else if (matchesKey(data, Key.home)) this.offset = 0;
    else if (matchesKey(data, Key.end)) this.offset = this.lines.length;
    else return;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.lines.length - this.page)));
    this.redraw();
  }
}

export async function showJobDetail(ctx: ExtensionContext, title: string, value: unknown) {
  await ctx.ui.custom<void>((tui, _theme, _keys, done) =>
    new JobDetailView(title, value, () => tui.terminal.rows, () => tui.requestRender(), () => done()));
}
