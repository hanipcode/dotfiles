import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import { MoverFailure, type MoverResult } from "./mover-domain.ts";
import type { MoverCommands } from "./mover-worktrees.ts";

/** Herdr integration targets explicit IDs and never relies on the user-focused pane. */
export class MoverHerdr {
  constructor(private readonly commands: MoverCommands, private readonly workspaceId: string | undefined) {}

  /** Refuse deletion while any Herdr pane, even another workspace, uses this checkout. */
  async checkUnused(cwd: string, path: string): Promise<MoverResult<void>> {
    try {
      const result = await this.run(["pane", "list"], cwd);
      if (!("panes" in result) || !Array.isArray(result.panes)) throw new MoverFailure("Herdr returned an invalid pane inventory.");
      for (const pane of result.panes) {
        if (typeof pane !== "object" || pane === null) throw new MoverFailure("Herdr returned an invalid pane.");
        for (const key of ["cwd", "foreground_cwd"] as const) {
          if (!(key in pane)) continue;
          const location: unknown = pane[key];
          if (typeof location !== "string") continue;
          const canonical = resolve(location);
          if (canonical === resolve(path) || canonical.startsWith(`${resolve(path)}${sep}`)) throw new MoverFailure("A Herdr pane still uses this worktree. Move or close it before deleting.");
        }
      }
      return { ok: true, value: undefined };
    } catch (error) { return this.failure(error); }
  }

  /** Open a native worktree workspace; existing agents are never replaced. */
  async openWorktree(input: { readonly cwd: string; readonly path: string; readonly label: string }): Promise<MoverResult<
    | { readonly kind: "existing"; readonly workspaceId: string }
    | { readonly kind: "created"; readonly workspaceId: string; readonly paneId: string }
  >> {
    if (!this.workspaceId) return { ok: false, error: new MoverFailure("Mover requires HERDR_WORKSPACE_ID in a Herdr pane.") };
    try {
      const result = await this.run(["worktree", "open", "--workspace", this.workspaceId, "--path", input.path, "--label", input.label, "--no-focus"], input.cwd);
      if (!("workspace" in result) || typeof result.workspace !== "object" || result.workspace === null || !("workspace_id" in result.workspace) || typeof result.workspace.workspace_id !== "string") throw new MoverFailure("Herdr opened a worktree but returned no workspace ID; inspect Herdr before retrying.");
      const workspaceId = result.workspace.workspace_id;
      if ("already_open" in result && result.already_open === true) {
        await this.run(["workspace", "focus", workspaceId], input.cwd);
        return { ok: true, value: { kind: "existing", workspaceId } };
      }
      if (!("root_pane" in result) || typeof result.root_pane !== "object" || result.root_pane === null || !("pane_id" in result.root_pane) || typeof result.root_pane.pane_id !== "string") throw new MoverFailure(`Herdr returned no pane ID for worktree workspace ${workspaceId}; inspect it before retrying.`);
      return { ok: true, value: { kind: "created", workspaceId, paneId: result.root_pane.pane_id } };
    } catch (error) { return this.failure(error); }
  }

  /** Resume a prepared session only in a newly opened workspace, then focus it. */
  async startSession(input: { readonly cwd: string; readonly workspaceId: string; readonly paneId: string; readonly sessionPath: string }): Promise<MoverResult<void>> {
    try {
      await this.run(["agent", "start", `mover-${randomUUID().slice(0, 8)}`, "--kind", "pi", "--pane", input.paneId, "--", "--session", input.sessionPath], input.cwd);
      await this.run(["workspace", "focus", input.workspaceId], input.cwd);
      return { ok: true, value: undefined };
    } catch (error) {
      // Startup may have launched a live agent before returning an error. Keep both for recovery.
      return this.failure(new MoverFailure(`${error instanceof Error ? error.message : String(error)} Worktree workspace ${input.workspaceId} and session ${input.sessionPath} are retained for recovery.`));
    }
  }

  private async run(args: string[], cwd: string): Promise<object> {
    const result = await this.commands.run("herdr", args, cwd);
    if (result.code !== 0) throw new MoverFailure(result.stderr.trim() || result.stdout.trim() || "Herdr command failed.");
    const response: unknown = JSON.parse(result.stdout);
    if (typeof response !== "object" || response === null || !("result" in response) || typeof response.result !== "object" || response.result === null) throw new MoverFailure("Herdr returned an invalid response.");
    return response.result;
  }

  private failure(error: unknown): MoverResult<never> {
    return { ok: false, error: error instanceof MoverFailure ? error : new MoverFailure(error instanceof Error ? error.message : String(error)) };
  }
}
