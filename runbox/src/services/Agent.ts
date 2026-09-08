import { Context, Effect, Layer, Schema } from "effect"
import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { lstat, readlink } from "node:fs/promises"
import { createReadStream } from "node:fs"
import type { RepoState } from "../domain.ts"
import { AgentMutation, RunboxError } from "../errors.ts"
import { LogStore } from "./LogStore.ts"
import { OpenCode, type OpenCodeRecord } from "./OpenCode.ts"
import {
  AgentMemoryResponse,
  outputSummary,
  PreparationMemory,
  sanitizeText,
  sanitizeUnknown,
  type PreparationRun,
} from "./PreparationMemory.ts"
import { Shell } from "./Shell.ts"

export interface PrepareRequest {
  readonly state: RepoState
  readonly packagePath: string
  readonly script: string | null
  readonly failureOutput?: string
  readonly logFile: string
  readonly fingerprint: string
  readonly timeoutMs?: number
}

const readOptional = (path: string) => readFile(path, "utf8").catch(() => "")

const stripCodeFence = (value: string): string => {
  const trimmed = value.trim()
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return match?.[1] ?? trimmed
}

export const parseAgentMemoryResponse = (output: string): AgentMemoryResponse | null => {
  try {
    return Schema.decodeUnknownSync(AgentMemoryResponse)(JSON.parse(stripCodeFence(output)))
  } catch {
    return null
  }
}

export const toolHistoryRecords = (
  records: ReadonlyArray<OpenCodeRecord>,
  runId: string,
): ReadonlyArray<Readonly<Record<string, unknown>>> => records.flatMap((record) => {
  if (record.type !== "tool") return []
  const summary = outputSummary(record.output)
  return [{
    kind: "tool",
    at: record.endedAt ?? record.startedAt ?? Date.now(),
    runId,
    sessionId: record.sessionId,
    callId: record.callId,
    tool: record.tool,
    input: sanitizeUnknown(record.input),
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.startedAt !== null && record.endedAt !== null ? record.endedAt - record.startedAt : null,
    exitCode: record.exitCode,
    outputHash: summary.hash,
    outputPreview: summary.preview,
    outputTruncated: summary.truncated,
  }]
})

export class Agent extends Context.Tag("@runbox/Agent")<
  Agent,
  {
    readonly prepare: (request: PrepareRequest) => Effect.Effect<void, RunboxError | AgentMutation>
  }
