import { Context, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import type { ProjectContext, SourceRef, StackBranch } from "../domain.ts"
import { RunboxError } from "../errors.ts"
import { Shell } from "./Shell.ts"

const GhStackBranch = Schema.Struct({
  name: Schema.String,
  head: Schema.String,
  base: Schema.String,
  isMerged: Schema.Boolean,
  isQueued: Schema.Boolean,
  needsRebase: Schema.Boolean,
})

const GhStackView = Schema.Struct({
  trunk: Schema.String,
  currentBranch: Schema.String,
  branches: Schema.Array(GhStackBranch),
})

interface WorktreeBranch {
  readonly path: string
  readonly branch: string | null
}

export const parseWorktrees = (output: string): ReadonlyArray<WorktreeBranch> =>
  output.trim().split("\n\n").flatMap((block) => {
    const lines = block.split("\n")
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
    if (path === undefined) return []
    const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length)
    return [{ path, branch: ref?.replace(/^refs\/heads\//, "") ?? null }]
  })

export const stackFingerprint = (
  trunk: string,
  currentBranch: string,
  branches: ReadonlyArray<StackBranch>,
): string => createHash("sha256")
  .update(JSON.stringify({ trunk, currentBranch, branches }))
  .digest("hex")
  .slice(0, 16)

export class GhStack extends Context.Tag("@runbox/GhStack")<
  GhStack,
  {
    readonly resolveTop: (project: ProjectContext) => Effect.Effect<SourceRef, RunboxError>
  }
>() {
  static readonly layer = Layer.effect(
    GhStack,
    Effect.gen(function* () {
      const shell = yield* Shell

      const resolveTop = Effect.fn("GhStack.resolveTop")(function* (project: ProjectContext) {
        const executable = process.env.RUNBOX_GH_BIN ?? "gh"
        const result = yield* shell.run([executable, "stack", "view", "--json"], {
          cwd: project.repoRoot,
          allowFailure: true,
        }).pipe(
          Effect.mapError((error) =>
            new RunboxError({ operation: "inspect gh stack", message: error.stderr }),
          ),
        )
        if (result.exitCode !== 0) {
          const reason = result.stderr.trim() || result.stdout.trim()
          return yield* new RunboxError({
            operation: "inspect gh stack",
            message: reason === ""
              ? "gh-stack is unavailable or the current branch is not in a stack"
              : reason,
          })
        }
        const json = yield* Effect.try({
          try: () => JSON.parse(result.stdout) as unknown,
          catch: (cause) =>
            new RunboxError({ operation: "parse gh stack", message: String(cause) }),
        })
        const view = yield* Schema.decodeUnknown(GhStackView)(json).pipe(
          Effect.mapError((cause) =>
            new RunboxError({ operation: "validate gh stack", message: String(cause) }),
          ),
        )
        const active = view.branches.filter((branch) => !branch.isMerged)
        const top = active.at(-1)
        if (top === undefined) {
          return yield* new RunboxError({
            operation: "resolve stack top",
            message: "every branch in this stack is already merged",
          })
        }
        const stale = active.filter((branch) => branch.needsRebase)
        if (stale.length > 0) {
          return yield* new RunboxError({
            operation: "resolve stack top",
            message: `stack needs rebasing: ${stale.map((branch) => branch.name).join(", ")}; run 'gh stack rebase' first`,
          })
        }

        const worktreeResult = yield* shell.run(["git", "worktree", "list", "--porcelain"], {
          cwd: project.repoRoot,
        }).pipe(
          Effect.mapError((error) =>
            new RunboxError({ operation: "list stack worktrees", message: error.stderr }),
          ),
        )
        const worktrees = parseWorktrees(worktreeResult.stdout)
        const byBranch = new Map(
          worktrees.flatMap((worktree) =>
            worktree.branch === null ? [] : [[worktree.branch, worktree.path] as const],
          ),
        )
        const dirty: Array<string> = []
        for (const branch of view.branches) {
          const path = byBranch.get(branch.name)
          if (path === undefined) continue
          const head = yield* shell.run(["git", "rev-parse", "HEAD"], { cwd: path }).pipe(
            Effect.mapError((error) =>
              new RunboxError({ operation: `inspect ${branch.name} HEAD`, message: error.stderr }),
            ),
          )
          if (head.stdout.trim() !== branch.head) {
            return yield* new RunboxError({
              operation: "resolve stack top",
              message: `gh-stack metadata for ${branch.name} is stale; run 'gh stack view --json' and repair the stack first`,
            })
          }
          const status = yield* shell.run(["git", "status", "--short", "--untracked-files=all"], {
            cwd: path,
          }).pipe(
            Effect.mapError((error) =>
              new RunboxError({ operation: `inspect ${branch.name}`, message: error.stderr }),
            ),
          )
          if (status.stdout.trim() !== "") dirty.push(`${branch.name} (${path})`)
        }
        if (dirty.length > 0) {
          return yield* new RunboxError({
            operation: "resolve stack top",
            message: `stack worktrees are dirty: ${dirty.join(", ")}; commit them and rebase the stack first`,
          })
        }

        const branches: ReadonlyArray<StackBranch> = view.branches.map((branch) => ({
          ...branch,
          worktreePath: byBranch.get(branch.name) ?? null,
        }))
        return {
          kind: "stack" as const,
          worktreePath: byBranch.get(top.name) ?? null,
          branch: top.name,
          commit: top.head,
          stack: {
            trunk: view.trunk,
            currentBranch: view.currentBranch,
            topBranch: top.name,
            fingerprint: stackFingerprint(view.trunk, view.currentBranch, branches),
            branches,
          },
        }
      })

      return GhStack.of({ resolveTop })
    }),
  )
}
