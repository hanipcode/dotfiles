import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ProjectContext } from "../src/domain.ts"
import { Paths } from "../src/services/Paths.ts"
import { decodeState, StateStore } from "../src/services/StateStore.ts"

describe("StateStore", () => {
  it.effect("defaults the environment source for existing version two state", () =>
    Effect.gen(function* () {
      const state = yield* decodeState(JSON.stringify({
        version: 2,
        repoId: "repo",
        repoRoot: "/repo",
        commonDir: "/repo/.git",
        runnerPath: "/runner",
        source: null,
        preparedCommits: [],
        commands: {},
      }), "/state.json")

      expect(state.environmentSourceRoot).toBeNull()
    }),
  )

  it.effect("migrates version one worktree sources", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-state-")))
      const stateFile = join(root, "state.json")
      yield* Effect.promise(() => mkdir(join(root, "runner"), { recursive: true }))
      yield* Effect.promise(() => writeFile(stateFile, JSON.stringify({
        version: 1,
        repoId: "repo",
        repoRoot: "/repo",
        commonDir: "/repo/.git",
        runnerPath: join(root, "runner"),
        source: { worktreePath: "/repo", branch: "main", commit: "abc" },
        preparedCommits: [],
        commands: {},
      })))
      const project: ProjectContext = {
        repoId: "repo",
        repoRoot: "/repo",
        commonDir: "/repo/.git",
        packageDir: "/repo",
        packagePath: "",
        packageJsonPath: "/repo/package.json",
        branch: "main",
        commit: "abc",
      }
      const paths = Layer.succeed(Paths, Paths.of({
        repoData: () => root,
        repoState: () => root,
        dataRoot: root,
        stateRoot: root,
        legacyStateRoot: join(root, "legacy"),
        runner: () => join(root, "runner"),
        stateFile: () => stateFile,
        historyFile: () => join(root, "run-history.jsonl"),
        instructionsFile: () => join(root, "instructions.jsonl"),
        legacyRepoData: () => join(root, "legacy-data"),
        legacyRepoState: () => join(root, "legacy-state"),
        legacyRunner: () => join(root, "legacy-runner"),
        legacyStateFile: () => join(root, "legacy-state.json"),
        socket: () => join(root, "runbox.sock"),
      }))
      const state = yield* Effect.gen(function* () {
        const store = yield* StateStore
        return yield* store.load(project)
      }).pipe(Effect.provide(StateStore.layer.pipe(Layer.provide(paths))))
      expect(state.version).toBe(2)
      expect(state.source).toEqual({
        kind: "worktree",
        worktreePath: "/repo",
        branch: "main",
        commit: "abc",
        stack: null,
      })
      expect(state.preparedCommands).toEqual([])
      expect(state.environmentSourceRoot).toBeNull()
    }),
  )

  it.effect("fails instead of replacing unreadable state", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-state-error-")))
      const stateFile = join(root, "state.json")
      yield* Effect.promise(() => mkdir(stateFile))
      const project: ProjectContext = {
        repoId: "repo",
        repoRoot: "/repo",
        commonDir: "/repo/.git",
        packageDir: "/repo",
        packagePath: "",
        packageJsonPath: "/repo/package.json",
        branch: "main",
        commit: "abc",
      }
      const paths = Layer.succeed(Paths, Paths.of({
        repoData: () => root,
        repoState: () => root,
        dataRoot: root,
        stateRoot: root,
        legacyStateRoot: join(root, "legacy"),
        runner: () => join(root, "runner"),
        stateFile: () => stateFile,
        historyFile: () => join(root, "run-history.jsonl"),
        instructionsFile: () => join(root, "instructions.jsonl"),
        legacyRepoData: () => join(root, "legacy-data"),
        legacyRepoState: () => join(root, "legacy-state"),
        legacyRunner: () => join(root, "legacy-runner"),
        legacyStateFile: () => join(root, "legacy-state.json"),
        socket: () => join(root, "runbox.sock"),
      }))
      const error = yield* Effect.gen(function* () {
        const store = yield* StateStore
        return yield* store.load(project)
      }).pipe(Effect.provide(StateStore.layer.pipe(Layer.provide(paths))), Effect.flip)
      expect(error._tag).toBe("InvalidState")
      expect(error.path).toBe(stateFile)
    }),
  )
})
