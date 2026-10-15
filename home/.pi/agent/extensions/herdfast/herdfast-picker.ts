import { Input, Key, matchesKey, SelectList, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { HerdfastInventory, HerdfastWorktree } from "./herdfast-worktrees.ts";

/** Search open worktrees without changing their recency order; selection only changes Herdr focus. */
export class HerdfastPicker {
  private readonly input = new Input({ prompt: "search: " });
  private list: SelectList;

  constructor(
    private readonly inventory: HerdfastInventory,
    private readonly theme: Pick<Theme, "fg">,
    private readonly done: (tree: HerdfastWorktree | undefined) => void,
    private readonly requestRender: () => void,
  ) { this.list = this.createList(); }

  private createList(): SelectList {
    const query = this.input.getValue().trim().toLowerCase();
    const list = new SelectList(this.inventory.worktrees.filter(tree =>
      `${tree.branch} ${tree.label} ${tree.path} ${tree.workspaceId}`.toLowerCase().includes(query)
    ).map(tree => ({
      value: tree.workspaceId,
      label: `${tree.current ? "[active] " : ""}${tree.branch} · ${tree.label}`,
      description: tree.path,
    })), 10, {
      selectedPrefix: text => this.theme.fg("accent", text),
      selectedText: text => this.theme.fg("accent", text),
      description: text => this.theme.fg("muted", text),
      scrollInfo: text => this.theme.fg("dim", text),
      noMatch: () => this.theme.fg("warning", "No matching open worktrees"),
    });
    list.onSelect = item => this.done(this.inventory.worktrees.find(tree => tree.workspaceId === item.value));
    list.onCancel = () => this.done(undefined);
    return list;
  }

  /** Keep the search input cursor available for IME composition. */
  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  /** Type to filter, arrows to select, Enter to focus, Escape to cancel. */
  handleInput(data: string): void {
    if ([Key.up, Key.down, Key.enter, Key.escape, Key.ctrl("c"), Key.pageUp, Key.pageDown].some(key => matchesKey(data, key))) {
      this.list.handleInput(matchesKey(data, Key.ctrl("c")) ? "\x1b" : data);
    } else {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (previous !== this.input.getValue()) this.list = this.createList();
    }
    this.requestRender();
  }

  /** Delegate list-local mouse events to the built-in selector. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y < 3) return undefined;
    const result = this.list.handleMouse({ ...event, y: event.y - 3, height: Math.max(0, event.height - 4) });
    if (result) this.requestRender();
    return result;
  }

  /** Bounded rows retain active markers and recency order at narrow terminal widths. */
  render(width: number): string[] {
    return [
      this.theme.fg("accent", `Herdr Focus · ${this.inventory.repoName}`),
      ...this.input.render(Math.max(1, width)),
      this.theme.fg("dim", "Most recent first · [active] current workspace"),
      ...this.list.render(Math.max(1, width)),
      this.theme.fg("dim", "↑↓ select · Enter focus · Esc cancel"),
    ].map(line => truncateToWidth(line, Math.max(1, width)));
  }

  /** Refresh child layout when the theme or terminal changes. */
  invalidate(): void { this.input.invalidate(); this.list.invalidate(); }
}
