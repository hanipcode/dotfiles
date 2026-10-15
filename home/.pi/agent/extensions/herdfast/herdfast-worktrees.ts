import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Herdfast failures are surfaced without changing the current Pi session. */
export class HerdfastFailure extends Error {
  readonly _tag = "HerdfastFailure";
  constructor(message: string) { super(`Herdfast: ${message}`); }
}

/** Expected command, inventory, and history failures remain explicit values. */
export type HerdfastResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: HerdfastFailure };

/** Commands run against the caller's cwd and explicit Herdr workspace IDs. */
export interface HerdfastCommands {
  run(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Only worktrees with open Herdr workspaces are focus targets. */
export type HerdfastWorktree = {
  readonly workspaceId: string;
  readonly path: string;
  readonly label: string;
  readonly branch: string;
  readonly current: boolean;
  readonly visitedAt: number;
};

/** Repository-scoped inventory and persistent focus recency. */
export type HerdfastInventory = {
  readonly repoKey: string;
  readonly repoName: string;
  readonly worktrees: ReadonlyArray<HerdfastWorktree>;
};

/** Own Herdr CLI parsing and append-only visit history; never create worktrees or start agents. */
export class HerdfastWorktrees {
  constructor(private readonly commands: HerdfastCommands, private readonly historyDirectory: string, private readonly now: () => number) {}

  /** List the caller workspace's open worktrees, newest recorded visit first. */
  async list(cwd: string, workspaceId: string): Promise<HerdfastResult<HerdfastInventory>> {
    try {
      const result = await this.run(["worktree", "list", "--workspace", workspaceId], cwd);
      if (!("source" in result) || !isHerdfastObject(result.source) || typeof result.source.repo_key !== "string" || typeof result.source.repo_name !== "string" || !("worktrees" in result) || !Array.isArray(result.worktrees)) throw new HerdfastFailure("Invalid Herdr worktree inventory.");
      const repoKey = result.source.repo_key;
      const history = await this.readVisits(repoKey);
      const worktrees: HerdfastWorktree[] = [];
      for (const tree of result.worktrees) {
        if (!isHerdfastObject(tree)) throw new HerdfastFailure("Invalid Herdr worktree entry.");
        if (tree.open_workspace_id === undefined || tree.is_bare === true) continue;
        if (typeof tree.open_workspace_id !== "string" || typeof tree.path !== "string" || (tree.branch !== undefined && typeof tree.branch !== "string") || (tree.label !== undefined && typeof tree.label !== "string")) throw new HerdfastFailure("Invalid open Herdr worktree.");
        const current = tree.open_workspace_id === workspaceId;
        let visitedAt = history.get(tree.path) ?? 0;
        if (current) {
          visitedAt = Math.max(this.now(), ...history.values(), 0) + 1;
          await this.visit(repoKey, tree.path, visitedAt);
        }
        worktrees.push({ workspaceId: tree.open_workspace_id, path: tree.path, label: tree.label ?? tree.path, branch: tree.branch ?? "detached", current, visitedAt });
      }
      worktrees.sort((a, b) => b.visitedAt - a.visitedAt || a.path.localeCompare(b.path));
      return { ok: true, value: { repoKey, repoName: result.source.repo_name, worktrees } };
    } catch (error) { return herdfastFailure(error); }
  }

  /** Focus only a target that is still open in the caller's repository; record recency after success. */
  async focus(cwd: string, workspaceId: string, target: HerdfastWorktree): Promise<HerdfastResult<void>> {
    const inventory = await this.list(cwd, workspaceId);
    if (!inventory.ok) return inventory;
    const live = inventory.value.worktrees.find(tree => tree.workspaceId === target.workspaceId && tree.path === target.path);
    if (!live) return { ok: false, error: new HerdfastFailure("Selected worktree is no longer open. Run /hf again.") };
    try {
      if (!live.current) await this.run(["workspace", "focus", live.workspaceId], cwd);
      await this.visit(inventory.value.repoKey, live.path, Math.max(this.now(), ...inventory.value.worktrees.map(tree => tree.visitedAt)) + 1);
      return { ok: true, value: undefined };
    } catch (error) { return herdfastFailure(error); }
  }

  private historyPath(repoKey: string): string { return join(this.historyDirectory, `${createHash("sha256").update(repoKey).digest("hex")}.jsonl`); }

  private async visit(repoKey: string, path: string, time: number): Promise<void> {
    await mkdir(this.historyDirectory, { recursive: true, mode: 0o700 });
    await appendFile(this.historyPath(repoKey), `${JSON.stringify({ path, time })}\n`, { mode: 0o600 });
  }

  private async readVisits(repoKey: string): Promise<Map<string, number>> {
    let content: string;
    try { content = await readFile(this.historyPath(repoKey), "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Map();
      throw error;
    }
    const visits = new Map<string, number>();
    for (const line of content.split("\n").filter(Boolean)) {
      const entry: unknown = JSON.parse(line);
      if (!isHerdfastObject(entry) || typeof entry.path !== "string" || typeof entry.time !== "number" || !Number.isFinite(entry.time) || entry.time < 0) throw new HerdfastFailure("Invalid visit history.");
      visits.set(entry.path, Math.max(visits.get(entry.path) ?? 0, entry.time));
    }
    return visits;
  }

  private async run(args: string[], cwd: string): Promise<object> {
    const response = await this.commands.run(args, cwd);
    if (response.code !== 0) throw new HerdfastFailure(response.stderr.trim() || response.stdout.trim() || "Herdr command failed.");
    const parsed: unknown = JSON.parse(response.stdout);
    if (!isHerdfastObject(parsed) || !isHerdfastObject(parsed.result)) throw new HerdfastFailure("Invalid Herdr response.");
    return parsed.result;
  }
}

function isHerdfastObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function herdfastFailure(error: unknown): HerdfastResult<never> {
  return { ok: false, error: error instanceof HerdfastFailure ? error : new HerdfastFailure(error instanceof Error ? error.message : String(error)) };
}
