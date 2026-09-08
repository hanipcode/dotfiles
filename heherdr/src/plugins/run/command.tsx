import { Command } from "@effect/cli"
import { Console, Data, Effect } from "effect"
import { fileURLToPath } from "node:url"
import { HerdrClient, PluginContext, runApp } from "@heherdr/framework"
import { WorktreeSelectorUi } from "./Ui.tsx"

class ShellStartError extends Data.TaggedError("ShellStartError")<{
  readonly cwd: string
  readonly reason: string
}> {}

const runShell = (cwd: string): Effect.Effect<void, ShellStartError> =>
  Effect.tryPromise({
    try: async () => {
      const shell = process.env["SHELL"] || "/bin/sh"
      const stdio = {
        cwd,
        stdin: "inherit" as const,
        stdout: "inherit" as const,
        stderr: "inherit" as const,
      }
      // Herdr cannot see ctrl+q while a popup owns terminal input, so this
      // persistent Zsh binds ctrl+q to exit itself instead.
      const shellProcess = Bun.spawn([shell, "-i"], {
        ...stdio,
        ...(shell.split("/").at(-1) === "zsh"
          ? {
              env: {
                ...process.env,
                HEHERDR_USER_ZDOTDIR: process.env["ZDOTDIR"] || process.env["HOME"] || "",
                ZDOTDIR: fileURLToPath(new URL("./shell/zsh", import.meta.url)),
              },
            }
          : {}),
      })
      await shellProcess.exited
    },
    catch: (cause) =>
      new ShellStartError({
        cwd,
        reason: `could not start the command shell: ${String(cause)}`,
      }),
  })

const handler = (selectWorktree: boolean) =>
  Effect.gen(function* () {
    const context = yield* PluginContext.PluginContext

    if (!selectWorktree) {
      yield* runShell(context.projectDir)
      return
    }

    const herdr = yield* HerdrClient.HerdrClient
    const worktreeList = yield* herdr.worktreeList({ cwd: context.projectDir })
    const currentPath = worktreeList.source.source_checkout_path
    let selectedPath: string | undefined

    yield* runApp(
      <WorktreeSelectorUi
        currentPath={currentPath}
        worktrees={worktreeList.worktrees}
        onSelect={(cwd) => {
          selectedPath = cwd
        }}
      />,
    )

    if (selectedPath === undefined) return
    yield* runShell(selectedPath)
  }).pipe(
    Effect.catchTags({
      HerdrError: (error) => Console.error(`heherdr run: ${error.code}: ${error.message}`),
      HerdrSpawnError: (error) => Console.error(`heherdr run: ${error.reason}`),
      RenderError: (error) => Console.error(`heherdr run: render failed: ${error.reason}`),
      ShellStartError: (error) => Console.error(`heherdr run: ${error.reason} in ${error.cwd}`),
    }),
  )

/** Opens a floating terminal rooted in the current worktree. */
export const runCommand = Command.make("run").pipe(
  Command.withDescription("Open a terminal in the current worktree"),
  Command.withHandler(() => handler(false)),
)

/** Selects a project worktree, then opens a floating terminal there. */
export const runWorktreeCommand = Command.make("run-worktree").pipe(
  Command.withDescription("Open a terminal in a selected worktree"),
  Command.withHandler(() => handler(true)),
)
