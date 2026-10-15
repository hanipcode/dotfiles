import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { MoverFailure, parseMoverWorktrees, sortMoverWorktrees, type MoverResult, type MoverWorktree } from "./mover-domain.ts";

/** Argument-safe executable boundary used by Git and Herdr operations. */
export interface MoverCommands {
  run(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Inventory is repo-local even though visit history is shared across Pi processes. */
export type MoverInventory = { readonly root: string; readonly currentPath: string; readonly worktrees: ReadonlyArray<MoverWorktree> };

/** Git worktree operations for standard clones and bare repositories; no conversion required. */
export class MoverWorktrees {
  constructor(private readonly commands: MoverCommands, private readonly historyDirectory: string) {}

  /** Record visits by append-only per-path logs to avoid cross-pane lost updates. */
  async visit(path: string): Promise<MoverResult<void>> {
    try {
      const canonicalPath = await realpath(path);
      await mkdir(this.historyDirectory, { recursive: true, mode: 0o700 });
      await appendFile(this.historyPath(canonicalPath), `${JSON.stringify({ path: canonicalPath, time: Date.now() })}\n`, { mode: 0o600 });
      return { ok: true, value: undefined };
    } catch (error) { return this.failure(error); }
  }

  /** List only the current repository's linked worktrees, sorted by actual Pi visits. */
  async list(cwd: string): Promise<MoverResult<MoverInventory>> {
    try {
      const listed = await this.commands.run("git", ["worktree", "list", "--porcelain", "-z"], cwd);
      if (listed.code !== 0) return this.commandFailure(listed);
      const parsed = parseMoverWorktrees(listed.stdout);
      if (!parsed.ok) return parsed;
      const primary = parsed.value[0];
      if (!primary) return { ok: false, error: new MoverFailure("No worktrees found in this repository.") };
      const current = await this.commands.run("git", ["rev-parse", "--show-toplevel"], cwd);
      const currentPath = current.code === 0 ? await realpath(current.stdout.trim()) : await realpath(cwd);
      const worktrees = await Promise.all(parsed.value.map(async tree => {
        const path = await realpath(tree.path).catch(() => resolve(tree.path));
        return { ...tree, path, lastVisited: await this.lastVisit(path) };
      }));
      return { ok: true, value: { root: primary.path, currentPath, worktrees: sortMoverWorktrees(worktrees) } };
    } catch (error) { return this.failure(error); }
  }

  /** Always create from refreshed origin/main, or local main only when the remote ref is absent. */
  async create(cwd: string, name: string): Promise<MoverResult<string>> {
    try {
      const branch = name.trim();
      if (!branch || branch.startsWith("-")) return { ok: false, error: new MoverFailure("Enter a valid branch name.") };
      const valid = await this.commands.run("git", ["check-ref-format", "--branch", branch], cwd);
      if (valid.code !== 0) return this.commandFailure(valid);
      const inventory = await this.list(cwd);
      if (!inventory.ok) return inventory;
      const existing = await this.commands.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
      if (existing.code === 0) return { ok: false, error: new MoverFailure(`Branch ${branch} already exists. Choose a new name or select its checkout.`) };
      if (existing.code !== 1) return this.commandFailure(existing);
      const remote = await this.commands.run("git", ["remote", "get-url", "origin"], cwd);
      let hasRemoteMain = false;
      if (remote.code === 0) {
        const advertised = await this.commands.run("git", ["ls-remote", "--exit-code", "--heads", "origin", "refs/heads/main"], cwd);
        if (advertised.code === 0) {
          const fetched = await this.commands.run("git", ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], cwd);
          if (fetched.code !== 0) return this.commandFailure(fetched);
          hasRemoteMain = true;
        } else if (advertised.code !== 2) return this.commandFailure(advertised);
      } else if (remote.code !== 2) return this.commandFailure(remote);
      const remoteMain = hasRemoteMain
        ? await this.commands.run("git", ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], cwd)
        : { code: 1, stdout: "", stderr: "" };
      let base = "refs/remotes/origin/main";
      if (remoteMain.code !== 0) {
        if (remoteMain.code !== 1) return this.commandFailure(remoteMain);
        const localMain = await this.commands.run("git", ["show-ref", "--verify", "--quiet", "refs/heads/main"], cwd);
        if (localMain.code !== 0) return { ok: false, error: new MoverFailure("Neither origin/main nor local main exists; no worktree created.") };
        base = "refs/heads/main";
      }
      const primary = inventory.value.root;
      const path = join(dirname(primary), `${basename(primary)}-worktrees`, branch.replaceAll("/", "--"));
      const added = await this.commands.run("git", ["worktree", "add", "--no-track", "-b", branch, "--", path, base], cwd);
      if (added.code !== 0) return this.commandFailure(added);
      return { ok: true, value: await realpath(path) };
    } catch (error) { return this.failure(error); }
  }

  /** Remove clean, unlocked, non-current linked checkouts without deleting their branches. */
  async remove(cwd: string, path: string): Promise<MoverResult<void>> {
    try {
      const inventory = await this.list(cwd);
      if (!inventory.ok) return inventory;
      const targetPath = await realpath(path);
      const target = inventory.value.worktrees.find(tree => tree.path === targetPath);
      if (!target || target.bare) return { ok: false, error: new MoverFailure("Select a linked worktree from this repository.") };
      if (targetPath === inventory.value.currentPath || resolve(cwd).startsWith(`${targetPath}${sep}`)) return { ok: false, error: new MoverFailure("Cannot delete the current worktree.") };
      if (target.locked) return { ok: false, error: new MoverFailure("Cannot delete a locked worktree.") };
      const status = await this.commands.run("git", ["status", "--porcelain=v1", "--untracked-files=all"], targetPath);
      if (status.code !== 0) return this.commandFailure(status);
      if (status.stdout.trim()) return { ok: false, error: new MoverFailure("Worktree has uncommitted or untracked changes. Commit or stash first.") };
      const removed = await this.commands.run("git", ["worktree", "remove", "--", targetPath], cwd);
      if (removed.code !== 0) return this.commandFailure(removed);
      return { ok: true, value: undefined };
    } catch (error) { return this.failure(error); }
  }

  private historyPath(path: string) { return join(this.historyDirectory, `${createHash("sha256").update(path).digest("hex")}.jsonl`); }

  private async lastVisit(path: string) {
    let contents: string;
    try { contents = await readFile(this.historyPath(path), "utf8"); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    let time: number | null = null;
    for (const line of contents.split("\n").filter(Boolean)) {
      const record: unknown = JSON.parse(line);
      if (typeof record !== "object" || record === null || !("path" in record) || record.path !== path || !("time" in record) || typeof record.time !== "number" || !Number.isFinite(record.time)) throw new MoverFailure("Invalid visit history; no recency guesses made.");
      time = Math.max(time ?? 0, record.time);
    }
    return time;
  }

  private commandFailure(result: { stderr: string; stdout: string; code: number }): MoverResult<never> {
    return { ok: false, error: new MoverFailure(result.stderr.trim() || result.stdout.trim() || `Command failed (${result.code}).`) };
  }

  private failure(error: unknown): MoverResult<never> {
    return { ok: false, error: error instanceof MoverFailure ? error : new MoverFailure(error instanceof Error ? error.message : String(error)) };
  }
}
