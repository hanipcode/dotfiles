import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { RepoState } from "../src/domain.ts"
import { Agent } from "../src/services/Agent.ts"
import { LogStore } from "../src/services/LogStore.ts"
import { PreparationMemory } from "../src/services/PreparationMemory.ts"
import { Shell, type CommandOutput } from "../src/services/Shell.ts"

const memory = Layer.succeed(PreparationMemory, PreparationMemory.of({
  appendHistory: () => Effect.void,
  appendInstructions: () => Effect.void,
  hasSuccess: () => Effect.succeed(false),
  context: () => Effect.succeed("No prior preparation memory is available."),
}))

const agentLayer = (shell: Layer.Layer<Shell>, logs: Layer.Layer<LogStore>) =>
  Agent.layer.pipe(Layer.provide(Layer.mergeAll(shell, logs, memory)))

describe("Agent", () => {
  it.effect("rejects OpenCode changes to runner HEAD", () => {
    let headReads = 0
    const shell = Layer.succeed(Shell, Shell.of({
      run: (command): Effect.Effect<CommandOutput> => {
        if (command[0] === "git" && command[1] === "rev-parse") {
          headReads += 1
          return Effect.succeed({ stdout: headReads === 1 ? "abc\n" : "def\n", stderr: "", exitCode: 0 })
        }
        if (command[0] === "git" && command[1] === "for-each-ref") {
          return Effect.succeed({ stdout: "refs/heads/main abc\n", stderr: "", exitCode: 0 })
        }
        if (command[0] === "git" && command[1] === "config") {
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 })
        }
        if (command[0] === "git" && command[1] === "status") {
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 })
        }
        return Effect.succeed({ stdout: "prepared\n", stderr: "", exitCode: 0 })
      },
    }))
    const logs = Layer.succeed(LogStore, LogStore.of({
      append: () => Effect.void,
      clear: () => Effect.void,
      tail: () => Effect.succeed(""),
    }))
    const state = RepoState.make({
      version: 2,
      repoId: "repo",
      repoRoot: "/repo",
      commonDir: "/repo/.git",
      runnerPath: "/runner",
      environmentSourceRoot: "/repo",
      source: {
        kind: "worktree",
        worktreePath: "/repo",
        branch: "main",
        commit: "abc",
        stack: null,
      },
      preparedCommits: [],
      commands: {},
    })
    const program = Effect.gen(function* () {
      const agent = yield* Agent
      return yield* Effect.flip(agent.prepare({
        state,
        packagePath: "",
        script: null,
        logFile: "/logs/setup.log",
        fingerprint: "fixture",
      }))
    })
    return Effect.gen(function* () {
      const error = yield* program.pipe(
        Effect.provide(agentLayer(shell, logs)),
      )
      expect(error._tag).toBe("AgentMutation")
      if (error._tag === "AgentMutation") expect(error.summary).toContain("HEAD")
    })
  })

  it.effect("allows remote refs to advance during preparation", () => {
    let refReads = 0
    const shell = Layer.succeed(Shell, Shell.of({
      run: (command): Effect.Effect<CommandOutput> => {
        if (command[0] === "git" && command[1] === "rev-parse") {
          return Effect.succeed({ stdout: "abc\n", stderr: "", exitCode: 0 })
        }
        if (command[0] === "git" && command[1] === "for-each-ref") {
          refReads += 1
          return Effect.succeed({
            stdout: `refs/remotes/origin/main ${refReads === 1 ? "abc" : "def"}\n`,
            stderr: "",
            exitCode: 0,
          })
        }
        if (command[0] === "git" && command[1] === "config") {
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 })
        }
        if (command[0] === "git" && command[1] === "status") {
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 })
        }
        return Effect.succeed({ stdout: "prepared\n", stderr: "", exitCode: 0 })
      },
    }))
    const logs = Layer.succeed(LogStore, LogStore.of({
      append: () => Effect.void,
      clear: () => Effect.void,
      tail: () => Effect.succeed(""),
    }))
    const state = RepoState.make({
      version: 2,
      repoId: "repo",
      repoRoot: "/repo",
      commonDir: "/repo/.git",
      runnerPath: "/runner",
      environmentSourceRoot: "/repo",
      source: {
        kind: "worktree",
        worktreePath: "/repo",
        branch: "main",
        commit: "abc",
        stack: null,
      },
      preparedCommits: [],
      commands: {},
    })
    return Effect.gen(function* () {
      const agent = yield* Agent
      yield* agent.prepare({
        state,
        packagePath: "",
        script: null,
        logFile: "/logs/setup.log",
        fingerprint: "fixture",
      })
    }).pipe(Effect.provide(agentLayer(shell, logs)))
  })

  it.effect("allows command artifacts that existed before repair", () => {
    let prompt = ""
    const shell = Layer.succeed(Shell, Shell.of({
      run: (command): Effect.Effect<CommandOutput> => {
        if (command[0] === "git" && command[1] === "rev-parse") {
          return Effect.succeed({ stdout: "abc\n", stderr: "", exitCode: 0 })
        }
        if (command[0] === "git" && command[1] === "for-each-ref") {
          return Effect.succeed({ stdout: "refs/heads/main abc\n", stderr: "", exitCode: 0 })
        }
        if (command[0] === "git" && command[1] === "config") {
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 })
        }
        if (command[0] === "git" && command[1] === "status") {
          return Effect.succeed({ stdout: "?? generated-by-command\n", stderr: "", exitCode: 0 })
        }
        prompt = command.at(-1) ?? ""
        return Effect.succeed({ stdout: "prepared\n", stderr: "", exitCode: 0 })
      },
    }))
    const logs = Layer.succeed(LogStore, LogStore.of({
      append: () => Effect.void,
      clear: () => Effect.void,
      tail: () => Effect.succeed(""),
    }))
    const state = RepoState.make({
      version: 2,
      repoId: "repo",
      repoRoot: "/repo",
      commonDir: "/repo/.git",
      runnerPath: "/runner",
      environmentSourceRoot: "/repo",
      source: {
        kind: "worktree",
        worktreePath: "/repo",
        branch: "main",
        commit: "abc",
        stack: null,
      },
      preparedCommits: [],
      commands: {},
    })
    return Effect.gen(function* () {
      const agent = yield* Agent
      yield* agent.prepare({
        state,
        packagePath: "",
        script: "dev",
        failureOutput: "failed",
        logFile: "/logs/dev.log",
        fingerprint: "fixture",
      })
      expect(prompt).toContain("synchronizes ignored .env files from /repo")
      expect(prompt).toContain("each ancestor package directory")
      expect(prompt).toContain("Do not guess credentials")
    }).pipe(Effect.provide(agentLayer(shell, logs)))
  })

  it.live("bounds OpenCode preparation time", () => {
    const shell = Layer.succeed(Shell, Shell.of({
      run: (command): Effect.Effect<CommandOutput> => {
        if (command[0] !== "git") return Effect.never
        if (command[1] === "rev-parse") {
          return Effect.succeed({ stdout: "abc\n", stderr: "", exitCode: 0 })
        }
        if (command[1] === "for-each-ref") {
          return Effect.succeed({ stdout: "refs/heads/main abc\n", stderr: "", exitCode: 0 })
        }
        return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 })
      },
    }))
    const logs = Layer.succeed(LogStore, LogStore.of({
      append: () => Effect.void,
      clear: () => Effect.void,
      tail: () => Effect.succeed(""),
    }))
    const state = RepoState.make({
      version: 2,
      repoId: "repo",
      repoRoot: "/repo",
      commonDir: "/repo/.git",
      runnerPath: "/runner",
      environmentSourceRoot: "/repo",
      source: {
        kind: "worktree",
        worktreePath: "/repo",
        branch: "main",
        commit: "abc",
        stack: null,
      },
      preparedCommits: [],
      commands: {},
    })
    const request = {
      state,
      packagePath: "",
      script: null,
      logFile: "/logs/setup.log",
      fingerprint: "fixture",
      timeoutMs: 25,
    } as const
    return Effect.gen(function* () {
      const agent = yield* Agent
      const result = yield* agent.prepare(request).pipe(Effect.either)
      expect(result._tag).toBe("Left")
      if (result._tag === "Left" && result.left._tag === "RunboxError") {
        expect(result.left.code).toBe("PREPARATION_TIMEOUT")
      }
    }).pipe(Effect.provide(agentLayer(shell, logs)))
  })
})
