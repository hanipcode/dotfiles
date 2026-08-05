import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RepoState } from "../src/domain.ts"
import { Paths } from "../src/services/Paths.ts"
import { Registry } from "../src/services/Registry.ts"

describe("Registry", () => {
  it.effect("returns valid projects when another state entry is invalid", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-registry-scan-")))
      const valid = RepoState.make({
        version: 2,
        repoId: "valid-id",
        repoRoot: "/repos/valid",
        commonDir: "/repos/valid/.git",
        runnerPath: "/runners/valid",
        source: null,
        preparedCommits: [],
        commands: {},
      })
      yield* Effect.promise(async () => {
        await mkdir(join(root, "valid-id"))
        await writeFile(join(root, "valid-id", "state.json"), JSON.stringify(valid))
        await mkdir(join(root, "broken-id"))
        await writeFile(join(root, "broken-id", "state.json"), "not json")
      })
      const paths = Layer.succeed(Paths, Paths.of({
        repoData: (repoId) => join(root, repoId),
        repoState: (repoId) => join(root, repoId),
        dataRoot: root,
        stateRoot: root,
        legacyStateRoot: join(root, "legacy"),
        runner: (repoId) => join(root, repoId, "runner"),
        stateFile: (repoId) => join(root, repoId, "state.json"),
        historyFile: (repoId) => join(root, repoId, "run-history.jsonl"),
        instructionsFile: (repoId) => join(root, repoId, "instructions.jsonl"),
        legacyRepoData: (repoId) => join(root, "legacy-data", repoId),
        legacyRepoState: (repoId) => join(root, "legacy", repoId),
        legacyRunner: (repoId) => join(root, "legacy-data", repoId, "runner"),
        legacyStateFile: (repoId) => join(root, "legacy", repoId, "state.json"),
        socket: (repoId) => join(root, `${repoId}.sock`),
      }))
      const entries = yield* Effect.gen(function* () {
        const registry = yield* Registry
        return yield* registry.scan()
      }).pipe(Effect.provide(Registry.layer.pipe(Layer.provide(paths))))
      expect(entries).toHaveLength(2)
      expect(entries.find((entry) => entry.repoId === "valid-id")?.state?.repoId).toBe("valid-id")
      expect(entries.find((entry) => entry.repoId === "broken-id")?.problem?.path).toContain("broken-id/state.json")
    }),
  )

  it.effect("rejects identifiers that collide across project namespaces", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-registry-")))
      const states = [
        RepoState.make({
          version: 2,
          repoId: "alpha-id",
          repoRoot: "/repos/collision",
          commonDir: "/repos/collision/.git",
          runnerPath: "/runners/alpha",
          source: null,
          preparedCommits: [],
          commands: {},
        }),
        RepoState.make({
          version: 2,
          repoId: "collision",
          repoRoot: "/repos/other",
          commonDir: "/repos/other/.git",
          runnerPath: "/runners/other",
          source: null,
          preparedCommits: [],
          commands: {},
        }),
      ]
      yield* Effect.promise(async () => {
        for (const state of states) {
          const directory = join(root, state.repoId)
          await mkdir(directory)
          await writeFile(join(directory, "state.json"), JSON.stringify(state))
        }
      })
      const paths = Layer.succeed(Paths, Paths.of({
    repoData: (repoId) => join(root, repoId),
    repoState: (repoId) => join(root, repoId),
    dataRoot: root,
    stateRoot: root,
    legacyStateRoot: join(root, "legacy"),
    runner: (repoId) => join(root, repoId, "runner"),
    stateFile: (repoId) => join(root, repoId, "state.json"),
    historyFile: (repoId) => join(root, repoId, "run-history.jsonl"),
    instructionsFile: (repoId) => join(root, repoId, "instructions.jsonl"),
    legacyRepoData: (repoId) => join(root, "legacy-data", repoId),
    legacyRepoState: (repoId) => join(root, "legacy", repoId),
    legacyRunner: (repoId) => join(root, "legacy-data", repoId, "runner"),
    legacyStateFile: (repoId) => join(root, "legacy", repoId, "state.json"),
    socket: (repoId) => join(root, `${repoId}.sock`),
      }))
      const error = yield* Effect.gen(function* () {
        const registry = yield* Registry
        return yield* registry.resolve("collision")
      }).pipe(Effect.provide(Registry.layer.pipe(Layer.provide(paths))), Effect.flip)
      expect(error._tag).toBe("RunboxError")
      if (error._tag === "RunboxError") expect(error.code).toBe("PROJECT_AMBIGUOUS")
    }),
  )
})
