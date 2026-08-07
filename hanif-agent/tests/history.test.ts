import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ReviewResult } from "../src/review/domain.ts"
import { appendReviewRecord, loadPriorReview } from "../src/review/history.ts"

describe("review history", () => {
  it.live("loads only complete finished runs and ignores a truncated trailing record", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "hanif-agent-history-"))),
      (directory) => Effect.gen(function* () {
        const path = join(directory, "review.jsonl")
        const result = ReviewResult.make({
          runId: "run-1",
          repositoryRoot: directory,
          branch: "feature/test",
          baseRef: "main",
          baseTip: "base",
          mergeBase: "merge",
          head: "head",
          effectiveTreeId: "tree",
          snapshotDirectory: join(directory, "snapshot"),
          promptVersion: "1",
          standardsDigest: "standards",
          models: { reviewer: "openai/gpt-5.6-luna", coordinator: "openai/gpt-5.6-sol" },
          mode: "full",
          complete: true,
          summary: "clean",
          findings: [],
          historyPath: path,
        })
        yield* appendReviewRecord(path, { type: "run_finished", at: new Date(0).toISOString(), result })
        yield* Effect.promise(() => writeFile(path, '{"type":"run_started"', { flag: "a" }))
        const prior = yield* loadPriorReview(path)
        expect(prior?.runId).toBe("run-1")
        expect(prior?.summary).toBe("clean")
        yield* appendReviewRecord(path, { type: "run_started", at: new Date(1).toISOString(), runId: "run-2" })
        expect((yield* loadPriorReview(path))?.runId).toBe("run-1")
      }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    ),
  )
})
