/**
 * Typed Effect wrapper over the `herdr` CLI.
 *
 * Every `herdr` subcommand replies with a single JSON envelope on stdout:
 *   success -> {"id":"cli:worktree:list","result":{...}}
 *   failure -> {"id":"...","error":{"code":"not_git_worktree","message":"..."}}
 * so a generic runner plus per-command result types covers the whole surface.
 *
 * Uses Bun.spawn rather than @effect/platform's CommandExecutor deliberately:
 * plugin panes always run under bun, and it keeps this module free of the
 * @effect/platform peer-version skew that @effect-atom/atom already warns about.
 */

import { Context, Data, Effect, Layer } from "effect"

export class HerdrError extends Data.TaggedError("HerdrError")<{
  readonly command: ReadonlyArray<string>
  readonly code: string
  readonly message: string
}> {}

/** Non-zero exit, unparseable output, or a missing binary. */
export class HerdrSpawnError extends Data.TaggedError("HerdrSpawnError")<{
  readonly command: ReadonlyArray<string>
  readonly reason: string
}> {}

export interface WorktreeInfo {
  readonly branch: string | null
  readonly path: string
  readonly label: string
  readonly is_bare: boolean
  readonly is_detached: boolean
  readonly is_linked_worktree: boolean
  readonly is_prunable: boolean
  /** Present only while this worktree is open as a workspace. */
  readonly open_workspace_id?: string
}

export interface WorktreeSourceInfo {
  readonly repo_key: string
  readonly repo_name: string
  readonly repo_root: string
  readonly source_checkout_path: string
  readonly source_workspace_id: string
}

export interface WorktreeList {
  readonly source: WorktreeSourceInfo
  readonly worktrees: ReadonlyArray<WorktreeInfo>
}

export interface WorkspaceWorktree {
  readonly repo_key: string
  readonly repo_name: string
  readonly repo_root: string
  readonly checkout_path: string
  readonly is_linked_worktree: boolean
}

export interface WorkspaceInfo {
  readonly workspace_id: string
  readonly label: string
  readonly number: number
  readonly focused: boolean
  readonly agent_status: string
  readonly pane_count: number
  readonly tab_count: number
  readonly active_tab_id: string
  /**
   * NOT always populated, even for workspaces inside a git repo — observed
   * absent on a repo that definitely has worktrees. Never branch on its
   * absence to decide "this is not a git project"; resolve from cwd instead.
   */
  readonly worktree?: WorkspaceWorktree
}

export interface HerdrClient {
  /** Runs `herdr <args>` and returns the unwrapped `result` payload. */
  readonly run: <A>(args: ReadonlyArray<string>) => Effect.Effect<A, HerdrError | HerdrSpawnError>
  readonly worktreeList: () => Effect.Effect<WorktreeList, HerdrError | HerdrSpawnError>
  readonly worktreeOpen: (
    target: { readonly branch: string } | { readonly path: string },
    options?: { readonly label?: string; readonly focus?: boolean },
  ) => Effect.Effect<unknown, HerdrError | HerdrSpawnError>
  readonly worktreeRemove: (
    workspaceId: string,
    options?: { readonly force?: boolean },
  ) => Effect.Effect<unknown, HerdrError | HerdrSpawnError>
  readonly workspaceList: () => Effect.Effect<
    { readonly workspaces: ReadonlyArray<WorkspaceInfo> },
    HerdrError | HerdrSpawnError
  >
  readonly workspaceFocus: (
    workspaceId: string,
  ) => Effect.Effect<unknown, HerdrError | HerdrSpawnError>
}

export const HerdrClient = Context.GenericTag<HerdrClient>("@heherdr/HerdrClient")

/** herdr injects this into every pane; falls back to PATH lookup. */
const herdrBin = (): string => process.env["HERDR_BIN_PATH"] || "herdr"

const make = (): HerdrClient => {
  const run = <A>(args: ReadonlyArray<string>): Effect.Effect<A, HerdrError | HerdrSpawnError> =>
    Effect.gen(function* () {
      const { exitCode, stderr, stdout } = yield* Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn([herdrBin(), ...args], {
            stdout: "pipe",
            stderr: "pipe",
          })
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ])
          return { stdout, stderr, exitCode }
        },
        catch: (cause) =>
          new HerdrSpawnError({ command: args, reason: `failed to spawn: ${String(cause)}` }),
      })

      const trimmed = stdout.trim()
      if (trimmed === "") {
        return yield* Effect.fail(
          new HerdrSpawnError({
            command: args,
            reason: `no output (exit ${exitCode}): ${stderr.trim() || "<empty stderr>"}`,
          }),
        )
      }

      const parsed = yield* Effect.try({
        try: () => JSON.parse(trimmed) as unknown,
        // Usage text instead of JSON means the args were wrong — surfacing the
        // first line is far more useful than a JSON parse error.
        catch: () =>
          new HerdrSpawnError({
            command: args,
            reason: `non-JSON output: ${trimmed.split("\n")[0] ?? trimmed}`,
          }),
      })

      const envelope = parsed as {
        result?: A
        error?: { code?: string; message?: string }
      }
      if (envelope.error !== undefined) {
        return yield* Effect.fail(
          new HerdrError({
            command: args,
            code: envelope.error.code ?? "unknown",
            message: envelope.error.message ?? "unknown herdr error",
          }),
        )
      }
      if (envelope.result === undefined) {
        return yield* Effect.fail(
          new HerdrSpawnError({ command: args, reason: "envelope had neither result nor error" }),
        )
      }
      return envelope.result
    })

  return {
    run,
    worktreeList: () => run<WorktreeList>(["worktree", "list"]),
    worktreeOpen: (target, options) => {
      const args = ["worktree", "open"]
      if ("branch" in target) args.push("--branch", target.branch)
      else args.push("--path", target.path)
      if (options?.label) args.push("--label", options.label)
      args.push(options?.focus === false ? "--no-focus" : "--focus")
      return run(args)
    },
    worktreeRemove: (workspaceId, options) => {
      const args = ["worktree", "remove", "--workspace", workspaceId]
      if (options?.force) args.push("--force")
      return run(args)
    },
    workspaceList: () => run(["workspace", "list"]),
    workspaceFocus: (workspaceId) => run(["workspace", "focus", workspaceId]),
  }
}

export const layer = Layer.sync(HerdrClient, make)
