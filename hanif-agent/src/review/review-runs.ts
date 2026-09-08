import { Effect, Option, Schema } from "effect"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { ReviewRunError } from "../errors.ts"
import { CoordinatorOutput, LunaOutput, ReviewModels, ReviewResult, ReviewStage } from "./domain.ts"
import { ReviewDiagnostic } from "./review-diagnostics.ts"

/** Valid run IDs cannot supply filesystem paths. */
export const ReviewRunId = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i))

/** Retry inputs describe the original review scope, not the caller's current defaults. */
export const ReviewRunInput = Schema.Struct({
  cwd: Schema.String,
  baseRef: Schema.String,
  targetRef: Schema.NullOr(Schema.String),
  models: ReviewModels,
  timeoutMs: Schema.Number,
})

const RunRecord = Schema.Struct({
  type: Schema.String,
  at: Schema.String,
  runId: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number),
  compatibilityKey: Schema.optional(Schema.String),
  input: Schema.optional(ReviewRunInput),
  result: Schema.optional(ReviewResult),
  stage: Schema.optional(ReviewStage),
  output: Schema.optional(Schema.Union(LunaOutput, CoordinatorOutput)),
  diagnostic: Schema.optional(ReviewDiagnostic),
  role: Schema.optional(Schema.String),
  attempt: Schema.optional(Schema.Number),
  timeoutMs: Schema.optional(Schema.Number),
  detail: Schema.optional(Schema.String),
})

/** Parsed run history supports inspection and compatible stage recovery without retaining source snapshots. */
export const StoredReviewRun = Schema.Struct({
  runId: Schema.String,
  historyPath: Schema.String,
  status: Schema.Literal("running", "complete", "incomplete", "failed", "interrupted"),
  records: Schema.Array(RunRecord),
  result: Schema.OptionFromNullOr(ReviewResult),
})
export type StoredReviewRun = typeof StoredReviewRun.Type

/** Find a run in the local history cache; stale or dead owners are reported as interrupted. */
export function readReviewRun(runId: string): Effect.Effect<StoredReviewRun, ReviewRunError> {
  return Effect.gen(function* () {
    yield* Schema.decodeUnknown(ReviewRunId)(runId).pipe(Effect.mapError(() =>
      new ReviewRunError({ operation: "read review run", message: "Invalid review run ID" })))
    return yield* Effect.tryPromise({
      try: async () => {
        const root = "/tmp/agentic-review"
        const repositories = await readdir(root, { withFileTypes: true })
        const histories: Array<string> = []
        // Only traverse history directories, never the potentially large live snapshots under runs/.
        for (const repository of repositories) {
          if (!repository.isDirectory()) continue
          const directory = join(root, repository.name)
          const branches = await readdir(directory, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return []
            throw cause
          })
          for (const branch of branches) {
            if (branch.isFile() && branch.name === "review.jsonl") histories.push(join(directory, branch.name))
            if (branch.isDirectory() && branch.name !== "runs") histories.push(join(directory, branch.name, "review.jsonl"))
          }
        }
        for (const historyPath of histories) {
          const text = await readFile(historyPath, "utf8").catch((cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return ""
            throw cause
          })
          const records = text.split("\n").slice(0, -1).flatMap((line) => {
            const decoded = Schema.decodeUnknownOption(Schema.parseJson(RunRecord))(line)
            if (Option.isNone(decoded)) return []
            const record = decoded.value
            return record.runId === runId || record.result?.runId === runId ? [record] : []
          })
          if (records.length === 0) continue
          const result = Option.fromNullable([...records].reverse().find((record) => record.type === "run_finished")?.result)
          if (Option.isSome(result)) {
            return StoredReviewRun.make({ runId, historyPath, records, result,
              status: result.value.complete ? "complete" : "incomplete" })
          }
          if (records.some((record) => record.type === "run_failed")) {
            return StoredReviewRun.make({ runId, historyPath, records, result, status: "failed" })
          }
          if (records.some((record) => record.type === "run_interrupted")) {
            return StoredReviewRun.make({ runId, historyPath, records, result, status: "interrupted" })
          }
          const owner = records.find((record) => record.type === "run_started")?.pid
          const heartbeat = [...records].reverse().find((record) => record.type === "heartbeat" || record.type === "run_started")
          let alive = false
          if (owner !== undefined && heartbeat !== undefined && Date.now() - Date.parse(heartbeat.at) < 60_000) {
            try { process.kill(owner, 0); alive = true } catch { /* No live owner. */ }
          }
          return StoredReviewRun.make({ runId, historyPath, records, result,
            status: alive ? "running" : "interrupted" })
        }
        return undefined
      },
      catch: () => new ReviewRunError({ operation: "read review run", message: "Review history is unavailable" }),
    }).pipe(Effect.flatMap((run) => run === undefined
      ? Effect.fail(new ReviewRunError({ operation: "read review run", message: `Review run not found: ${runId}` }))
      : Effect.succeed(run)))
  })
}
