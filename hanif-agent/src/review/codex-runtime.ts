import { Context, Effect, HashMap, Layer, Option, Ref, Runtime, Schedule, Schema } from "effect"
import { ReviewerExecutionError } from "../errors.ts"
import type { GoalReference, ReviewerResponse, ReviewerTask, ReviewProgressReporter } from "./domain.ts"
import { reviewerToolActivity } from "./progress.ts"
import { reviewDiagnostic } from "./review-diagnostics.ts"
import { spawn } from "node:child_process"

interface RuntimeOptions {
  readonly directory: string
  readonly goal: GoalReference | null
  readonly onProgress: ReviewProgressReporter
  readonly timeoutMs?: number
}

/** Token usage accumulated across every reviewer invocation in one review. */
export interface RuntimeUsage {
  readonly costUsd: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

interface ParsedRun {
  readonly sessionId: string | null
  readonly text: string
  readonly usage: RuntimeUsage
  readonly error: string | null
  readonly tools: ReadonlyArray<{ readonly name: string; readonly input: Readonly<Record<string, unknown>> }>
}

interface CodexModel {
  readonly name: string
  readonly reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh"
}

/** A Codex CLI runtime shared by all isolated ephemeral reviewer invocations in one review. */
export interface RunningCodex {
  readonly run: (task: ReviewerTask) => Effect.Effect<ReviewerResponse, ReviewerExecutionError>
  readonly usage: Effect.Effect<RuntimeUsage>
}

/** Owns usage accounting and the ephemeral Codex CLI boundary used by a review. */
export class CodexRuntime extends Context.Tag("@hanif-agent/CodexRuntime")<
  CodexRuntime,
  {
    readonly start: (options: RuntimeOptions) => Effect.Effect<RunningCodex, ReviewerExecutionError>
  }
>() {
  static readonly layer = Layer.succeed(
    CodexRuntime,
    CodexRuntime.of({
      start: Effect.fn("CodexRuntime.start")(function* (options: RuntimeOptions) {
        yield* Schema.decodeUnknown(Schema.Number.pipe(Schema.int(), Schema.between(1, 3_600_000)))(options.timeoutMs ?? 600_000).pipe(
          Effect.mapError(() => new ReviewerExecutionError({ role: "runtime", operation: "configure reviewer timeout",
            kind: "configuration", message: "Reviewer timeout must be an integer between 1 and 3600000ms",
            retryable: false, sessionId: null })),
        )
        const usage = yield* Ref.make<RuntimeUsage>({
          costUsd: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        })
        const attemptNumbers = yield* Ref.make(HashMap.empty<string, number>())

        const runTask = Effect.fn("CodexRuntime.run")(function* (task: ReviewerTask) {
          const attempts = yield* Ref.make(0)
          const attempt = Effect.gen(function* () {
            const attemptNumber = yield* Ref.updateAndGet(attempts, (value) => value + 1)
            const eventAttempt = yield* Ref.modify(attemptNumbers, (counts) => {
              const next = Option.getOrElse(HashMap.get(counts, task.role), () => 0) + 1
              return [next, HashMap.set(counts, task.role, next)]
            })
            yield* options.onProgress({ type: "attempt_started", role: task.role, attempt: eventAttempt,
              timeoutMs: options.timeoutMs ?? 600_000 })
            const result = yield* runCodex(options, task)
            const parsed = parseCodexRunOutput(result.stdout)

            yield* Ref.update(usage, (total) => ({
              costUsd: total.costUsd + parsed.usage.costUsd,
              inputTokens: total.inputTokens + parsed.usage.inputTokens,
              cacheReadTokens: total.cacheReadTokens + parsed.usage.cacheReadTokens,
              cacheWriteTokens: total.cacheWriteTokens + parsed.usage.cacheWriteTokens,
            }))

            if (result.timedOut) {
              return yield* new ReviewerExecutionError({ role: task.role, operation: "run reviewer session",
                kind: "timeout", message: `Reviewer timed out after ${options.timeoutMs ?? 600_000}ms`,
                retryable: true, sessionId: parsed.sessionId })
            }
            if (result.exitCode !== 0 || parsed.error !== null) {
              return yield* new ReviewerExecutionError({
                role: task.role,
                operation: "run reviewer session",
                message: parsed.error ?? (result.stderr.trim() || `codex exited with ${result.exitCode}`),
                retryable: true,
                sessionId: parsed.sessionId,
                kind: parsed.error === null ? "process" : "provider",
              })
            }
            if (parsed.sessionId === null) {
              return yield* new ReviewerExecutionError({
                role: task.role,
                operation: "run reviewer session",
                message: "codex returned no thread ID",
                kind: "protocol",
                retryable: true,
                sessionId: null,
              })
            }
            if (parsed.text.length === 0) {
              return yield* new ReviewerExecutionError({
                role: task.role,
                operation: "run reviewer session",
                message: "reviewer returned no text",
                kind: "protocol",
                retryable: true,
                sessionId: parsed.sessionId,
              })
            }
            return { role: task.role, sessionId: parsed.sessionId, text: parsed.text, attempts: attemptNumber }
          })
          return yield* attempt.pipe(
            Effect.tapError((error) => Effect.gen(function* () {
              const counts = yield* Ref.get(attemptNumbers)
              const attemptNumber = Option.getOrElse(HashMap.get(counts, task.role), () => 0)
              yield* options.onProgress({ type: "attempt_failed", role: task.role, attempt: attemptNumber,
                error: reviewDiagnostic(error) })
            })),
            Effect.retry(Schedule.recurs(1).pipe(Schedule.whileInput((error: ReviewerExecutionError) => error.retryable))),
            Effect.catchTag("ReviewerExecutionError", (error) => Effect.gen(function* () {
              return yield* new ReviewerExecutionError({ ...error, message: error.message, attempts: yield* Ref.get(attempts) })
            })),
          )
        })

        return { run: runTask, usage: Ref.get(usage) }
      }),
    }),
  )
}

const runCodex = Effect.fn("CodexRuntime.runCommand")(function* (
  options: RuntimeOptions,
  task: ReviewerTask,
) {
  const model = yield* parseCodexModel(task.role, task.model)
  const runtime = yield* Effect.runtime()
  return yield* Effect.tryPromise({
    try: (signal) => runCommand({
      cwd: options.directory,
      model,
      prompt: `${task.system}\n\n${task.prompt}`,
      tracker: task.allowTracker ? options.goal?.tracker ?? null : null,
      timeoutMs: options.timeoutMs ?? 600_000,
      onLine: async (line) => {
        const parsed = parseCodexRunOutput(line)
        for (const tool of parsed.tools) {
          const detail = reviewerToolActivity(tool.name, tool.input, options.directory)
          if (detail !== null) await Runtime.runPromise(runtime)(options.onProgress({ type: "stage_activity", role: task.role, detail }))
        }
      },
    }, signal),
    catch: (cause) => new ReviewerExecutionError({
      role: task.role,
      operation: "run reviewer session",
      message: String(cause),
      retryable: true,
      sessionId: null,
    }),
  })
})

const runCommand = async (input: {
  readonly cwd: string
  readonly model: CodexModel
  readonly prompt: string
  readonly tracker: GoalReference["tracker"] | null
  readonly timeoutMs: number
  readonly onLine: (line: string) => Promise<void>
}, signal: AbortSignal): Promise<RunResult> => {
  const executable = process.env.HANIF_AGENT_CODEX_BIN ?? "codex"
  const trackerConfig = input.tracker === null ? [] : codexTrackerConfig(input.tracker)
  const processHandle = spawn(executable, [
      "--ask-for-approval",
      "never",
      "--search",
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--json",
      "--color",
      "never",
      "--model",
      input.model.name,
      "--config",
      `model_reasoning_effort=${JSON.stringify(input.model.reasoningEffort)}`,
      ...trackerConfig,
      "-",
    ], {
    cwd: input.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  })
  const exited = new Promise<number>((resolve, reject) => {
    processHandle.once("error", reject)
    processHandle.once("close", (code) => resolve(code ?? -1))
  })
  // The adapter owns a process group so timeout/cancellation also stops reviewer tools.
  const abort = (): void => {
    if (processHandle.pid === undefined) return
    try { process.kill(-processHandle.pid, "SIGKILL") } catch { /* Already exited. */ }
  }
  processHandle.stdin.on("error", () => {})
  processHandle.stdin.end(input.prompt)
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; abort() }, input.timeoutMs)
  const stdoutTask = async (): Promise<string> => {
    let output = ""
    let pending = ""
    processHandle.stdout.setEncoding("utf8")
    for await (const chunk of processHandle.stdout) {
      const text = String(chunk)
      output += text
      pending += text
      if (output.length > 8 * 1024 * 1024) {
        abort()
        throw new Error("Reviewer output exceeded the 8 MiB capture limit")
      }
      let newline = pending.indexOf("\n")
      while (newline >= 0) {
        await input.onLine(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf("\n")
      }
    }
    if (pending.length > 0) await input.onLine(pending)
    return output
  }
  const stderrTask = async (): Promise<string> => {
    let output = ""
    processHandle.stderr.setEncoding("utf8")
    for await (const chunk of processHandle.stderr) output = (output + String(chunk)).slice(-4_000)
    return output
  }
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      stdoutTask(),
      stderrTask(),
      exited,
    ])
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    abort()
    await exited.catch(() => {})
    clearTimeout(timeout)
    signal.removeEventListener("abort", abort)
  }
}

