import { SelectList, getKeybindings, truncateToWidth, type SelectListTheme } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type JobRow = { id: string; kind: string; state: string; stopping: boolean; parent_review: { disposition: string } };

/** Refresh only visible job labels. Selection remains bound to a job ID. */
export class JobListView {
  private list!: SelectList;
  private signature = "";
  private failed = false;
  private ids: string[] = [];
  private disposed = false;
  private timer: ReturnType<typeof setInterval>;
  private jobs: () => JobRow[];
  private height: () => number;
  private theme: SelectListTheme;
  private redraw: () => void;
  private done: (id: string | undefined) => void;
  private toggleTools?: () => void;
  constructor(jobs: () => JobRow[], height: () => number, theme: SelectListTheme,
    redraw: () => void, done: (id: string | undefined) => void, toggleTools?: () => void) {
    this.jobs = jobs; this.height = height; this.theme = theme; this.redraw = redraw; this.done = done;
    this.toggleTools = toggleTools;
    this.refresh();
    this.timer = setInterval(() => { if (this.refresh()) this.redraw(); }, 200);
    this.timer.unref?.();
  }
  refresh() {
    if (this.disposed || this.failed) return false;
    let rows: JobRow[];
    try { rows = this.jobs(); }
    catch { this.failed = true; rows = []; }
    const items = rows.map(job => ({ value: job.id,
      label: `${job.id} ${job.kind} ${job.state} [${job.parent_review.disposition}]${job.stopping ? " (stopping)" : ""}` }));
    const height = Math.max(1, this.height() - 5);
    const signature = JSON.stringify([items, height, this.failed]);
    if (signature === this.signature) return false;
    const selected = this.list?.getSelectedItem()?.value;
    this.ids = items.map(item => item.value);
    this.list = new SelectList(items, height, this.theme);
    this.list.setSelectedIndex(Math.max(0, items.findIndex(item => item.value === selected)));
    this.list.onSelect = item => { this.dispose(); this.done(item.value); };
    this.list.onCancel = () => { this.dispose(); this.done(undefined); };
    this.signature = signature;
    return true;
  }
  invalidate() { this.list.invalidate(); }
  render(width: number) {
    this.refresh();
    return [truncateToWidth(this.failed ? "Job refresh failed — Esc closes; reopen to inspect" : "Session jobs — Esc closes without stopping work", width), "", ...this.list.render(width), "",
      truncateToWidth("↑↓ navigate · Enter select · Esc back · updates live", width)];
  }
  handleInput(data: string) {
    if (this.disposed) return;
    this.refresh();
    const kb = getKeybindings(), index = this.ids.indexOf(this.list.getSelectedItem()?.value ?? "");
    if (kb.matches(data, "app.tools.expand")) this.toggleTools?.();
    else if (kb.matches(data, "tui.select.up") || data === "k") this.list.setSelectedIndex(Math.max(0, index - 1));
    else if (kb.matches(data, "tui.select.down") || data === "j") this.list.setSelectedIndex(Math.max(0, Math.min(this.ids.length - 1, index + 1)));
    else this.list.handleInput(data);
    this.redraw();
  }
  dispose() { this.disposed = true; clearInterval(this.timer); }
}

export async function showJobList(ctx: ExtensionContext, jobs: () => JobRow[]) {
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => new JobListView(jobs, () => tui.terminal.rows, {
    selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
    description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("dim", text), noMatch: text => theme.fg("muted", text),
  }, () => tui.requestRender(), done, () => ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded())));
}
