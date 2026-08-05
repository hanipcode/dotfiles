import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { access, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RepoState, type ProjectContext } from "../src/domain.ts"
import { CommandFailed } from "../src/errors.ts"
import { Paths } from "../src/services/Paths.ts"
import { Shell } from "../src/services/Shell.ts"
import { StorageMigration } from "../src/services/StorageMigration.ts"

const exists = (path: string) => access(path).then(() => true, () => false)

describe("storage migration", () => {
  it.effect("moves idle legacy state and rewrites absolute paths", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-migration-")))
      const repoId = "repo"
      const legacyState = join(root, "legacy-state", repoId)
      const legacyData = join(root, "legacy-data", repoId)
      const legacyRunner = join(legacyData, "worktree")
      const nextState = join(root, "home", "state", repoId)
      const nextRunner = join(root, "home", "data", repoId, "worktree")
      yield* Effect.promise(() => mkdir(join(legacyState, "logs"), { recursive: true }))
      yield* Effect.promise(() => mkdir(legacyRunner, { recursive: true }))
      yield* Effect.promise(() => writeFile(join(legacyState, "logs", "._dev.log"), "ready\n"))
      const state = RepoState.make({
        version: 2,
        repoId,
        repoRoot: "/repo",
        commonDir: "/repo/.git",
        runnerPath: legacyRunner,
        environmentSourceRoot: "/repo",
        source: { kind: "worktree", worktreePath: "/repo", branch: "main", commit: "abc", stack: null },
        preparedCommits: ["abc"],
        commands: {
          ".:dev": {
            id: ".:dev",
            packagePath: "",
            script: "dev",
            args: [],
            status: "completed",
            pid: null,
            startedAt: null,
            exitCode: 0,
            message: null,
            logFile: join(legacyState, "logs", "._dev.log"),
            processToken: null,
          },
        },
      })
      yield* Effect.promise(() => writeFile(join(legacyState, "state.json"), `${JSON.stringify(state)}\n`))

      const paths = Layer.succeed(Paths, Paths.of({
        repoData: () => join(root, "home", "data", repoId),
        repoState: () => nextState,
        dataRoot: join(root, "home", "data"),
        stateRoot: join(root, "home", "state"),
        legacyStateRoot: join(root, "legacy-state"),
        runner: () => nextRunner,
        stateFile: () => join(nextState, "state.json"),
        historyFile: () => join(nextState, "run-history.jsonl"),
        instructionsFile: () => join(nextState, "instructions.jsonl"),
        legacyRepoData: () => legacyData,
        legacyRepoState: () => legacyState,
        legacyRunner: () => legacyRunner,
        legacyStateFile: () => join(legacyState, "state.json"),
        socket: () => join(root, "runbox.sock"),
      }))
      const shell = Layer.succeed(Shell, Shell.of({
        run: (command) => Effect.tryPromise({
          try: async () => {
            expect(command.slice(0, 3)).toEqual(["git", "worktree", "move"])
            await rename(command[3] ?? "", command[4] ?? "")
            return { stdout: "", stderr: "", exitCode: 0 }
          },
          catch: (cause) => new CommandFailed({
            command: command.join(" "),
            cwd: "/repo",
            exitCode: 1,
            stderr: String(cause),
          }),
        }),
      }))
      const project: ProjectContext = {
        repoId,
        repoRoot: "/repo",
        commonDir: "/repo/.git",
        packageDir: "/repo",
        packagePath: "",
        packageJsonPath: "/repo/package.json",
        branch: "main",
        commit: "abc",
      }
      const migrated = yield* Effect.gen(function* () {
        const migration = yield* StorageMigration
        return yield* migration.migrate(project)
      }).pipe(Effect.provide(StorageMigration.layer.pipe(Layer.provide(Layer.merge(paths, shell)))))

      expect(migrated).toBe(true)
      expect(yield* Effect.promise(() => exists(nextRunner))).toBe(true)
      expect(yield* Effect.promise(() => exists(legacyState))).toBe(false)
      const migratedState = JSON.parse(yield* Effect.promise(() => readFile(join(nextState, "state.json"), "utf8")))
      expect(migratedState.runnerPath).toBe(nextRunner)
      expect(migratedState.commands[".:dev"].logFile).toBe(join(nextState, "logs", "._dev.log"))
    }),
  )
})
