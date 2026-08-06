import { Command } from "@effect/cli"
import { Console, Effect, Runtime } from "effect"
import {
  GhStackClient,
  HerdrClient,
  PluginContext,
  runApp,
} from "@heherdr/framework"
import { StackUi, type StackNavigatorAction } from "./Ui.tsx"
import { buildStackNavigatorData } from "./model.ts"

const handler = Effect.gen(function* () {
  const herdr = yield* HerdrClient.HerdrClient
  const ghStack = yield* GhStackClient.GhStackClient
  const context = yield* PluginContext.PluginContext
  const runtime = yield* Effect.runtime<never>()
  const runPromise = Runtime.runPromise(runtime)

  const loadData = Effect.gen(function* () {
    const worktrees = yield* herdr.worktreeList({ cwd: context.projectDir })
    const catalog = yield* ghStack.load({
      projectDir: context.projectDir,
      repoRoot: worktrees.source.repo_root,
      checkoutPaths: worktrees.worktrees.map((worktree) => worktree.path),
    })
    return buildStackNavigatorData(catalog, worktrees)
  })

  const initial = yield* loadData
  let chosen: StackNavigatorAction | undefined

  yield* runApp(
    <StackUi
      data={initial}
      onAction={(action) => {
        chosen = action
      }}
      onRefresh={() => runPromise(loadData)}
    />,
  )

  if (chosen === undefined) return
  const row = chosen.row
  if (chosen.type === "create") {
    yield* herdr.worktreeCreate(row.branch, { cwd: initial.repoRoot, focus: true })
  } else if (row.worktree?.open_workspace_id !== undefined) {
    yield* herdr.workspaceFocus(row.worktree.open_workspace_id)
  } else if (row.worktree !== null) {
    yield* herdr.worktreeOpen(
      { path: row.worktree.path },
      { cwd: initial.repoRoot, focus: true },
    )
  }
}).pipe(
  Effect.catchTags({
    GhStackError: (error) => Console.error(`heherdr stack: ${error.reason}`),
    HerdrError: (error) => Console.error(`heherdr stack: ${error.code}: ${error.message}`),
    HerdrSpawnError: (error) => Console.error(`heherdr stack: ${error.reason}`),
    RenderError: (error) => Console.error(`heherdr stack: render failed: ${error.reason}`),
  }),
)

export const stackCommand = Command.make("stack").pipe(
  Command.withDescription("Navigate worktrees in the current gh-stack"),
  Command.withHandler(() => handler),
)
