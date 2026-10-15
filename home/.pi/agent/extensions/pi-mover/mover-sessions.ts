import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MoverFailure, type MoverResult } from "./mover-domain.ts";

/** Move keeps the session identity; fork creates an independent conversation. */
export type MoverSessionMode = "move" | "fork";

/** Prepared sessions preserve the selected branch and include a destination-specific working directory. */
export type MoverPreparedSession = { readonly path: string; readonly source: string | undefined; readonly goal: MoverSessionMode };

/** Move or fork saved conversations; create a destination session for unsaved setup-only sessions. */
export async function prepareMoverSession(input: {
  readonly source: string;
  readonly targetCwd: string;
  readonly leafId: string | null;
  readonly mode?: MoverSessionMode;
  readonly sessionDirectory?: string;
  readonly currentSession?: Pick<SessionManager, "getEntries" | "getHeader">;
}): Promise<MoverResult<MoverPreparedSession>> {
  let stagedPath: string | undefined;
  try {
    let content: string | undefined;
    try { content = await readFile(input.source, "utf8"); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (!input.currentSession || input.currentSession.getEntries().some(entry =>
        entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")
      )) throw new MoverFailure("Source session file is missing; cannot safely recover an existing conversation.");
    }
    const source = content === undefined ? undefined : input.source;
    let manager: SessionManager;
    let path: string;
    if (content === undefined) {
      const fresh = SessionManager.create(input.targetCwd, input.sessionDirectory);
      const file = fresh.getSessionFile();
      const header = fresh.getHeader();
      if (!file || !header) throw new MoverFailure("Destination session could not be created.");
      path = file;
      await mkdir(fresh.getSessionDir(), { recursive: true, mode: 0o700 });
      // Setup entries exist only in memory before the first prompt. Preserve them without inventing a chat message.
      await writeFile(path, [header, ...(input.currentSession?.getEntries() ?? [])].map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
      stagedPath = path;
      manager = SessionManager.open(path);
    } else if (input.mode === "fork") {
      manager = SessionManager.forkFrom(input.source, input.targetCwd, input.sessionDirectory);
      const file = manager.getSessionFile();
      if (!file) throw new MoverFailure("Fork did not create a persistent session.");
      path = file;
      stagedPath = path;
    } else {
      const newline = content.indexOf("\n");
      if (newline < 0) throw new MoverFailure("Session file has no JSONL header.");
      const header: unknown = JSON.parse(content.slice(0, newline));
      if (typeof header !== "object" || header === null || !("type" in header) || header.type !== "session" || !("id" in header) || typeof header.id !== "string") throw new MoverFailure("Session file has an invalid header.");
      const directory = input.sessionDirectory ?? SessionManager.create(input.targetCwd).getSessionDir();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      path = join(directory, basename(input.source));
      if (resolve(path) === resolve(input.source)) {
        // Opening a new Herdr workspace can keep the same cwd. Stage separately so cancellation never edits the live file.
        path = join(directory, `${basename(input.source, ".jsonl")}.mover-${randomUUID()}.jsonl`);
      }
      await writeFile(path, `${JSON.stringify({ ...header, cwd: resolve(input.targetCwd) })}\n${content.slice(newline + 1)}`, { flag: "wx", mode: 0o600 });
      stagedPath = path;
      manager = SessionManager.open(path);
    }
    if (input.leafId === null) manager.resetLeaf();
    else {
      if (!manager.getEntry(input.leafId)) throw new MoverFailure("Selected session branch was not persisted; cannot move it safely.");
      manager.branch(input.leafId);
    }
    // A persisted child of the selected leaf survives reopening, including when an abandoned branch was written last.
    manager.appendCustomEntry("pi-mover-checkpoint", { source: input.source, mode: input.mode ?? "move", cwd: resolve(input.targetCwd) });
    return { ok: true, value: { path, source, goal: input.mode ?? "move" } };
  } catch (error) {
    let cleanup = "";
    if (stagedPath) {
      try { await rm(stagedPath); }
      catch { cleanup = ` Staged file retained for recovery: ${stagedPath}`; }
    }
    if (error instanceof MoverFailure && !cleanup) return { ok: false, error };
    return { ok: false, error: new MoverFailure(`${error instanceof Error ? error.message : String(error)}${cleanup}`) };
  }
}

/** Archive the old location only after successful runtime replacement; backups are not resume-picker sessions. */
export async function archiveMoverSource(source: string, backupDirectory: string): Promise<MoverResult<string>> {
  try {
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const backup = join(backupDirectory, `${basename(source)}.${randomUUID()}.bak`);
    await rename(source, backup);
    return { ok: true, value: backup };
  } catch (error) { return { ok: false, error: new MoverFailure(`New session is running, but the old file could not be archived: ${error instanceof Error ? error.message : String(error)}`) }; }
}
