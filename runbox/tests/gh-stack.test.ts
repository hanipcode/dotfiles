import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { ProjectContext } from "../src/domain.ts"
import { GhStack } from "../src/services/GhStack.ts"
import { Shell, type CommandOutput } from "../src/services/Shell.ts"

const project: ProjectContext = {
  repoId: "repo",
  repoRoot: "/repo",
  commonDir: "/repo/.git",
  packageDir: "/repo",
  packagePath: "",
  packageJsonPath: "/repo/package.json",
  branch: "api",
  commit: "bbb",
}

const stackJson = (needsRebase = false) => JSON.stringify({
  trunk: "main",
  currentBranch: "api",
  branches: [
    { name: "auth", head: "aaa", base: "000", isMerged: false, isQueued: false, needsRebase: false },
    { name: "api", head: "bbb", base: "aaa", isMerged: false, isQueued: false, needsRebase },
    { name: "ui", head: "ccc", base: "bbb", isMerged: false, isQueued: true, needsRebase: false },
  ],
})

const layer = (options: { readonly dirty?: boolean; readonly needsRebase?: boolean } = {}) => {
  const shell = Layer.succeed(Shell, Shell.of({
    run: (command, runOptions): Effect.Effect<CommandOutput> => {
      if (command[0] === "gh") {
        return Effect.succeed({ stdout: stackJson(options.needsRebase), stderr: "", exitCode: 0 })
      }
      if (command[1] === "worktree") {
        return Effect.succeed({
          stdout: "worktree /repo\nHEAD bbb\nbranch refs/heads/api\n\nworktree /auth\nHEAD aaa\nbranch refs/heads/auth\n",
          stderr: "",
          exitCode: 0,
        })
      }
      if (command[1] === "status") {
        return Effect.succeed({
          stdout: options.dirty && runOptions.cwd === "/auth" ? " M auth.ts\n" : "",
          stderr: "",
          exitCode: 0,
        })
      }
      if (command[1] === "rev-parse") {
        return Effect.succeed({
          stdout: runOptions.cwd === "/auth" ? "aaa\n" : "bbb\n",
          stderr: "",
          exitCode: 0,
        })
      }
      return Effect.dieMessage(`unexpected command: ${command.join(" ")}`)
    },
  }))
  return GhStack.layer.pipe(Layer.provide(shell))
}

describe("GhStack", () => {
  it.effect("selects the highest non-merged branch without checking it out", () =>
    Effect.gen(function* () {
      const stacks = yield* GhStack
      const source = yield* stacks.resolveTop(project)
      expect(source.kind).toBe("stack")
      expect(source.branch).toBe("ui")
      expect(source.commit).toBe("ccc")
      expect(source.worktreePath).toBeNull()
      expect(source.stack?.topBranch).toBe("ui")
      expect(source.stack?.branches.map((branch) => branch.name)).toEqual(["auth", "api", "ui"])
    }).pipe(Effect.provide(layer())),
  )

  it.effect("rejects dirty stack worktrees", () =>
    Effect.gen(function* () {
      const stacks = yield* GhStack
      const error = yield* Effect.flip(stacks.resolveTop(project))
      expect(error.message).toContain("auth (/auth)")
    }).pipe(Effect.provide(layer({ dirty: true }))),
  )

  it.effect("rejects stacks that need rebasing", () =>
    Effect.gen(function* () {
      const stacks = yield* GhStack
      const error = yield* Effect.flip(stacks.resolveTop(project))
      expect(error.message).toContain("gh stack rebase")
    }).pipe(Effect.provide(layer({ needsRebase: true }))),
  )
})
