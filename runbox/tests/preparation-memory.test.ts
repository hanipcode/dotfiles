import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdtemp, readFile } from "node:fs/promises"
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
    const output = [
      JSON.stringify({
        type: "tool_use",
        timestamp: 10,
        sessionID: "session",
        part: {
          tool: "bash",
          callID: "call",
          state: {
            status: "completed",
            input: { command: "API_TOKEN=secret npm ci", workdir: "/repo" },
            output: "installed with API_KEY=value",
            metadata: { exit: 0 },
            time: { start: 1, end: 9 },
          },
        },
      }),
      JSON.stringify({
        type: "text",
        part: { text: JSON.stringify({
          summary: "ready",
          instructionChanges: [{
            key: "setup.dependencies",
            status: "active",
            instruction: "Run npm ci when node_modules is missing.",
            reason: "lockfile install succeeded",
            evidence: ["npm ci exited 0"],
          }],
        }) },
      }),
    ].join("\n")

    expect(toolHistoryRecords(output, "run")).toEqual([
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
