import { Context, Effect, Layer, Schema } from "effect"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { createHash } from "node:crypto"
import type { RepoState } from "../domain.ts"
import { RunboxError } from "../errors.ts"
import { Paths } from "./Paths.ts"

export const InstructionChange = Schema.Struct({
  key: Schema.String,
  status: Schema.Literal("active", "removed"),
  instruction: Schema.NullOr(Schema.String),
  reason: Schema.String,
  evidence: Schema.Array(Schema.String),
})
export type InstructionChange = typeof InstructionChange.Type

export const AgentMemoryResponse = Schema.Struct({
  summary: Schema.String,
  instructionChanges: Schema.Array(InstructionChange),
})
export type AgentMemoryResponse = typeof AgentMemoryResponse.Type

export const InstructionRecord = Schema.Struct({
  version: Schema.Literal(1),
  at: Schema.Number,
  runId: Schema.String,
  commit: Schema.String,
  fingerprint: Schema.String,
  scope: Schema.Literal("setup", "command"),
  packagePath: Schema.String,
  script: Schema.NullOr(Schema.String),
  key: Schema.String,
  status: Schema.Literal("active", "removed"),
  instruction: Schema.NullOr(Schema.String),
  reason: Schema.String,
  evidence: Schema.Array(Schema.String),
})
export type InstructionRecord = typeof InstructionRecord.Type

export interface PreparationRun {
  readonly runId: string
  readonly repoId: string
  readonly commit: string
  readonly fingerprint: string
  readonly scope: "setup" | "command"
  readonly packagePath: string
  readonly script: string | null
  readonly startedAt: number
}

export type RunPhase = "started" | "succeeded" | "failed" | "skipped"

const sensitiveKey = /(secret|token|password|credential|cookie|authorization|api.?key|private.?key)/i
const envAssignment = /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY|COOKIE|AUTH)[A-Z0-9_]*)=([^\s"'\\]+)/g
const bearerValue = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi
const privateKey = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g
const postHogToken = /\bph[ce]_[A-Za-z0-9]+\b/g

export const sanitizeText = (value: string): string => value
  .replace(privateKey, "[REDACTED PRIVATE KEY]")
  .replace(envAssignment, "$1=[REDACTED]")
  .replace(bearerValue, "$1[REDACTED]")
  .replace(postHogToken, "[REDACTED]")

export const sanitizeUnknown = (value: unknown): unknown => {
  if (typeof value === "string") return sanitizeText(value)
  if (Array.isArray(value)) return value.map(sanitizeUnknown)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    sensitiveKey.test(key) ? "[REDACTED]" : sanitizeUnknown(entry),
  ]))
}

export const outputSummary = (value: string): { readonly hash: string; readonly preview: string; readonly truncated: boolean } => ({
  hash: createHash("sha256").update(value).digest("hex"),
  preview: sanitizeText(value.slice(0, 2_000)),
  truncated: value.length > 2_000,
})

const completeLines = (raw: string): ReadonlyArray<string> => {
  const lines = raw.split("\n")
  if (!raw.endsWith("\n")) lines.pop()
  return lines.filter((line) => line.trim() !== "")
}

const readJsonLines = async (path: string): Promise<ReadonlyArray<unknown>> => {
  const raw = await readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return ""
    throw cause
  })
  return completeLines(raw).map((line, index) => {
    try {
      return JSON.parse(line) as unknown
    } catch (cause) {
      throw new Error(`${path}:${index + 1}: ${String(cause)}`)
    }
  })
}

const scopeMatches = (
  record: { readonly scope: string; readonly packagePath: string; readonly script: unknown },
  packagePath: string,
  script: string | null,
) => record.scope === "setup" || (
  record.scope === "command" && record.packagePath === packagePath && record.script === script
)

export class PreparationMemory extends Context.Tag("@runbox/PreparationMemory")<
  PreparationMemory,
  {
    readonly appendHistory: (repoId: string, record: Readonly<Record<string, unknown>>) => Effect.Effect<void, RunboxError>
    readonly appendInstructions: (
      run: PreparationRun,
      changes: ReadonlyArray<InstructionChange>,
    ) => Effect.Effect<void, RunboxError>
    readonly hasSuccess: (
      state: RepoState,
      fingerprint: string,
      packagePath: string,
      script: string | null,
    ) => Effect.Effect<boolean, RunboxError>
    readonly context: (
      state: RepoState,
      packagePath: string,
      script: string | null,
    ) => Effect.Effect<string, RunboxError>
  }