const codexTrackerConfig = (tracker: GoalReference["tracker"]): ReadonlyArray<string> =>
  tracker === "linear"
    ? [
        "--config",
        "mcp_servers.linear.url=\"https://mcp.linear.app/mcp\"",
        "--config",
        "mcp_servers.linear.enabled_tools=[\"get_issue\",\"list_comments\"]",
      ]
    : [
        "--config",
        "mcp_servers.atlassian.command=\"npx\"",
        "--config",
        "mcp_servers.atlassian.args=[\"-y\",\"mcp-remote\",\"https://mcp.atlassian.com/v1/mcp\"]",
        "--config",
        "mcp_servers.atlassian.startup_timeout_sec=180",
        "--config",
        "mcp_servers.atlassian.enabled_tools=[\"getJiraIssue\",\"searchJiraIssuesUsingJql\",\"getVisibleJiraProjects\"]",
      ]

/** Parse model and reasoning syntax accepted by the hanif-agent CLI into Codex flags. */
export const parseCodexModel = (
  role: string,
  configuredModel: string,
): Effect.Effect<CodexModel, ReviewerExecutionError> => {
  const providerSeparator = configuredModel.indexOf("/")
  if (providerSeparator >= 0 && !configuredModel.startsWith("openai/")) {
    return Effect.fail(new ReviewerExecutionError({
      role,
      operation: "parse Codex model",
      kind: "configuration",
      message: `Codex model '${configuredModel}' must omit the provider or use openai/model format`,
      retryable: false,
      sessionId: null,
    }))
  }
  const modelAndEffort = configuredModel.startsWith("openai/") ? configuredModel.slice("openai/".length) : configuredModel
  const effortSeparator = modelAndEffort.lastIndexOf("#")
  const name = effortSeparator < 0 ? modelAndEffort : modelAndEffort.slice(0, effortSeparator)
  const effort = effortSeparator < 0 ? "high" : modelAndEffort.slice(effortSeparator + 1)
  if (name.length === 0 || !isReasoningEffort(effort)) {
    return Effect.fail(new ReviewerExecutionError({
      role,
      operation: "parse Codex model",
      kind: "configuration",
      message: `Codex model '${configuredModel}' must use model#minimal|low|medium|high|xhigh syntax`,
      retryable: false,
      sessionId: null,
    }))
  }
  return Effect.succeed({ name, reasoningEffort: effort })
}

