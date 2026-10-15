import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdfastPicker } from "./herdfast-picker.ts";
import { HerdfastWorktrees, type HerdfastWorktree } from "./herdfast-worktrees.ts";

/** Register /hf as focus-only navigation among the caller's open Herdr worktrees. */
export default function herdfastExtension(pi: ExtensionAPI): void {
  const enabled = process.env.HERDR_ENV === "1";
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const worktrees = new HerdfastWorktrees(
    { run: (args, cwd) => pi.exec("herdr", args, { cwd }) },
    join(homedir(), ".pi", "agent", "herdfast", "visits"),
    () => Date.now(),
  );
  pi.registerCommand("hf", {
    description: "Herdr focus: search open worktrees in this repository, most recent first",
    handler: async (_args, ctx) => {
      if (!enabled || !workspaceId) { ctx.ui.notify("Herdfast requires a Herdr-managed pane and workspace.", "warning"); return; }
      if (ctx.mode !== "tui") { ctx.ui.notify("Herdfast requires interactive mode.", "warning"); return; }
      const inventory = await worktrees.list(ctx.cwd, workspaceId);
      if (!inventory.ok) { ctx.ui.notify(inventory.error.message, "error"); return; }
      if (!inventory.value.worktrees.length) { ctx.ui.notify("Herdfast: no open worktrees in this workspace's repository.", "info"); return; }
      const selected = await ctx.ui.custom<HerdfastWorktree | undefined>((tui, theme, _keys, done) =>
        new HerdfastPicker(inventory.value, theme, done, () => tui.requestRender()),
        { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%" } },
      );
      if (!selected) return;
      const focused = await worktrees.focus(ctx.cwd, workspaceId, selected);
      if (!focused.ok) ctx.ui.notify(focused.error.message, "error");
    },
  });
}
