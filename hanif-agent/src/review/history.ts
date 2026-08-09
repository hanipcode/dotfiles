import { Effect, Schema } from "effect"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, truncate } from "node:fs/promises"
import { dirname } from "node:path"
import { ReviewHistoryError } from "../errors.ts"
import { PriorReview, ReviewResult } from "./domain.ts"

const RunFinishedRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  type: Schema.Literal("run_finished"),
  at: Schema.String,
  result: ReviewResult,
})

const sensitiveAssignment = /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY|AUTH)[A-Z0-9_]*)=([^\s"'\\]+)/g
const bearerValue = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi

const sanitize = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value.replace(sensitiveAssignment, "$1=[REDACTED]").replace(bearerValue, "$1[REDACTED]")
  }
  if (Array.isArray(value)) return value.map(sanitize)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]))
}

const readRecords = async (path: string): Promise<ReadonlyArray<unknown>> => {
  const raw = await readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return ""
    throw cause
  })
  const lines = raw.split("\n")
  if (!raw.endsWith("\n")) lines.pop()
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown
      } catch (cause) {
        throw new Error(`invalid JSONL record ${index + 1}: ${String(cause)}`)
      }
    })
}

/** Append one crash-tolerant record to a branch review stream. */
export function appendReviewRecord(
  path: string,
  record: Readonly<Record<string, unknown>>,
): Effect.Effect<void, ReviewHistoryError> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const state = await lstat(path).catch((cause: NodeJS.ErrnoException) =>
        cause.code === "ENOENT" ? null : Promise.reject(cause),
      )
      if (state?.isSymbolicLink()) throw new Error("history path is a symbolic link")
      if (state?.isFile()) {
        const current = await readFile(path)
        if (current.length > 0 && current[current.length - 1] !== 10) {
          const lastNewline = current.lastIndexOf(10)
          await truncate(path, lastNewline + 1)
        }
      }
      const file = await open(
        path,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await file.write(`${JSON.stringify(sanitize({ schemaVersion: 1, ...record }))}\n`)
      } finally {
        await file.close()
      }
    },
    catch: (cause) =>
      new ReviewHistoryError({
        operation: "append review history",
        path,
        message: String(cause),
      }),
  })
}

/** Load the newest complete result; incomplete and truncated runs are not reusable. */
export function loadPriorReview(path: string): Effect.Effect<PriorReview | null, ReviewHistoryError> {
  return Effect.tryPromise({
    try: async () => {
      const records = await readRecords(path)
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const decoded = Schema.decodeUnknownOption(RunFinishedRecord)(records[index])
        if (decoded._tag === "None" || !decoded.value.result.complete) continue
        const result = decoded.value.result
        return PriorReview.make({
          runId: result.runId,
          branch: result.branch,
          baseRef: result.baseRef,
          baseTip: result.baseTip,
          mergeBase: result.mergeBase,
          head: result.head,
          effectiveTreeId: result.effectiveTreeId,
          promptVersion: result.promptVersion,
          standardsDigest: result.standardsDigest,
          models: result.models,
          summary: result.summary,
          findings: [...result.findings],
        })
      }
      return null
    },
    catch: (cause) =>
      new ReviewHistoryError({
        operation: "read review history",
        path,
        message: String(cause),
      }),
  })
}
