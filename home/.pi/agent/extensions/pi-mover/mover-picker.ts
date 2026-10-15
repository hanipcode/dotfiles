import { Input, Key, matchesKey, sliceByColumn, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MoverSessionMode } from "./mover-sessions.ts";
import { filterMoverWorktrees, formatMoverRecency, type MoverWorktree } from "./mover-domain.ts";

/** Picker intent; all Herdr selections open or focus a workspace. */
export type MoverPickerAction =
  | { readonly kind: "close" }
  | { readonly kind: "move"; readonly path: string; readonly sessionMode: MoverSessionMode }
  | { readonly kind: "create"; readonly name: string; readonly sessionMode: MoverSessionMode }
  | { readonly kind: "delete"; readonly path: string };

/** Search-first worktree picker; list focus keeps the deletion key out of name entry. */
export class MoverPicker {
  private readonly input = new Input({ prompt: "worktree name: " });
  private selected = 0;
  private sessionMode: MoverSessionMode = "move";
  private listFocused = false;
  private windowStart = 0;
  private rows = 8;
  private hasFocus = false;

  constructor(
    private readonly worktrees: ReadonlyArray<MoverWorktree>,
    private readonly currentPath: string,
    private readonly theme: Pick<Theme, "fg">,
    private readonly done: (action: MoverPickerAction) => void,
    private readonly requestRender: () => void,
  ) {}

  /** Forward the terminal cursor to the search input, not the selected list row. */
  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.input.focused = value && !this.listFocused; }

  /** Handle navigation and creation without swallowing ordinary 'd' input characters. */
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.done({ kind: "close" }); return; }
    if (matchesKey(data, Key.shift("tab"))) {
      this.sessionMode = this.sessionMode === "move" ? "fork" : "move";
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab)) { this.setListFocus(!this.listFocused); return; }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.setListFocus(true);
      const count = Math.max(1, this.filtered().length);
      this.selected = Math.max(0, Math.min(count - 1, this.selected + (matchesKey(data, Key.up) ? -1 : 1)));
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.shift("enter"))) {
      const trees = this.filtered();
      const selected = trees[this.selected];
      if (selected) this.done({ kind: "move", path: selected.path, sessionMode: this.sessionMode });
      else if (this.input.getValue().trim()) this.done({ kind: "create", name: this.input.getValue().trim(), sessionMode: this.sessionMode });
      return;
    }
    if (this.listFocused && data === "d") {
      const selected = this.filtered()[this.selected];
      if (selected) this.done({ kind: "delete", path: selected.path });
      return;
    }
    if (this.listFocused) this.setListFocus(false);
    const previous = this.input.getValue();
    this.input.handleInput(data);
    if (previous !== this.input.getValue()) this.selected = 0;
    this.requestRender();
  }

  /** Mouse hover selects a row for deletion; clicking a row moves to it. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y === 1 && event.type === "press") { this.setListFocus(false); return { handled: true, focus: true }; }
    if (event.type === "wheel") {
      this.selected = Math.max(0, Math.min(this.filtered().length - 1, this.selected + (event.wheelDelta ?? 0)));
      this.requestRender();
      return { handled: true, render: true };
    }
    if (event.y === 3 && !this.filtered().length && this.input.getValue().trim() && event.type === "press" && event.button === "left") {
      this.done({ kind: "create", name: this.input.getValue().trim(), sessionMode: this.sessionMode });
      return { handled: true };
    }
    const index = event.y - 3 + this.windowStart;
    const row = this.filtered()[index];
    if (event.y >= 3 && event.y < 3 + this.rows && row && (event.type === "move" || event.type === "press")) {
      this.selected = index;
      this.setListFocus(true);
      if (event.type === "press" && event.button === "left") this.done({ kind: "move", path: row.path, sessionMode: this.sessionMode });
      return { handled: true, focus: true, render: true };
    }
    return undefined;
  }

  /** Render truncated paths and independently aligned recency labels within the terminal width. */
  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const frame = (line: string) => this.theme.fg("borderAccent", "│") + padMoverLine(line, contentWidth) + this.theme.fg("borderAccent", "│");
    const border = this.theme.fg("borderAccent", "─".repeat(contentWidth));
    const trees = this.filtered();
    this.selected = Math.max(0, Math.min(Math.max(0, trees.length - 1), this.selected));
    this.windowStart = Math.max(0, Math.min(this.selected - this.rows + 1, Math.max(0, trees.length - this.rows)));
    const lines = [this.theme.fg("borderAccent", "┌") + border + this.theme.fg("borderAccent", "┐"), frame(this.input.render(contentWidth)[0] ?? ""), frame(this.theme.fg("accent", `Mode: ${this.sessionMode === "move" ? "[Move]  Fork" : "Move  [Fork]"} · Shift+Tab`))];
    if (!trees.length) {
      const name = this.input.getValue().trim();
      lines.push(frame(this.theme.fg("accent", name ? `› Create ${name}` : "No linked worktrees")));
    } else {
      for (let index = this.windowStart; index < Math.min(trees.length, this.windowStart + this.rows); index++) {
        const tree = trees[index];
        if (!tree) continue;
        const time = formatMoverRecency(tree.lastVisited, Date.now());
        const label = `${index === this.selected ? "›" : " "} ${tree.path}${tree.path === this.currentPath ? " (current)" : ""}`;
        const pathWidth = Math.max(1, contentWidth - time.length - 3);
        const text = `${padMoverLine(shortenMoverPath(label, pathWidth), pathWidth)}   ${time}`;
        lines.push(frame(index === this.selected ? this.theme.fg("accent", text) : text));
      }
    }
    lines.push(frame(""), frame(this.theme.fg("dim", "↑↓ select · Enter open/focus or create")), frame(this.theme.fg("dim", "Tab input/list · d delete selected · Esc close")), this.theme.fg("borderAccent", "└") + border + this.theme.fg("borderAccent", "┘"));
    return lines;
  }

  /** Rebuild the input when Pi's theme or terminal layout changes. */
  invalidate(): void { this.input.invalidate(); }

  private filtered() { return filterMoverWorktrees(this.worktrees, this.input.getValue()); }
  private setListFocus(value: boolean) { this.listFocused = value; this.input.focused = this.hasFocus && !value; this.requestRender(); }
}

function shortenMoverPath(path: string, width: number) {
  const columns = visibleWidth(path);
  if (columns <= width) return path;
  if (width < 5) return truncateToWidth(path, width);
  const prefix = Math.floor((width - 1) / 3);
  const suffix = width - prefix - 1;
  return `${sliceByColumn(path, 0, prefix)}…${sliceByColumn(path, columns - suffix, suffix)}`;
}

function padMoverLine(line: string, width: number) {
  const text = truncateToWidth(line, width);
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
