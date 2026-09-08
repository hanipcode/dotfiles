import { Context, Effect, Layer, Schema } from "effect"
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { createHash, randomUUID } from "node:crypto"
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

interface MemoryIndex {
  readonly kind: "history" | "instructions"
  readonly signature: string
  readonly successes: Set<string>
  readonly instructions: Map<string, InstructionRecord>
  readonly runScopes: Map<string, string>
  readonly history: Map<string, Array<{ readonly sequence: number; readonly value: unknown }>>
  sequence: number
}

const scopeKey = (scope: string, packagePath: string, script: string | null) =>
  JSON.stringify([scope, packagePath, script])
const successKey = (fingerprint: string, packagePath: string, script: string | null) =>
  JSON.stringify([fingerprint, packagePath, script])

const indexRecord = (index: MemoryIndex, value: unknown): void => {
  if (index.kind === "instructions") {
    const record = Schema.decodeUnknownSync(InstructionRecord)(value)
    index.instructions.set(JSON.stringify([record.scope, record.packagePath, record.script, record.key]), record)
    return
  }
  if (typeof value !== "object" || value === null) return
  if (!("runId" in value) || typeof value.runId !== "string") return
  if ("kind" in value && value.kind === "run" && "scope" in value && typeof value.scope === "string" &&
    "packagePath" in value && typeof value.packagePath === "string" && "script" in value &&
    (value.script === null || typeof value.script === "string")) {
    index.runScopes.set(value.runId, scopeKey(value.scope, value.packagePath, value.script))
    if ("phase" in value && value.phase === "succeeded" && "fingerprint" in value && typeof value.fingerprint === "string") {
      index.successes.add(successKey(value.fingerprint, value.packagePath, value.script))
    }
  }
  const scope = index.runScopes.get(value.runId)
  if (scope === undefined) return
  const recent = index.history.get(scope) ?? []
  recent.push({ sequence: index.sequence++, value })
  if (recent.length > 20) recent.shift()
  index.history.set(scope, recent)
  if ("kind" in value && value.kind === "run" && "phase" in value &&
    (value.phase === "succeeded" || value.phase === "failed" || value.phase === "skipped")) {
    index.runScopes.delete(value.runId)
  }
}

const fileSignature = async (path: string): Promise<string> => {
  const info = await stat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null
    throw cause
  })
  return info === null ? "missing" : `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}

// Keep complete records untouched. Preserve and fsync damaged bytes before truncating a crash tail.
const appendRecoveredLine = async (path: string, line: string): Promise<void> => {
  const file = await open(path, "a+", 0o600)
  try {
    const size = (await file.stat()).size
    let cursor = size
    let completeSize = size
    const parts: Array<Buffer> = []
    while (cursor > 0) {
      const start = Math.max(0, cursor - 64 * 1024)
      const chunk = Buffer.alloc(cursor - start)
      let bytesRead = 0
      while (bytesRead < chunk.length) {
        const result = await file.read(chunk, bytesRead, chunk.length - bytesRead, start + bytesRead)
        if (result.bytesRead === 0) throw new Error("Preparation journal changed while recovering its tail")
        bytesRead += result.bytesRead
      }
      const newline = chunk.lastIndexOf(10)
      if (newline !== -1) {
        completeSize = start + newline + 1
        parts.unshift(chunk.subarray(newline + 1))
        break
      }
      parts.unshift(chunk)
      cursor = start
      completeSize = start
    }
    if (completeSize < size) {
      const recovery = `${path}.partial-${randomUUID()}`
      await writeFile(recovery, Buffer.concat(parts), { flag: "wx", mode: 0o600 })
      const backup = await open(recovery, "r")
      try { await backup.sync() } finally { await backup.close() }
      await file.truncate(completeSize)
    }
    await file.writeFile(line)
  } finally {
    await file.close()
  }
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
      // Derived indexes are daemon-local and rebuilt from authoritative JSONL after external edits.
      // TTL caching would permit stale preparation success, so invalidation follows file identity instead.
      const indexes = new Map<string, MemoryIndex>()

      const loadIndex = async (path: string, kind: MemoryIndex["kind"]): Promise<MemoryIndex> => {
        const signature = await fileSignature(path)
        const cached = indexes.get(path)
        if (cached?.signature === signature) return cached
        const index: MemoryIndex = {
          kind,
          signature,
          successes: new Set(),
          instructions: new Map(),
          runScopes: new Map(),
          history: new Map(),
          sequence: 0,
        }
        for (const value of await readJsonLines(path)) indexRecord(index, value)
        indexes.set(path, index)
        return index
      }

      const appendLine = (path: string, kind: MemoryIndex["kind"], value: unknown) => writes.withPermits(1)(Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true })
          const index = await loadIndex(path, kind)
          const sanitized = sanitizeUnknown(value)
          await appendRecoveredLine(path, `${JSON.stringify(sanitized)}\n`)
          try {
            indexRecord(index, sanitized)
            indexes.set(path, { ...index, signature: await fileSignature(path) })
          } catch (cause) {
            indexes.delete(path)
            throw cause
          }
        },
        catch: (cause) => new RunboxError({
          operation: "append preparation memory",
          message: String(cause),
          code: "PREPARATION_MEMORY_WRITE_FAILED",
          suggestion: `Check permissions for ${path}.`,
          details: path,
        }),
      }))

      const load = (path: string, kind: MemoryIndex["kind"]) => writes.withPermits(1)(Effect.tryPromise({
        try: () => loadIndex(path, kind),
        catch: (cause) => new RunboxError({
          operation: "read preparation memory",
          message: String(cause),
          code: "PREPARATION_MEMORY_INVALID",
          suggestion: "Inspect the reported JSONL line and remove only the malformed trailing record.",
          details: path,
        }),
      }))

      const appendHistory = Effect.fn("PreparationMemory.appendHistory")((
        repoId: string,
        record: Readonly<Record<string, unknown>>,
      ) => appendLine(paths.historyFile(repoId), "history", { version: 1, ...record }))

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
          yield* appendLine(paths.instructionsFile(run.repoId), "instructions", record)
        }
      })

      const hasSuccess = Effect.fn("PreparationMemory.hasSuccess")(function* (
        state: RepoState,
        fingerprint: string,
        packagePath: string,
        script: string | null,
      ) {
        const index = yield* load(paths.historyFile(state.repoId), "history")
        return index.successes.has(successKey(fingerprint, packagePath, script))
      })

      const context = Effect.fn("PreparationMemory.context")(function* (
        state: RepoState,
        packagePath: string,
        script: string | null,
      ) {
        const instructionIndex = yield* load(paths.instructionsFile(state.repoId), "instructions")
        const instructions = [...instructionIndex.instructions.values()].filter((record) =>
          record.status === "active" && scopeMatches(record, packagePath, script)
        )
        const historyIndex = yield* load(paths.historyFile(state.repoId), "history")
        const history = [...historyIndex.history.entries()].flatMap(([key, values]) =>
          key.startsWith('["setup",') || key === scopeKey("command", packagePath, script) ? values : []
        ).sort((left, right) => left.sequence - right.sequence).slice(-20).map((entry) => entry.value)

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