>() {
  static readonly layer = Layer.effect(
    PreparationMemory,
    Effect.gen(function* () {
      const paths = yield* Paths
      const writes = yield* Effect.makeSemaphore(1)

      const appendLine = (path: string, value: unknown) => writes.withPermits(1)(Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true })
          await appendFile(path, `${JSON.stringify(sanitizeUnknown(value))}\n`)
        },
        catch: (cause) => new RunboxError({
          operation: "append preparation memory",
          message: String(cause),
          code: "PREPARATION_MEMORY_WRITE_FAILED",
          suggestion: `Check permissions for ${path}.`,
          details: path,
        }),
      }))

      const load = (path: string) => Effect.tryPromise({
        try: () => readJsonLines(path),
        catch: (cause) => new RunboxError({
          operation: "read preparation memory",
          message: String(cause),
          code: "PREPARATION_MEMORY_INVALID",
          suggestion: "Inspect the reported JSONL line and remove only the malformed trailing record.",
          details: path,
        }),
      })

      const appendHistory = Effect.fn("PreparationMemory.appendHistory")((
        repoId: string,
        record: Readonly<Record<string, unknown>>,
      ) => appendLine(paths.historyFile(repoId), { version: 1, ...record }))

      const appendInstructions = Effect.fn("PreparationMemory.appendInstructions")(function* (
        run: PreparationRun,
        changes: ReadonlyArray<InstructionChange>,
      ) {
        for (const change of changes) {
          const record = InstructionRecord.make({
            version: 1,
            at: Date.now(),
            runId: run.runId,
            commit: run.commit,
            fingerprint: run.fingerprint,
            scope: run.scope,
            packagePath: run.packagePath,
            script: run.script,
            key: change.key,
            status: change.status,
            instruction: change.instruction,
            reason: change.reason,
            evidence: [...change.evidence],
          })
          yield* appendLine(paths.instructionsFile(run.repoId), record)
        }
      })

      const hasSuccess = Effect.fn("PreparationMemory.hasSuccess")(function* (
        state: RepoState,
        fingerprint: string,
        packagePath: string,
        script: string | null,
      ) {
        const values = yield* load(paths.historyFile(state.repoId))
        return values.some((value) => {
          if (typeof value !== "object" || value === null) return false
          const record = value as Record<string, unknown>
          return record.kind === "run" && record.phase === "succeeded" && record.fingerprint === fingerprint &&
            record.packagePath === packagePath && record.script === script
        })
      })

      const context = Effect.fn("PreparationMemory.context")(function* (
        state: RepoState,
        packagePath: string,
        script: string | null,
      ) {
        const instructionValues = yield* load(paths.instructionsFile(state.repoId))
        const active = new Map<string, InstructionRecord>()
        for (const value of instructionValues) {
          const decoded = yield* Schema.decodeUnknown(InstructionRecord)(value).pipe(
            Effect.mapError((cause) => new RunboxError({
              operation: "decode preparation instruction",
              message: String(cause),
              code: "PREPARATION_MEMORY_INVALID",
              suggestion: "Inspect instructions.jsonl and correct the reported record.",
              details: paths.instructionsFile(state.repoId),
            })),
          )
          if (!scopeMatches(decoded, packagePath, script)) continue
          active.set(`${decoded.scope}:${decoded.packagePath}:${decoded.script ?? ""}:${decoded.key}`, decoded)
        }
        const instructions = [...active.values()].filter((record) => record.status === "active")

        const historyValues = yield* load(paths.historyFile(state.repoId))
        const relevantRunIds = new Set(historyValues.flatMap((value) => {
          if (typeof value !== "object" || value === null) return []
          const record = value as Record<string, unknown>
          return record.kind === "run" && typeof record.runId === "string" &&
              typeof record.scope === "string" && typeof record.packagePath === "string" &&
              scopeMatches({ scope: record.scope, packagePath: record.packagePath, script: record.script }, packagePath, script)
            ? [record.runId]
            : []
        }))
        const history = historyValues.filter((value) => {
          if (typeof value !== "object" || value === null) return false
          const runId = (value as Record<string, unknown>).runId
          return typeof runId === "string" && relevantRunIds.has(runId)
        }).slice(-20)

        if (instructions.length === 0 && history.length === 0) return "No prior preparation memory is available."
        return JSON.stringify({
          activeInstructions: instructions.map((record) => ({
            key: record.key,
            instruction: record.instruction,
            reason: record.reason,
            evidence: record.evidence,
          })),
          recentHistory: history,
        }, null, 2)
      })

      return PreparationMemory.of({ appendHistory, appendInstructions, hasSuccess, context })
    }),
  )
}
