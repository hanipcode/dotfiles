/**
 * Git helpers for things herdr does not expose.
 *
 * herdr's worktree list reports `is_prunable` but NOT `locked`, and nothing about
 * merge state or dirtiness — yet those are exactly the signals that decide
 * whether removing a worktree is safe. This module fills that gap.
 */

import { Context, Data, Effect, Layer } from "effect"

export class GitError extends Data.TaggedError("GitError")<{
  readonly command: ReadonlyArray<string>
  readonly reason: string
}> {}

export interface GitWorktree {
  readonly path: string
  readonly branch: string | null
  readonly head: string
  /**
   * `git worktree remove` refuses a locked worktree outright — `--force` alone
   * does NOT override it, you must `unlock` first.
   */
  readonly locked: boolean
  readonly lockReason: string | null
  readonly detached: boolean
}

export interface WorktreeSafety {
  /** Uncommitted changes in the checkout — work that removal would destroy. */
  readonly dirtyFiles: number
  /**
   * Commits reachable from this branch but not the default branch.
   *
   * INFORMATIONAL ONLY — it does not mean "would be lost". A worktree cut from a
   * feature branch inherits that branch's unmerged commits, so a freshly created
   * worktree with zero commits of its own still reports a non-zero count. Use
   * `pushedTo` to decide whether removal is destructive.
   */
  readonly unmergedCommits: number
  /**
   * A remote-tracking ref that contains this branch's tip, or null when the tip
   * exists nowhere but locally. This is the real "would I lose commits" signal:
   * if some remote has the tip, the commits survive removing the checkout.
   */
  readonly pushedTo: string | null
  readonly locked: boolean
  readonly lockReason: string | null
}

export interface GitClient {
  readonly worktrees: (repoRoot: string) => Effect.Effect<ReadonlyArray<GitWorktree>, GitError>
  readonly safety: (
    repoRoot: string,
    worktreePath: string,
    branch: string | null,
  ) => Effect.Effect<WorktreeSafety, GitError>
  readonly removeWorktree: (
    repoRoot: string,
    worktreePath: string,
    options?: { readonly force?: boolean },
  ) => Effect.Effect<void, GitError>
  readonly unlockWorktree: (
    repoRoot: string,
    worktreePath: string,
  ) => Effect.Effect<void, GitError>
  readonly deleteBranch: (
    repoRoot: string,
    branch: string,
    options?: { readonly force?: boolean },
  ) => Effect.Effect<void, GitError>
}

export const GitClient = Context.GenericTag<GitClient>("@heherdr/GitClient")

interface Output {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const spawn = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<Output, GitError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, exitCode }
    },
    catch: (cause) => new GitError({ command: args, reason: String(cause) }),
  })

/** Runs a command that must succeed; git's stderr is the useful message. */
const check = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, GitError> =>
  Effect.flatMap(spawn(cwd, args), (out) =>
    out.exitCode === 0
      ? Effect.succeed(out.stdout)
      : Effect.fail(
          new GitError({
            command: args,
            reason: out.stderr.trim() || out.stdout.trim() || `git exited ${out.exitCode}`,
          }),
        ),
  )

/** Accumulator for the porcelain parse — GitWorktree's fields are readonly. */
interface PartialWorktree {
  path?: string
  branch?: string | null
  head?: string
  locked?: boolean
  lockReason?: string | null
  detached?: boolean
}

const parsePorcelain = (stdout: string): ReadonlyArray<GitWorktree> => {
  const trees: Array<GitWorktree> = []
  let current: PartialWorktree = {}

  const flush = () => {
    if (current.path !== undefined) {
      trees.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head ?? "",
        locked: current.locked ?? false,
        lockReason: current.lockReason ?? null,
        detached: current.detached ?? false,
      })
    }
    current = {}
  }

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush()
      current.path = line.slice("worktree ".length)
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length)
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "")
    } else if (line === "detached") {
      current.detached = true
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true
      const reason = line.slice("locked".length).trim()
      current.lockReason = reason === "" ? null : reason
    }
  }
  flush()
  return trees
}

const make = (): GitClient => ({
  worktrees: (repoRoot) =>
    Effect.map(check(repoRoot, ["worktree", "list", "--porcelain"]), parsePorcelain),

  safety: (repoRoot, worktreePath, branch) =>
    Effect.gen(function* () {
      const locked = yield* Effect.map(
        check(repoRoot, ["worktree", "list", "--porcelain"]),
        (out) => parsePorcelain(out).find((w) => w.path === worktreePath),
      )

      // A missing checkout dir is not fatal here — report it as clean and let
      // the removal itself surface the real problem.
      const status = yield* Effect.orElseSucceed(
        check(worktreePath, ["status", "--porcelain"]),
        () => "",
      )
      const dirtyFiles = status.split("\n").filter((l) => l.trim() !== "").length

      const defaultBranch = yield* Effect.orElseSucceed(
        Effect.map(check(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]), (s) =>
          s.trim(),
        ),
        () => "origin/main",
      )

      const unmergedCommits =
        branch === null
          ? 0
          : yield* Effect.orElseSucceed(
              Effect.map(
                check(repoRoot, ["rev-list", "--count", branch, `^${defaultBranch}`]),
                (s) => Number.parseInt(s.trim(), 10) || 0,
              ),
              () => 0,
            )

      // Ask git directly whether any remote-tracking ref contains the tip.
      // `rev-list --not --exclude=… --branches` looks like the natural way to
      // compute "commits only on this branch", but --exclude did not take effect
      // on git 2.39 (it subtracted the branch from itself and always returned 0),
      // and enumerating every ref by hand is slow on repos with hundreds of
      // branches. --contains against refs/remotes is one cheap, unambiguous query.
      const pushedTo =
        branch === null
          ? null
          : yield* Effect.orElseSucceed(
              Effect.map(
                check(repoRoot, [
                  "for-each-ref",
                  "--contains",
                  branch,
                  "--format=%(refname:short)",
                  "--count=1",
                  "refs/remotes",
                ]),
                (out) => {
                  const first = out.trim()
                  return first === "" ? null : first
                },
              ),
              () => null,
            )

      return {
        dirtyFiles,
        unmergedCommits,
        pushedTo,
        locked: locked?.locked ?? false,
        lockReason: locked?.lockReason ?? null,
      }
    }),

  removeWorktree: (repoRoot, worktreePath, options) =>
    Effect.asVoid(
      check(repoRoot, [
        "worktree",
        "remove",
        ...(options?.force === true ? ["--force"] : []),
        worktreePath,
      ]),
    ),

  unlockWorktree: (repoRoot, worktreePath) =>
    Effect.asVoid(check(repoRoot, ["worktree", "unlock", worktreePath])),

  deleteBranch: (repoRoot, branch, options) =>
    Effect.asVoid(check(repoRoot, ["branch", options?.force === true ? "-D" : "-d", branch])),
})

export const layer = Layer.sync(GitClient, make)