>() {
  static readonly layer = Layer.effect(
    Agent,
    Effect.gen(function* () {
      const shell = yield* Shell
      const logs = yield* LogStore
      const memory = yield* PreparationMemory
      const openCode = yield* OpenCode

      const gitSnapshot = Effect.fn("Agent.gitSnapshot")(function* (runnerPath: string) {
        const head = yield* shell.run(["git", "rev-parse", "HEAD"], { cwd: runnerPath }).pipe(
          Effect.mapError((error) =>
            new RunboxError({ operation: "inspect runner HEAD", message: error.stderr }),
          ),
        )
        const config = yield* shell.run(["git", "config", "--list", "--show-origin", "--show-scope"], {
          cwd: runnerPath,
          allowFailure: true,
        }).pipe(
          Effect.mapError((error) =>
            new RunboxError({ operation: "inspect runner config", message: error.stderr }),
          ),
        )
        const status = yield* shell.run(
          ["git", "status", "--short", "--untracked-files=all"],
          { cwd: runnerPath },
        ).pipe(
          Effect.mapError((error) =>
            new RunboxError({ operation: "inspect runner status", message: error.stderr }),
          ),
        )
        const index = yield* shell.run(["git", "ls-files", "--stage", "-z"], {
          cwd: runnerPath,
          captureBytes: 16 * 1024 * 1024,
        }).pipe(Effect.mapError((error) => new RunboxError({ operation: "inspect protected index", message: error.stderr })))
        const files = yield* shell.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
          cwd: runnerPath,
          captureBytes: 16 * 1024 * 1024,
        }).pipe(Effect.mapError((error) => new RunboxError({ operation: "inspect protected files", message: error.stderr })))
        const fingerprint = yield* Effect.tryPromise({
          try: async () => {
            // Fail closed rather than compare a truncated Git listing.
            if (Buffer.byteLength(index.stdout) >= 16 * 1024 * 1024 || Buffer.byteLength(files.stdout) >= 16 * 1024 * 1024) {
              throw new Error("Protected file listing exceeds the inspection limit")
            }
            const hash = createHash("sha256").update(index.stdout)
            for (const path of [...new Set(files.stdout.split("\0").filter(Boolean))].sort()) {
              const absolute = join(runnerPath, path)
              const stat = await lstat(absolute).catch((cause: NodeJS.ErrnoException) => {
                if (cause.code === "ENOENT") return null
                throw cause
              })
              hash.update(JSON.stringify([path, stat?.mode ?? null]))
              if (stat?.isSymbolicLink()) hash.update(await readlink(absolute))
              else if (stat?.isFile()) {
                const content = createHash("sha256")
                for await (const chunk of createReadStream(absolute)) content.update(chunk)
                hash.update(content.digest())
              }
            }
            return hash.digest("hex")
          },
          catch: (cause) => new RunboxError({ operation: "fingerprint protected runner files", message: String(cause) }),
        })
        return {
          head: head.stdout.trim(),
          config: config.stdout.trim(),
          status: status.stdout.trim(),
          fingerprint,
        }
      })

      const prepare = Effect.fn("Agent.prepare")(function* (request: PrepareRequest) {
        const before = yield* gitSnapshot(request.state.runnerPath)
        if (request.state.source !== null && before.head !== request.state.source.commit) {
          return yield* new AgentMutation({
            summary: `runner HEAD ${before.head} does not match source ${request.state.source.commit}`,
          })
        }
        const run: PreparationRun = {
          runId: randomUUID(),
          repoId: request.state.repoId,
          commit: before.head,
          fingerprint: request.fingerprint,
          scope: request.script === null ? "setup" : "command",
          packagePath: request.packagePath,
          script: request.script,
          startedAt: Date.now(),
        }
        let capturedRecords: ReadonlyArray<OpenCodeRecord> = []
        const verifyProtectedState = Effect.gen(function* () {
          const after = yield* gitSnapshot(request.state.runnerPath)
          if (after.head !== before.head) {
            return yield* new AgentMutation({ summary: `OpenCode changed runner HEAD from ${before.head} to ${after.head}` })
          }
          if (after.config !== before.config) {
            return yield* new AgentMutation({ summary: "OpenCode changed repository config" })
          }
          if (after.status !== before.status || after.fingerprint !== before.fingerprint) {
            return yield* new AgentMutation({ summary: "OpenCode changed protected runner file contents, modes, symlinks, or index" })
          }
        })
        let toolsRecorded = false
        let failureRecorded = false
        const appendRun = (phase: "started" | "succeeded" | "failed", message: string | null) =>
          memory.appendHistory(run.repoId, {
            kind: "run",
            phase,
            at: Date.now(),
            runId: run.runId,
            commit: run.commit,
            fingerprint: run.fingerprint,
            scope: run.scope,
            packagePath: run.packagePath,
            script: run.script,
            durationMs: Date.now() - run.startedAt,
            message,
          }).pipe(Effect.tap(() => Effect.sync(() => { if (phase === "failed") failureRecorded = true })))
        const appendTools = Effect.fn("Agent.appendToolHistory")(function* () {
          if (toolsRecorded) return
          toolsRecorded = true
          for (const record of toolHistoryRecords(capturedRecords, run.runId)) {
            yield* memory.appendHistory(run.repoId, record)
          }
        })

        yield* appendRun("started", null)
        const execution = Effect.gen(function* () {
          const setup = yield* Effect.promise(() =>
            readOptional(join(request.state.runnerPath, ".agents", "runbox", "setup.md")),
          )
          const instruction = request.script === null
            ? ""
            : yield* Effect.promise(() =>
                readOptional(
                  join(
                    request.state.runnerPath,
                    ".agents",
                    "runbox",
                    "instructions",
                    request.packagePath,
                    request.script ?? "",
                  ),
                ),
              )
          const priorMemory = yield* memory.context(request.state, request.packagePath, request.script)
          const packageDir = join(request.state.runnerPath, request.packagePath)
          const configuredTimeout = Number(process.env.RUNBOX_AGENT_TIMEOUT_MS)
          const timeoutMs = request.timeoutMs ?? (
            Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 5 * 60 * 1_000
          )
          const prompt = [
            "Prepare this managed worktree so the requested package command can run.",
            "Follow the active preparation memory first. Do not rediscover repository setup already established there unless a recorded check or command fails.",
            "Read only the repository documentation needed to resolve missing or stale memory. You may install dependencies, stop stale processes, and create ignored/generated environment files.",
            "Do not edit tracked files or create non-ignored source files. Do not leave the requested command running; runbox owns it.",
            "The runner may already contain a SourceSync-owned dirty overlay from the active worktree. Preserve that overlay byte-for-byte; it is intentional source state, not cleanup work.",
            `The command runs from ${packageDir}. Runbox synchronizes ignored .env files from ${request.state.environmentSourceRoot ?? "the configured environment source"} and loads .env plus .env.local from each ancestor package directory. Never read or print secret values; inspect only file existence and variable names/presence. Do not guess credentials or replace synchronized values; report any missing required secret.`,
            request.failureOutput === undefined
              ? "Reuse valid existing dependencies and generated artifacts; do not reinstall them without evidence they are stale or missing."
              : "This is a repair: address the final specific startup error first and do not reinstall dependencies unless the failure shows they are stale or missing.",
            "Use terminal commands and local project files only. Do not open browsers, use browser automation, or call browser MCP tools.",
            `Prior preparation memory (secret-redacted JSON):\n${priorMemory}`,
            setup === "" ? "Project setup guidance: infer only missing details from project documentation." : `Project setup guidance:\n${setup}`,
            request.script === null ? "No command was selected; perform general project setup only." : `Command: ${request.script}`,
            instruction === "" ? "No command-specific preparation was provided." : `Command preparation:\n${instruction}`,
            request.failureOutput === undefined ? "" : `The previous startup failed with:\n${sanitizeText(request.failureOutput)}`,
            "Finish with exactly one JSON object and no Markdown fence. Schema: {\"summary\":string,\"instructionChanges\":[{\"key\":string,\"status\":\"active\"|\"removed\",\"instruction\":string|null,\"reason\":string,\"evidence\":string[]}]}. Emit only new, corrected, or removed instructions. Never include credentials or environment values.",
          ].filter(Boolean).join("\n\n")
          yield* logs.append(request.logFile, `\n[runbox] asking GPT-5.6 Luna to prepare the runner\n`)
          const output = yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
            const outcome = yield* restore(openCode.run({
            directory: packageDir,
            model: "openai/gpt-5.6-luna",
            prompt,
            onRecord: (record) => {
              const text = record.type === "text"
                ? sanitizeText(record.text)
                : `[Luna] ${record.tool} ${record.status}\n`
              void appendFile(request.logFile, text).catch(() => undefined)
            },
          }).pipe(
            Effect.timeoutFail({
            duration: `${timeoutMs} millis`,
            onTimeout: () => new RunboxError({
              operation: "prepare runner",
              message: `OpenCode preparation timed out after ${timeoutMs}ms`,
              code: "PREPARATION_TIMEOUT",
              suggestion: "Inspect 'runbox logs setup --json', narrow .agents/runbox/setup.md, then retry.",
              retryable: true,
              details: request.logFile,
            }),
          }),
            )).pipe(Effect.exit)
            // Verify even when setup failed, timed out, or was interrupted. Mutation takes precedence.
            yield* verifyProtectedState.pipe(Effect.tapError((error) =>
              appendRun("failed", error._tag === "AgentMutation" ? error.summary : error.message)
            ))
            return yield* outcome
          }))
          capturedRecords = output.records
          yield* appendTools()
          yield* logs.append(request.logFile, `\n[runbox] OpenCode preparation completed\n`)
          const response = parseAgentMemoryResponse(
            output.records.flatMap((record) => record.type === "text" ? [record.text] : []).join("\n"),
          )
          if (response === null) {
            yield* memory.appendHistory(run.repoId, {
              kind: "memory-warning",
              at: Date.now(),
              runId: run.runId,
              message: "agent returned no valid instruction update",
            })
          } else {
            yield* memory.appendInstructions(run, response.instructionChanges)
          }
          yield* appendRun("succeeded", response?.summary ?? null)
        })

        return yield* execution.pipe(
          Effect.tapError((error) => appendTools().pipe(
            Effect.zipRight(failureRecorded ? Effect.void : appendRun("failed", error instanceof Error ? error.message : String(error))),
            Effect.catchAll(() => Effect.void),
          )),
        )
      })

      return Agent.of({ prepare })
    }),
  )
}
