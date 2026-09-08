import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { appendFile, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RepoState } from "../src/domain.ts"
import { parseAgentMemoryResponse, toolHistoryRecords } from "../src/services/Agent.ts"
import { Paths } from "../src/services/Paths.ts"
import {
  PreparationMemory,
  sanitizeText,
  sanitizeUnknown,
  type PreparationRun,
} from "../src/services/PreparationMemory.ts"

const pathLayer = (root: string) => Layer.succeed(Paths, Paths.of({
  repoData: (repoId) => join(root, "data", repoId),
  repoState: (repoId) => join(root, "state", repoId),
  dataRoot: join(root, "data"),
  stateRoot: join(root, "state"),
  legacyStateRoot: join(root, "legacy-state"),
  runner: (repoId) => join(root, "data", repoId, "worktree"),
  stateFile: (repoId) => join(root, "state", repoId, "state.json"),
  historyFile: (repoId) => join(root, "state", repoId, "run-history.jsonl"),
  instructionsFile: (repoId) => join(root, "state", repoId, "instructions.jsonl"),
  legacyRepoData: (repoId) => join(root, "legacy-data", repoId),
  legacyRepoState: (repoId) => join(root, "legacy-state", repoId),
  legacyRunner: (repoId) => join(root, "legacy-data", repoId, "worktree"),
  legacyStateFile: (repoId) => join(root, "legacy-state", repoId, "state.json"),
  socket: (repoId) => join(root, `${repoId}.sock`),
}))

const state = RepoState.make({
  version: 2,
  repoId: "repo",
  repoRoot: "/repo",
  commonDir: "/repo/.git",
  runnerPath: "/runner",
  environmentSourceRoot: "/repo",
  source: { kind: "worktree", worktreePath: "/repo", branch: "main", commit: "abc", stack: null },
  preparedCommits: [],
  commands: {},
})

describe("preparation memory", () => {
  it.effect("recovers crash tails and rebuilds indexes after external edits or daemon restart", () => Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-memory-recovery-")))
    const file = join(root, "state", "repo", "run-history.jsonl")
    const layer = PreparationMemory.layer.pipe(Layer.provide(pathLayer(root)))
    const first = { kind: "run", phase: "succeeded", runId: "one", scope: "setup", packagePath: "", script: null, fingerprint: "one" }
    const second = { ...first, runId: "two", fingerprint: "two" }
    yield* Effect.gen(function* () {
      const memory = yield* PreparationMemory
      yield* memory.appendHistory("repo", first)
      const original = yield* Effect.promise(() => readFile(file, "utf8"))
      yield* Effect.promise(() => appendFile(file, '{"kind":"run","broken":'))
      expect(yield* memory.hasSuccess(state, "one", "", null)).toBe(true)
      yield* memory.appendHistory("repo", second)
      expect(yield* memory.hasSuccess(state, "two", "", null)).toBe(true)
      const bytes = yield* Effect.promise(() => readFile(file, "utf8"))
      expect(bytes.startsWith(original)).toBe(true)
      expect(bytes.trim().split("\n")).toHaveLength(2)
      const names = yield* Effect.promise(() => readdir(join(root, "state", "repo")))
      const backup = names.find((name) => name.startsWith("run-history.jsonl.partial-"))
      expect(backup).toBeDefined()
      expect(yield* Effect.promise(() => readFile(join(root, "state", "repo", backup ?? ""), "utf8"))).toBe('{"kind":"run","broken":')
      yield* Effect.promise(() => writeFile(file, `${JSON.stringify(second)}\n`))
      expect(yield* memory.hasSuccess(state, "one", "", null)).toBe(false)
    }).pipe(Effect.provide(layer))
    yield* Effect.gen(function* () {
      const memory = yield* PreparationMemory
      expect(yield* memory.hasSuccess(state, "two", "", null)).toBe(true)
      expect(JSON.parse(yield* memory.context(state, "", null))).toMatchObject({ recentHistory: [{ runId: "two" }] })
    }).pipe(Effect.provide(layer))
  }))
  it("redacts secret values while preserving commands and keys", () => {
    expect(sanitizeText("API_TOKEN=secret Bearer abc.def phc_12345")).toBe(
      "API_TOKEN=[REDACTED] Bearer [REDACTED] [REDACTED]",
    )
    expect(sanitizeUnknown({ command: "npm ci", password: "secret", nested: "API_KEY=value" })).toEqual({
      command: "npm ci",
      password: "[REDACTED]",
      nested: "API_KEY=[REDACTED]",
    })
  })

  it("normalizes tool history and structured agent responses", () => {
    const output = JSON.stringify({
      summary: "ready",
      instructionChanges: [{
        key: "setup.dependencies",
        status: "active",
        instruction: "Run npm ci when node_modules is missing.",
        reason: "lockfile install succeeded",
        evidence: ["npm ci exited 0"],
      }],
    })

    expect(toolHistoryRecords([{
      type: "tool",
      sessionId: "session",
      callId: "call",
      tool: "bash",
      input: { command: "API_TOKEN=secret npm ci", workdir: "/repo" },
      status: "completed",
      startedAt: 1,
      endedAt: 9,
      exitCode: 0,
      output: "installed with API_KEY=value",
    }], "run")).toEqual([
      expect.objectContaining({
        tool: "bash",
        durationMs: 8,
        exitCode: 0,
        input: { command: "API_TOKEN=[REDACTED] npm ci", workdir: "/repo" },
        outputPreview: "installed with API_KEY=[REDACTED]",
      }),
    ])
    expect(parseAgentMemoryResponse(output)).toMatchObject({ summary: "ready" })
  })

  it.effect("folds corrections and finds successful fingerprints", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-memory-")))
      const paths = pathLayer(root)
      const run: PreparationRun = {
        runId: "run-1",
        repoId: "repo",
        commit: "abc",
        fingerprint: "fingerprint",
        scope: "setup",
        packagePath: "",
        script: null,
        startedAt: 1,
      }
      yield* Effect.gen(function* () {
        const memory = yield* PreparationMemory
        yield* memory.appendInstructions(run, [{
          key: "setup.dependencies",
          status: "active",
          instruction: "Run npm install.",
          reason: "initial discovery",
          evidence: [],
        }])
        yield* memory.appendInstructions({ ...run, runId: "run-2" }, [{
          key: "setup.dependencies",
          status: "active",
          instruction: "Run npm ci only when npm ls fails.",
          reason: "corrected after warm switch",
          evidence: ["npm ls exited 0"],
        }])
        yield* memory.appendHistory("repo", {
          kind: "run",
          phase: "succeeded",
          at: 2,
          runId: "run-2",
          commit: "abc",
          fingerprint: "fingerprint",
          scope: "setup",
          packagePath: "",
          script: null,
          durationMs: 10,
          message: "ready",
        })
        expect(yield* memory.hasSuccess(state, "fingerprint", "", null)).toBe(true)
        const context = yield* memory.context(state, "", null)
        expect(context).toContain("Run npm ci only when npm ls fails.")
        expect(context).not.toContain("Run npm install.")
      }).pipe(Effect.provide(PreparationMemory.layer.pipe(Layer.provide(paths))))

      const instructions = yield* Effect.promise(() => readFile(join(root, "state", "repo", "instructions.jsonl"), "utf8"))
      expect(instructions.trim().split("\n")).toHaveLength(2)
    }),
  )
})
