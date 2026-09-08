import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { RepoState } from "../src/domain.ts"
import { RunboxError } from "../src/errors.ts"
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent } from "../src/services/Agent.ts"
import { LogStore } from "../src/services/LogStore.ts"
import { PreparationMemory } from "../src/services/PreparationMemory.ts"
import { OpenCode, type OpenCodeResult } from "../src/services/OpenCode.ts"
import { Shell, type CommandOutput } from "../src/services/Shell.ts"

const memory = Layer.succeed(PreparationMemory, PreparationMemory.of({
  appendHistory: () => Effect.void,
  appendInstructions: () => Effect.void,
  hasSuccess: () => Effect.succeed(false),
  context: () => Effect.succeed("No prior preparation memory is available."),
}))

const result: OpenCodeResult = { sessionId: "session", records: [{ type: "text", text: "prepared" }] }

const agentLayer = (
  shell: Layer.Layer<Shell>,
  logs: Layer.Layer<LogStore>,
  openCode = Layer.succeed(OpenCode, OpenCode.of({ run: () => Effect.succeed(result) })),
  preparationMemory = memory,
) => Agent.layer.pipe(Layer.provide(Layer.mergeAll(shell, logs, preparationMemory, openCode)))

describe("Agent", () => {
  for (const scenario of ["dirty", "untracked", "mode", "symlink", "failure", "timeout", "interruption"] as const) {
    it.live(`rejects protected content mutation during ${scenario} preparation`, () => Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-agent-protected-"))),
      (root) => Effect.gen(function* () {
        const shell = yield* Shell
        yield* Effect.promise(async () => {
          await writeFile(join(root, "tracked.txt"), "base")
          await symlink("tracked.txt", join(root, "link"))
        })
        for (const argv of [["init"], ["config", "user.email", "test@example.test"], ["config", "user.name", "Test"], ["add", "-A"], ["commit", "-m", "fixture"]]) {
          yield* shell.run(["git", ...argv], { cwd: root })
        }
        yield* Effect.promise(async () => {
          await writeFile(join(root, "tracked.txt"), "dirty overlay")
          await writeFile(join(root, "untracked.txt"), "untracked overlay")
        })
        const state = RepoState.make({ version: 2, repoId: "repo", repoRoot: root, commonDir: join(root, ".git"), runnerPath: root, source: null, preparedCommits: [], commands: {} })
        const mutated = yield* Deferred.make<void>()
        const openCode = Layer.succeed(OpenCode, OpenCode.of({ run: () => Effect.gen(function* () {
          yield* Effect.promise(async () => {
            if (scenario === "mode") await chmod(join(root, "tracked.txt"), 0o755)
            else if (scenario === "symlink") {
              await rm(join(root, "link"))
              await symlink("untracked.txt", join(root, "link"))
            } else await writeFile(join(root, scenario === "untracked" ? "untracked.txt" : "tracked.txt"), "agent replacement")
          })
          yield* Deferred.succeed(mutated, undefined)
          if (scenario === "interruption") return yield* Effect.never
          if (scenario === "failure") return yield* new RunboxError({ operation: "fake preparation", message: "failed" })
          if (scenario === "timeout") return yield* Effect.never
          return result
        }) }))
        const logs = Layer.succeed(LogStore, LogStore.of({ append: () => Effect.void, clear: () => Effect.void, tail: () => Effect.succeed("") }))
        const history: Array<Readonly<Record<string, unknown>>> = []
        const recordingMemory = Layer.succeed(PreparationMemory, PreparationMemory.of({
          appendHistory: (_repoId, record) => Effect.sync(() => { history.push(record) }),
          appendInstructions: () => Effect.void, hasSuccess: () => Effect.succeed(false), context: () => Effect.succeed(""),
        }))
        const failure = yield* Effect.gen(function* () {
          const agent = yield* Agent
          if (scenario === "interruption") {
            const fiber = yield* agent.prepare({ state, packagePath: "", script: null, logFile: join(root, "setup.log"), fingerprint: "test" }).pipe(Effect.fork)
            yield* Deferred.await(mutated)
            const exit = yield* Fiber.interrupt(fiber)
            expect(exit._tag).toBe("Failure")
            expect(history).toContainEqual(expect.objectContaining({ phase: "failed", message: expect.stringContaining("protected runner file") }))
            return { _tag: "AgentMutation" as const }
          }
          return yield* Effect.flip(agent.prepare({ state, packagePath: "", script: null, logFile: join(root, "setup.log"), fingerprint: "test", timeoutMs: 50 }))
        }).pipe(Effect.provide(agentLayer(Shell.layer, logs, openCode, recordingMemory)))
        expect(failure._tag).toBe("AgentMutation")
      }).pipe(Effect.provide(Shell.layer)),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ))
  }
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
    }).pipe(Effect.provide(agentLayer(
      shell,
      logs,
      Layer.succeed(OpenCode, OpenCode.of({
        run: (request) => {
          prompt = request.prompt
          return Effect.succeed(result)
        },
      })),
    )))
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
    }).pipe(Effect.provide(agentLayer(
      shell,
      logs,
      Layer.succeed(OpenCode, OpenCode.of({ run: () => Effect.never })),
    )))
  })
})
