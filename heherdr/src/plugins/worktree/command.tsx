/**
 * `heherdr worktree` — project-wise worktree management.
 *
 * Every plugin follows this shape: gather data through the framework's clients,
 * hand the UI plain data plus async callbacks, and keep Effect out of the React
 * tree. The service methods are closures with no remaining requirements, so they
 * can be `runPromise`d straight from a UI callback.
 */

import { Command } from "@effect/cli"
import { Console, Effect, Exit } from "effect"
import { GitClient, HerdrClient, runApp } from "@heherdr/framework"
import type {
  HerdrError,
  HerdrSpawnError,
  WorktreeInfo,
} from "@heherdr/framework/herdr/Client.ts"
import type { GitError } from "@heherdr/framework/git/Client.ts"
import { WorktreeUi, type RemoveOutcome } from "./Ui.tsx"

const handler = Effect.gen(function* () {
  const herdr = yield* HerdrClient.HerdrClient
  const git = yield* GitClient.GitClient

  const initial = yield* herdr.worktreeList()
  const repoRoot = initial.source.repo_root

  let chosen: WorktreeInfo | undefined

  const remove = async (worktree: WorktreeInfo, force: boolean): Promise<RemoveOutcome> => {
    // A locked checkout is refused by `git worktree remove` even with --force,
    // so forcing has to unlock first. Failure here is non-fatal: the removal
    // below will report the real reason.
    if (force) {
      await Effect.runPromiseExit(git.unlockWorktree(repoRoot, worktree.path))
    }

    // herdr can only remove a worktree it holds open as a workspace; anything
    // else has to go through git directly. Annotated because the two branches
    // have different error types and TS will not widen the union on its own.
    const effect: Effect.Effect<unknown, HerdrError | HerdrSpawnError | GitError> =
      worktree.open_workspace_id === undefined
        ? git.removeWorktree(repoRoot, worktree.path, { force })
        : herdr.worktreeRemove(worktree.open_workspace_id, { force })

    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) {
      return { ok: true, message: `removed ${worktree.branch ?? worktree.path}` }
    }

    const error = Exit.causeOption(exit)
    const reason = error._tag === "Some" ? String(error.value) : "unknown error"
    const hint = reason.includes("locked")
      ? " — locked, press Y to unlock and force"
      : reason.includes("modified or untracked")
        ? " — has uncommitted changes, press Y to force"
        : ""
    return { ok: false, message: `${reason.split("\n")[0] ?? reason}${hint}` }
  }

  yield* runApp(
    <WorktreeUi
      data={initial}
      onOpen={(worktree) => {
        chosen = worktree
      }}
      onInspect={async (worktree) => {
        // A failed inspection must not reject into React — degrade to "unknown"
        // and let the removal itself report the real problem.
        const exit = await Effect.runPromiseExit(
          git.safety(repoRoot, worktree.path, worktree.branch),
        )
        return Exit.isSuccess(exit)
          ? exit.value
          : { dirtyFiles: 0, unmergedCommits: 0, pushedTo: null, locked: false, lockReason: null }
      }}
      onRemove={remove}
      onRefresh={() => Effect.runPromise(herdr.worktreeList())}
    />,
  )

  if (chosen === undefined) return

  // Acting after teardown keeps herdr's focus change from fighting the
  // alternate screen we were just drawing into.
  if (chosen.open_workspace_id !== undefined) {
    yield* herdr.workspaceFocus(chosen.open_workspace_id)
  } else {
    yield* herdr.worktreeOpen({ path: chosen.path }, { focus: true })
  }
}).pipe(
  Effect.catchTags({
    HerdrError: (error) =>
      error.code === "not_git_worktree"
        ? Console.error("heherdr worktree: run this from a workspace inside a git repository.")
        : Console.error(`heherdr worktree: ${error.code}: ${error.message}`),
    HerdrSpawnError: (error) => Console.error(`heherdr worktree: ${error.reason}`),
    RenderError: (error) => Console.error(`heherdr worktree: render failed: ${error.reason}`),
  }),
)

export const worktreeCommand = Command.make("worktree").pipe(
  Command.withDescription("Manage this project's git worktrees"),
  Command.withHandler(() => handler),
)
