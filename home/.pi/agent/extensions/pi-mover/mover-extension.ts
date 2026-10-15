import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MoverPicker, type MoverPickerAction } from "./mover-picker.ts";
import { MoverWorktrees, type MoverCommands } from "./mover-worktrees.ts";
import { MoverHerdr } from "./mover-herdr.ts";
import { archiveMoverSource, prepareMoverSession } from "./mover-sessions.ts";

/** Register /mover without starting processes, creating worktrees, or moving the session on load. */
export default function moverExtension(pi: ExtensionAPI): void {
  const stateDirectory = join(homedir(), ".pi", "agent", "pi-mover");
  const herdrEnabled = process.env.HERDR_ENV === "1";
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const commands: MoverCommands = { run: (command, args, cwd) => pi.exec(command, args, { cwd }) };
  const worktrees = new MoverWorktrees(commands, join(stateDirectory, "visits"));
  const herdr = new MoverHerdr(commands, workspaceId);

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const current = await worktrees.list(ctx.cwd);
    if (current.ok) {
      const visited = await worktrees.visit(current.value.currentPath);
      if (!visited.ok) ctx.ui.notify(visited.error.message, "warning");
    }
  });

  pi.registerCommand("mover", {
    description: "Move this conversation to a worktree; create, open in Herdr, or safely delete checkouts",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Pi Mover requires interactive mode.", "warning"); return; }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify("Pi Mover: finish or interrupt the agent and clear queued prompts before moving.", "warning"); return; }
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) { ctx.ui.notify("Pi Mover: a persistent session is required.", "warning"); return; }
      while (true) {
        const inventory = await worktrees.list(ctx.cwd);
        if (!inventory.ok) { ctx.ui.notify(inventory.error.message, "error"); return; }
        const action = await ctx.ui.custom<MoverPickerAction>((tui, theme, _keys, done) => new MoverPicker(
          inventory.value.worktrees, inventory.value.currentPath, theme, done, () => tui.requestRender(),
        ), { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%" } });
        if (action.kind === "close") return;
        if (!ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify("Pi Mover: the agent became busy; retry once idle.", "warning"); return; }
        if (action.kind === "delete") {
          if (!(await ctx.ui.confirm("Delete worktree?", `${action.path}\nOnly a clean, unlocked, unused checkout can be removed. Its branch will be kept.`))) continue;
          if (herdrEnabled) {
            const unused = await herdr.checkUnused(ctx.cwd, action.path);
            if (!unused.ok) { ctx.ui.notify(unused.error.message, "warning"); continue; }
          }
          const deleted = await worktrees.remove(ctx.cwd, action.path);
          ctx.ui.notify(deleted.ok ? `Removed ${action.path}; branch kept.` : deleted.error.message, deleted.ok ? "info" : "warning");
          continue;
        }
        if (herdrEnabled && !workspaceId) {
          ctx.ui.notify("Pi Mover: HERDR_WORKSPACE_ID is required in a Herdr pane.", "warning");
          return;
        }
        let targetPath: string;
        if (action.kind === "create") {
          ctx.ui.setStatus("pi-mover", "Creating worktree from origin/main (or local main)…");
          const created = await worktrees.create(ctx.cwd, action.name);
          ctx.ui.setStatus("pi-mover", undefined);
          if (!created.ok) { ctx.ui.notify(created.error.message, "error"); continue; }
          targetPath = created.value;
        } else targetPath = action.path;
        if (!herdrEnabled && resolve(targetPath) === resolve(inventory.value.currentPath)) {
          ctx.ui.notify("Pi Mover: already in this worktree.", "info");
          continue;
        }
        // A fetch/create can take time. Never migrate a session that became busy while it ran.
        if (!ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify(`Pi Mover: agent became busy; checkout ${targetPath} is retained. Retry once idle.`, "warning"); return; }
        let destination: { readonly workspaceId: string; readonly paneId: string } | undefined;
        if (herdrEnabled) {
          const opened = await herdr.openWorktree({ cwd: ctx.cwd, path: targetPath, label: basename(targetPath) });
          if (!opened.ok) { ctx.ui.notify(opened.error.message, "error"); return; }
          if (opened.value.kind === "existing") {
            const visited = await worktrees.visit(targetPath);
            if (!visited.ok) ctx.ui.notify(visited.error.message, "warning");
            return;
          }
          destination = opened.value;
        }
        if (!ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify(`Pi Mover: agent became busy; checkout ${targetPath} is retained. Retry once idle.`, "warning"); return; }
        const prepared = await prepareMoverSession({ source: sessionFile, targetCwd: targetPath, leafId: ctx.sessionManager.getLeafId(), mode: action.sessionMode, currentSession: ctx.sessionManager });
        if (!prepared.ok) { ctx.ui.notify(`${prepared.error.message}${destination ? ` Workspace ${destination.workspaceId} is retained for recovery.` : ""}`, "error"); return; }
        if (destination) {
          const started = await herdr.startSession({ cwd: ctx.cwd, ...destination, sessionPath: prepared.value.path });
          if (!started.ok) {
            ctx.ui.notify(started.error.message, "error");
            return;
          }
          const visited = await worktrees.visit(targetPath);
          if (!visited.ok) ctx.ui.notify(visited.error.message, "warning");
          if (prepared.value.goal === "fork") {
            ctx.ui.notify(`Fork opened in Herdr worktree ${destination.workspaceId}. This conversation remains here.`, "info");
            return;
          }
          if (prepared.value.source) {
            const archived = await archiveMoverSource(prepared.value.source, join(stateDirectory, "backups"));
            if (!archived.ok) ctx.ui.notify(archived.error.message, "warning");
          }
          ctx.ui.notify(`Session opened in Herdr worktree ${destination.workspaceId}. Exiting this Pi instance.`, "info");
          ctx.shutdown();
          return;
        }
        const sessionMode = prepared.value.goal;
        const sourcePath = prepared.value.source;
        const destinationSession = prepared.value.path;
        const result = await ctx.switchSession(destinationSession, {
          withSession: async fresh => {
            // Runtime replacement rebuilds tools/resources for targetCwd. OS cwd follows only after it succeeds.
            process.chdir(targetPath);
            process.env.PWD = targetPath;
            if (sessionMode === "move" && sourcePath) {
              const archived = await archiveMoverSource(sourcePath, join(stateDirectory, "backups"));
              if (!archived.ok) fresh.ui.notify(archived.error.message, "warning");
            }
            await fresh.sendMessage({ customType: "pi-mover-location", content: `This conversation ${sessionMode === "fork" ? "forked" : "moved"} to worktree ${targetPath}. Use this as the working directory. Prior absolute paths and remembered file contents may belong to the previous checkout; re-inspect relevant files before editing.`, display: true }, { triggerTurn: false });
            fresh.ui.notify(`${sessionMode === "fork" ? "Forked" : "Moved"} conversation to ${targetPath}`, "info");
          },
        });
        if (result.cancelled) {
          await rm(destinationSession);
          ctx.ui.notify("Pi Mover: session switch cancelled; original session unchanged.", "info");
        }
        // Successful switch invalidates ctx and pi; do not reuse either afterward.
        return;
      }
    },
  });
}