const isReasoningEffort = (value: string): value is CodexModel["reasoningEffort"] =>
  value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"

/** Parse the stable JSONL records emitted by `codex exec --json`. */
export const parseCodexRunOutput = (output: string): ParsedRun => {
  let text = ""
  const tools: Array<{ readonly name: string; readonly input: Readonly<Record<string, unknown>> }> = []
  let sessionId: string | null = null
  let error: string | null = null
  let usage: RuntimeUsage = {
    costUsd: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }

  for (const line of output.split("\n")) {
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) continue
      record = parsed
    } catch {
      continue
    }
    if (record.type === "thread.started" && typeof record.thread_id === "string") sessionId ??= record.thread_id
    if (record.type === "item.completed" && isRecord(record.item)) {
      if (record.item.type === "agent_message" && typeof record.item.text === "string") text = record.item.text
      const tool = codexTool(record.item)
      if (tool !== null) tools.push(tool)
    }
    if (record.type === "error") error = errorMessage(record.message ?? record.error)
    if (record.type === "turn.failed") error = errorMessage(record.error)
    if (record.type === "turn.completed") {
      error = null
      if (isRecord(record.usage)) usage = addCodexUsage(usage, record.usage)
    }
  }

  return { sessionId, text: text.trim(), usage, error, tools }
}

const codexTool = (
  item: Record<string, unknown>,
): { readonly name: string; readonly input: Readonly<Record<string, unknown>> } | null => {
  if (item.type === "command_execution") return { name: "command_execution", input: {} }
  if (item.type === "web_search") return { name: "web_search", input: {} }
  if (item.type !== "mcp_tool_call") return null
  const server = typeof item.server === "string" ? item.server : "mcp"
  const tool = typeof item.tool === "string" ? item.tool : "tool"
  return { name: `${server}_${tool}`, input: isRecord(item.arguments) ? item.arguments : {} }
}

const addCodexUsage = (total: RuntimeUsage, usage: Record<string, unknown>): RuntimeUsage => {
  const totalInput = numberValue(usage.input_tokens)
  const cacheRead = numberValue(usage.cached_input_tokens)
  const cacheWrite = numberValue(usage.cache_write_input_tokens)
  return {
    costUsd: total.costUsd,
    inputTokens: total.inputTokens + Math.max(0, totalInput - cacheRead - cacheWrite),
    cacheReadTokens: total.cacheReadTokens + cacheRead,
    cacheWriteTokens: total.cacheWriteTokens + cacheWrite,
  }
}

const numberValue = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0

const errorMessage = (value: unknown): string => {
  if (isRecord(value) && typeof value.message === "string") return value.message
  return typeof value === "string" ? value : "codex returned an error"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
