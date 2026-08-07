import { Context, Effect, Layer, Schema } from "effect"
import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { RepoState } from "../domain.ts"
import { AgentMutation, RunboxError } from "../errors.ts"
import { LogStore } from "./LogStore.ts"
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
  const texts = output.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as { readonly type?: unknown; readonly part?: { readonly text?: unknown } }
      return value.type === "text" && typeof value.part?.text === "string" ? [value.part.text] : []
    } catch {
      return []
    }
  })
  for (const text of texts.reverse()) {
    try {
      return Schema.decodeUnknownSync(AgentMemoryResponse)(JSON.parse(stripCodeFence(text)))
    } catch {
      // Commentary text and older agents are not structured memory responses.
    }
  }
  return null
}

export const toolHistoryRecords = (
  output: string,
  runId: string,
): ReadonlyArray<Readonly<Record<string, unknown>>> => output.split("\n").flatMap((line) => {
  let value: {
    readonly type?: unknown
    readonly timestamp?: unknown
    readonly sessionID?: unknown
    readonly part?: {
      readonly tool?: unknown
      readonly callID?: unknown
      readonly state?: {
        readonly status?: unknown
        readonly input?: unknown
        readonly output?: unknown
        readonly metadata?: { readonly exit?: unknown }
        readonly time?: { readonly start?: unknown; readonly end?: unknown }
      }
    }
  }
  try {
    value = JSON.parse(line)
  } catch {
    return []
  }
  if (value.type !== "tool_use" || typeof value.part?.tool !== "string") return []
  const state = value.part.state
  const renderedOutput = typeof state?.output === "string"
    ? state.output
    : state?.output === undefined ? "" : JSON.stringify(state.output)
  const summary = outputSummary(renderedOutput)
  const startedAt = typeof state?.time?.start === "number" ? state.time.start : null
  const endedAt = typeof state?.time?.end === "number" ? state.time.end : null
  return [{
    kind: "tool",
    at: typeof value.timestamp === "number" ? value.timestamp : Date.now(),
    runId,
    sessionId: typeof value.sessionID === "string" ? value.sessionID : null,
    callId: typeof value.part.callID === "string" ? value.part.callID : null,
    tool: value.part.tool,
    input: sanitizeUnknown(state?.input ?? null),
    status: typeof state?.status === "string" ? state.status : "unknown",
    startedAt,
    endedAt,
    durationMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
    exitCode: typeof state?.metadata?.exit === "number" ? state.metadata.exit : null,
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
        return {
          head: head.stdout.trim(),
          config: config.stdout.trim(),
          status: status.stdout.trim(),
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
        let capturedOutput = ""
        let toolsRecorded = false
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
          })
        const appendTools = Effect.fn("Agent.appendToolHistory")(function* () {
          if (toolsRecorded) return
          toolsRecorded = true
          for (const record of toolHistoryRecords(capturedOutput, run.runId)) {
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
          const executable = process.env.RUNBOX_OPENCODE_BIN ?? "opencode"
          const output = yield* shell.run(
          [
            executable,
            "run",
            "-m",
            "openai/gpt-5.6-luna",
            "--format",
            "json",
            "--auto",
            "--dir",
            packageDir,
            prompt,
          ],
          {
            cwd: packageDir,
            allowFailure: true,
            timeoutMs,
            onStdout: (chunk) => {
              capturedOutput += chunk
              void appendFile(request.logFile, sanitizeText(chunk)).catch(() => undefined)
            },
            onStderr: (chunk) => { void appendFile(request.logFile, sanitizeText(chunk)).catch(() => undefined) },
          },
        ).pipe(
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
          Effect.mapError((error) =>
            error instanceof RunboxError
              ? error
              : new RunboxError({
                  operation: "launch OpenCode",
                  message: error.stderr,
                  code: error.stderr.includes("timed out") ? "PREPARATION_TIMEOUT" : "PREPARATION_FAILED",
                  suggestion: "Inspect 'runbox logs setup --json', then retry.",
                  retryable: true,
                  details: request.logFile,
                }),
          ),
          )
          yield* appendTools()
          yield* logs.append(request.logFile, `\n[runbox] OpenCode preparation exited with ${output.exitCode}\n`)
          const after = yield* gitSnapshot(request.state.runnerPath)
          if (after.head !== before.head) {
            return yield* new AgentMutation({
              summary: `OpenCode changed runner HEAD from ${before.head} to ${after.head}`,
            })
          }
          if (after.config !== before.config) {
            return yield* new AgentMutation({
              summary: "OpenCode changed repository config",
            })
          }
          if (after.status !== before.status) {
            return yield* new AgentMutation({
              summary: after.status === ""
                ? `OpenCode changed runner status from ${before.status}`
                : after.status,
            })
          }
          if (output.exitCode !== 0) {
            return yield* new RunboxError({
              operation: "prepare runner",
              message: `OpenCode exited with ${output.exitCode}`,
            })
          }
          const response = parseAgentMemoryResponse(output.stdout)
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
            Effect.zipRight(appendRun("failed", error instanceof Error ? error.message : String(error))),
            Effect.catchAll(() => Effect.void),
          )),
        )
      })

      return Agent.of({ prepare })
    }),
  )
}
