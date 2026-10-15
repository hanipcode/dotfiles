/** A linked checkout and the last time Pi Mover visited it (epoch milliseconds). */
export type MoverWorktree = {
  readonly path: string;
  readonly branch: string | null;
  readonly locked: boolean;
  readonly bare: boolean;
  readonly lastVisited: number | null;
};

/** Expected mover errors are surfaced without hiding Git or filesystem failures. */
export class MoverFailure extends Error {
  readonly _tag = "MoverFailure";
  constructor(message: string) { super(`Pi Mover: ${message}`); }
}

/** Mover operations return explicit failures at the Pi command boundary. */
export type MoverResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: MoverFailure };

/** Parse NUL-delimited Git worktree output, preserving missing lock fields. */
export function parseMoverWorktrees(output: string): MoverResult<ReadonlyArray<MoverWorktree>> {
  const records: MoverWorktree[] = [];
  for (const record of output.split("\0\0")) {
    const fields = record.split("\0").filter(Boolean);
    if (!fields.length) continue;
    const path = fields.find(field => field.startsWith("worktree "))?.slice(9);
    if (!path) return { ok: false, error: new MoverFailure("Git returned a worktree without a path.") };
    records.push({
      path,
      branch: fields.find(field => field.startsWith("branch refs/heads/"))?.slice(18) ?? null,
      locked: fields.some(field => field === "locked" || field.startsWith("locked ")),
      bare: fields.includes("bare"),
      lastVisited: null,
    });
  }

  return { ok: true, value: records };
}

/** Search by path or branch without changing most-recent-first ordering. */
export function filterMoverWorktrees(worktrees: ReadonlyArray<MoverWorktree>, query: string): ReadonlyArray<MoverWorktree> {
  const search = query.trim().toLowerCase();
  return worktrees.filter(item => !item.bare && `${item.path} ${item.branch ?? ""}`.toLowerCase().includes(search));
}

/** Sort visited worktrees first; use path order only for ties or unvisited rows. */
export function sortMoverWorktrees(worktrees: ReadonlyArray<MoverWorktree>): ReadonlyArray<MoverWorktree> {
  return [...worktrees].sort((a, b) => (b.lastVisited ?? -1) - (a.lastVisited ?? -1) || a.path.localeCompare(b.path));
}

/** Format visit recency without presenting unknown times as filesystem activity. */
export function formatMoverRecency(lastVisited: number | null, now: number): string {
  if (lastVisited === null) return "not visited";
  const minutes = Math.floor(Math.max(0, now - lastVisited) / 60_000);
  if (minutes === 0) return "today";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
