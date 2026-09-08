import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { appendReviewRecord } from "../src/review/history.ts"
import { readReviewRun } from "../src/review/review-runs.ts"

describe("saved review inspection", () => {
  it.live("distinguishes live, stale, interrupted, and failed runs while ignoring a torn final line", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        await mkdir("/tmp/agentic-review", { recursive: true })
        return mkdtemp("/tmp/agentic-review/run-inspection-")
      }),
      (directory) => Effect.gen(function* () {
        const path = join(directory, "review.jsonl")
        const runId = randomUUID()
        yield* appendReviewRecord(path, { type: "run_started", at: new Date().toISOString(), runId, pid: process.pid })
        expect((yield* readReviewRun(runId)).status).toBe("running")
        yield* appendReviewRecord(path, { type: "heartbeat", at: new Date(0).toISOString(), runId })
        expect((yield* readReviewRun(runId)).status).toBe("interrupted")
        yield* appendReviewRecord(path, { type: "run_interrupted", at: new Date().toISOString(), runId })
        expect((yield* readReviewRun(runId)).status).toBe("interrupted")
        const failedId = randomUUID()
        yield* appendReviewRecord(path, { type: "run_failed", at: new Date().toISOString(), runId: failedId })
        yield* Effect.promise(() => writeFile(path, '{"type":"run_finished"', { flag: "a" }))
        const failed = yield* readReviewRun(failedId)
        expect(failed.status).toBe("failed")
        expect(Option.isNone(failed.result)).toBe(true)
        const invalid = yield* readReviewRun("../../secret").pipe(Effect.flip)
        expect(invalid.message).toBe("Invalid review run ID")
      }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    ),
  )
})
