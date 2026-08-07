import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { ReviewModels, type ReviewerResponse } from "../src/review/domain.ts"
import { captureReviewSnapshot } from "../src/review/git-snapshot.ts"
import { OpenCodeRuntime } from "../src/review/opencode-runtime.ts"
import { goalReferenceFromBranch } from "../src/review/prompts.ts"
import { Review } from "../src/review/review.ts"

const run = async (cwd: string, command: ReadonlyArray<string>): Promise<string> => {
  const [executable, ...args] = command
  if (executable === undefined) throw new Error("cannot run an empty command")
  const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? -1))
  })
  if (exitCode !== 0) throw new Error(`${command.join(" ")}: ${stderr}`)
  return stdout.trim()
}

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hanif-agent-test-"))
  await run(root, ["git", "init", "-b", "main"])
  await run(root, ["git", "config", "user.email", "test@example.com"])
  await run(root, ["git", "config", "user.name", "Test"])
  await writeFile(join(root, "app.ts"), "export const value = 1\n")
  await run(root, ["git", "add", "app.ts"])
  await run(root, ["git", "commit", "-m", "initial"])
  await run(root, ["git", "switch", "-c", "feature/review"])
  return root
}

const specialistJson = JSON.stringify({ summary: "checked", findings: [] })
const coordinatorJson = JSON.stringify({ summary: "clean", findings: [] })

describe("adversarial review", () => {
  it.effect("parses supported branch goals and rejects ambiguity", () => Effect.gen(function* () {
    const fun = yield* goalReferenceFromBranch("feature/fun-123-checkout")
    const xen = yield* goalReferenceFromBranch("XEN-42/fix")
    expect(fun).toEqual({ key: "FUN-123", tracker: "linear" })
    expect(xen).toEqual({ key: "XEN-42", tracker: "atlassian" })
    expect(yield* goalReferenceFromBranch("feature/no-ticket")).toBeNull()
    const ambiguous = yield* goalReferenceFromBranch("FUN-1-XEN-2").pipe(Effect.flip)
    expect(ambiguous.references).toEqual(["FUN-1", "XEN-2"])
  }))

  it.live("captures committed and dirty state without activating repository agent configuration", () =>
    Effect.acquireUseRelease(
      Effect.promise(repository),
      (root) => Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(join(root, "app.ts"), "export const value = 2\n"))
        yield* Effect.promise(() => writeFile(join(root, "staged.ts"), "export const staged = true\n"))
        yield* Effect.promise(() => run(root, ["git", "add", "staged.ts"]))
        yield* Effect.promise(() => writeFile(join(root, "untracked.ts"), "export const untracked = true\n"))
        yield* Effect.promise(() => writeFile(join(root, "opencode.json"), "{\"permission\":\"allow\"}\n"))

        const snapshot = yield* captureReviewSnapshot(root, "main", randomUUID())
        expect(snapshot.changedPaths).toEqual(["app.ts", "opencode.json", "staged.ts", "untracked.ts"])
        const patch = yield* Effect.promise(() => readFile(snapshot.patchPath, "utf8"))
        expect(patch).toContain("export const value = 2")
        expect(patch).toContain("export const staged = true")
        expect(patch).toContain("export const untracked = true")
        const activeConfig = yield* Effect.promise(() => readFile(join(snapshot.snapshotDirectory, "opencode.json"), "utf8").then(
          () => true,
          () => false,
        ))
        expect(activeConfig).toBe(false)
        expect(yield* Effect.promise(() => readFile(
          join(snapshot.snapshotDirectory, ".hanif-agent", "untrusted-repository-control", "opencode.json.txt"),
          "utf8",
        ))).toContain("permission")
      }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  )

  it.live("runs specialists concurrently, orders Sol afterward, and reuses an unchanged result", () =>
    Effect.acquireUseRelease(
      Effect.promise(repository),
      (root) => Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(join(root, "app.ts"), "export const value = 2\n"))
        const roles: Array<string> = []
        let active = 0
        let maximumActive = 0
        const fakeRuntime = Layer.succeed(OpenCodeRuntime, OpenCodeRuntime.of({
          start: () => Effect.succeed({
            run: (task) => Effect.gen(function* () {
              roles.push(task.role)
              active += 1
              maximumActive = Math.max(maximumActive, active)
              yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)))
              active -= 1
              const response: ReviewerResponse = {
                role: task.role,
                sessionId: randomUUID(),
                text: task.role.startsWith("sol-") ? coordinatorJson : specialistJson,
              }
              return response
            }),
          }),
        }))
        const layer = Review.layerWithoutDependencies.pipe(Layer.provide(fakeRuntime))
        const request = {
          cwd: root,
          baseRef: "main",
          models: ReviewModels.make({ reviewer: "openai/gpt-5.6-luna", coordinator: "openai/gpt-5.6-sol" }),
        }

        const first = yield* Effect.gen(function* () {
          const review = yield* Review
          return yield* review.run(request)
        }).pipe(Effect.provide(layer))
        expect(first.complete).toBe(true)
        expect(first.mode).toBe("full")
        expect(maximumActive).toBeGreaterThan(1)
        expect(roles.slice(-2)).toEqual(["sol-deduplicate", "sol-gap-review"])
        expect(roles.slice(0, 4).sort()).toEqual([
          "quality",
          "security",
          "standards-contracts",
          "standards-modules",
        ])

        const callsAfterFirstReview = roles.length
        yield* Effect.promise(() => writeFile(join(root, "app.ts"), "export const value = 3\n"))
        const second = yield* Effect.gen(function* () {
          const review = yield* Review
          return yield* review.run(request)
        }).pipe(Effect.provide(layer))
        expect(second.mode).toBe("incremental")
        expect(roles).toHaveLength(callsAfterFirstReview + 6)
        const incrementalPatch = yield* Effect.promise(() => readFile(
          join(dirname(second.snapshotDirectory), "context", "incremental.patch"),
          "utf8",
        ))
        expect(incrementalPatch).not.toContain("review-context.json")
        expect(incrementalPatch).not.toContain("changes.patch")

        const callsAfterIncrementalReview = roles.length
        const third = yield* Effect.gen(function* () {
          const review = yield* Review
          return yield* review.run(request)
        }).pipe(Effect.provide(layer))
        expect(third.mode).toBe("cache_hit")
        expect(roles).toHaveLength(callsAfterIncrementalReview)

        const changedModels = yield* Effect.gen(function* () {
          const review = yield* Review
          return yield* review.run({
            ...request,
            models: ReviewModels.make({ reviewer: "openai/gpt-5.6-luna-fast", coordinator: "openai/gpt-5.6-sol" }),
          })
        }).pipe(Effect.provide(layer))
        expect(changedModels.mode).toBe("full")
        expect(roles).toHaveLength(callsAfterIncrementalReview + 6)
        const history = yield* Effect.promise(() => readFile(third.historyPath, "utf8"))
        expect(history).toContain('"type":"run_finished"')
      }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  )
})
