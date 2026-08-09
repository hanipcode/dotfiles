import { createOpencode, type Event, type OpencodeClient, type Part, type ToolPart } from "@opencode-ai/sdk"
import { Context, Effect, Either, Layer, Ref, Schedule, Scope, Stream } from "effect"
import { ReviewerExecutionError } from "../errors.ts"
import type { GoalReference, ReviewerResponse, ReviewerTask, ReviewProgressReporter } from "./domain.ts"
import { reviewerToolActivity } from "./progress.ts"

interface RuntimeOptions {
  readonly directory: string
  readonly goal: GoalReference | null
  readonly onProgress: ReviewProgressReporter
}

/** A running OpenCode server shared by all isolated sessions in one review. */
export interface RunningOpenCode {
  readonly run: (task: ReviewerTask) => Effect.Effect<ReviewerResponse, ReviewerExecutionError>
  readonly usage: Effect.Effect<RuntimeUsage>
}

export interface RuntimeUsage {
  readonly costUsd: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Owns acquisition and release of the OpenCode server used by a review. */
export class OpenCodeRuntime extends Context.Tag("@hanif-agent/OpenCodeRuntime")<
  OpenCodeRuntime,
  {
    readonly start: (options: RuntimeOptions) => Effect.Effect<RunningOpenCode, ReviewerExecutionError, Scope.Scope>
  }
>() {
  static readonly layer = Layer.succeed(
    OpenCodeRuntime,
    OpenCodeRuntime.of({
      start: Effect.fn("OpenCodeRuntime.start")(function* (options: RuntimeOptions) {
        const controller = new AbortController()
        const usage = yield* Ref.make<RuntimeUsage>({
          costUsd: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        })
        const instance = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              const previousProjectConfig = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
              const previousClaudePrompt = process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
              const previousEnableExa = process.env.OPENCODE_ENABLE_EXA
              process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
              process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "1"
              process.env.OPENCODE_ENABLE_EXA = "1"
              try {
                return await createOpencode({
                  signal: controller.signal,
                  port: 0,
                  timeout: 30_000,
                  config: {
                    share: "disabled",
                    agent: {
                      "hanif-reviewer": {
                        description: "Read-only application-level reviewer session",
                        mode: "primary",
                        tools: {
                          "*": false,
                          read: true,
                          glob: true,
                          grep: true,
                          list: true,
                          webfetch: true,
                          websearch: true,
                          edit: false,
                          write: false,
                          patch: false,
                          apply_patch: false,
                          task: false,
                          question: false,
                          todowrite: false,
                          bash: false,
                        },
                        permission: {
                          edit: "deny",
                          bash: "deny",
                          webfetch: "allow",
                          external_directory: "deny",
                        },
                      },
                    },
                    ...(options.goal?.tracker === "atlassian"
                      ? {
                          mcp: {
                            atlassian: {
                              type: "remote" as const,
                              url: "https://mcp.atlassian.com/v1/mcp/authv2",
                              enabled: true,
                              timeout: 30_000,
                            },
                          },
                        }
                      : {}),
                  },
                })
              } finally {
                restoreEnvironment("OPENCODE_DISABLE_PROJECT_CONFIG", previousProjectConfig)
                restoreEnvironment("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT", previousClaudePrompt)
                restoreEnvironment("OPENCODE_ENABLE_EXA", previousEnableExa)
              }
            },
            catch: (cause) => new ReviewerExecutionError({
              role: "runtime",
              operation: "start OpenCode",
              message: String(cause),
              retryable: true,
              sessionId: null,
            }),
          }),
          ({ server }) => Effect.sync(() => {
            controller.abort()
            server.close()
          }),
        )

        yield* ensureTracker(instance.client, options)
        const sessionRoles = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
        const seenToolCalls = yield* Ref.make<ReadonlySet<string>>(new Set())
        const subscription = yield* sdkCall("runtime", "subscribe to OpenCode events", () =>
          instance.client.event.subscribe({
            query: { directory: options.directory },
            signal: controller.signal,
          })).pipe(Effect.either)
        if (Either.isRight(subscription)) {
          yield* Stream.fromAsyncIterable(
            subscription.right.stream,
            (cause) => new ReviewerExecutionError({
              role: "runtime",
              operation: "consume OpenCode events",
              message: String(cause),
              retryable: true,
              sessionId: null,
            }),
          ).pipe(
            Stream.runForEach((event) => reportToolActivity(event, options, sessionRoles, seenToolCalls)),
            Effect.catchAll(() => Effect.void),
            Effect.forkScoped,
          )
        }
        const toolIds = yield* sdkCall("runtime", "list OpenCode tools", () => instance.client.tool.ids({
          query: { directory: options.directory },
          throwOnError: true,
        })).pipe(Effect.map((result) => result.data ?? []))

        const runTask = Effect.fn("OpenCodeRuntime.run")(function* (task: ReviewerTask) {
          const attempt = Effect.gen(function* () {
            const created = yield* sdkCall(task.role, "create reviewer session", () => instance.client.session.create({
              body: { title: `hanif-agent ${task.role}` },
              query: { directory: options.directory },
              throwOnError: true,
            }))
            const session = created.data
            if (session === undefined) {
              return yield* new ReviewerExecutionError({
                role: task.role,
                operation: "create reviewer session",
                message: "OpenCode returned no session",
                retryable: true,
                sessionId: null,
              })
            }
            yield* Ref.update(sessionRoles, (roles) => new Map(roles).set(session.id, task.role))
            const model = yield* parseModel(task.role, task.model)
            const response = yield* sdkCall(task.role, "run reviewer session", () => instance.client.session.prompt({
              path: { id: session.id },
              query: { directory: options.directory },
              body: {
                agent: "hanif-reviewer",
                model,
                system: task.system,
                tools: toolAccess(toolIds, options.goal, task.allowTracker),
                parts: [{ type: "text", text: task.prompt }],
              },
              signal: AbortSignal.timeout(10 * 60_000),
              throwOnError: true,
            })).pipe(
              Effect.mapError((error) => normalizeReviewerExecutionError(
                task.role,
                "run reviewer session",
                session.id,
                error,
              )),
              Effect.onInterrupt(() => Effect.promise(() => instance.client.session.abort({
                path: { id: session.id },
                query: { directory: options.directory },
              }).then(() => undefined))),
            )
            const message = response.data
            if (message === undefined) {
              return yield* new ReviewerExecutionError({
                role: task.role,
                operation: "run reviewer session",
                message: "OpenCode returned no assistant message",
                retryable: true,
                sessionId: session.id,
              })
            }
            const stepUsage = message.parts.reduce<RuntimeUsage>((total, part) => part.type === "step-finish"
              ? {
                  costUsd: total.costUsd,
                  inputTokens: total.inputTokens + part.tokens.input,
                  cacheReadTokens: total.cacheReadTokens + part.tokens.cache.read,
                  cacheWriteTokens: total.cacheWriteTokens + part.tokens.cache.write,
                }
              : total, {
                costUsd: message.info.cost,
                inputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              })
            yield* Ref.update(usage, (total) => ({
              costUsd: total.costUsd + stepUsage.costUsd,
              inputTokens: total.inputTokens + stepUsage.inputTokens,
              cacheReadTokens: total.cacheReadTokens + stepUsage.cacheReadTokens,
              cacheWriteTokens: total.cacheWriteTokens + stepUsage.cacheWriteTokens,
            }))
            if (message.info.error !== undefined) {
              const error = message.info.error
              return yield* new ReviewerExecutionError({
                role: task.role,
                operation: "run reviewer session",
                message: "data" in error && "message" in error.data ? String(error.data.message) : error.name,
                retryable: error.name === "APIError" && error.data.isRetryable,
                sessionId: session.id,
              })
            }
            const output = message.parts
              .filter((part): part is Extract<typeof part, { readonly type: "text" }> => part.type === "text")
              .map((part) => part.text)
              .join("\n")
              .trim()
            if (output.length === 0) {
              return yield* new ReviewerExecutionError({
                role: task.role,
                operation: "run reviewer session",
                message: "reviewer returned no text",
                retryable: true,
                sessionId: session.id,
              })
            }
            return { role: task.role, sessionId: session.id, text: output }
          })
          return yield* attempt.pipe(
            Effect.retry(Schedule.recurs(1).pipe(Schedule.whileInput((error: ReviewerExecutionError) => error.retryable))),
          )
        })

        return { run: runTask, usage: Ref.get(usage) }
      }),
    }),
  )
}

const reportToolActivity = (
  event: Event,
  options: RuntimeOptions,
  sessionRoles: Ref.Ref<ReadonlyMap<string, string>>,
  seenToolCalls: Ref.Ref<ReadonlySet<string>>,
): Effect.Effect<void> => Effect.gen(function* () {
  if (event.type !== "message.part.updated") return
  const part = event.properties.part
  if (!isRunningTool(part)) return
  const role = (yield* Ref.get(sessionRoles)).get(part.sessionID)
  if (role === undefined) return
  const detail = reviewerToolActivity(part.tool, part.state.input, options.directory)
  if (detail === null) return
  const key = `${part.sessionID}\0${part.callID}`
  const first = yield* Ref.modify(seenToolCalls, (seen) => {
    if (seen.has(key)) return [false, seen] as const
    return [true, new Set(seen).add(key)] as const
  })
  if (first) yield* options.onProgress({ type: "stage_activity", role, detail })
})

const isRunningTool = (part: Part): part is ToolPart & { readonly state: { readonly status: "running"; readonly input: Record<string, unknown> } } =>
  part.type === "tool" && part.state.status === "running"

const parseModel = (
  role: string,
  model: string,
): Effect.Effect<{ readonly providerID: string; readonly modelID: string }, ReviewerExecutionError> => {
  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) {
    return Effect.fail(new ReviewerExecutionError({
      role,
      operation: "parse model",
      message: `model '${model}' must use provider/model format`,
      retryable: false,
      sessionId: null,
    }))
  }
  return Effect.succeed({ providerID: model.slice(0, separator), modelID: model.slice(separator + 1) })
}

const restoreEnvironment = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** Rebuild provider failures with every field required by the application error schema. */
export const normalizeReviewerExecutionError = (
  role: string,
  operation: string,
  sessionId: string | null,
  cause: unknown,
): ReviewerExecutionError => {
  const existing = cause instanceof ReviewerExecutionError ? cause : null
  return new ReviewerExecutionError({
    role,
    operation: existing?.operation ?? operation,
    message: existing?.message ?? String(cause),
    retryable: existing?.retryable ?? true,
    sessionId,
  })
}

const sdkCall = <A>(
  role: string,
  operation: string,
  call: () => Promise<A>,
): Effect.Effect<A, ReviewerExecutionError> => Effect.tryPromise({
  try: call,
  catch: (cause) => new ReviewerExecutionError({
    role,
    operation,
    message: String(cause),
    retryable: true,
    sessionId: null,
  }),
})

const ensureTracker = (
  client: OpencodeClient,
  options: RuntimeOptions,
): Effect.Effect<void, ReviewerExecutionError> => Effect.gen(function* () {
  if (options.goal === null) return
  const name = options.goal.tracker
  let response = yield* sdkCall("goals", "check tracker connection", () => client.mcp.status({
    query: { directory: options.directory },
    throwOnError: true,
  }))
  let status = response.data?.[name]
  if (status?.status === "needs_auth" && name === "atlassian") {
    yield* sdkCall("goals", "authenticate Atlassian tracker", () => client.mcp.auth.authenticate({
      path: { name },
      query: { directory: options.directory },
      throwOnError: true,
    }))
    yield* sdkCall("goals", "connect Atlassian tracker", () => client.mcp.connect({
      path: { name },
      query: { directory: options.directory },
      throwOnError: true,
    }))
    response = yield* sdkCall("goals", "check tracker connection", () => client.mcp.status({
      query: { directory: options.directory },
      throwOnError: true,
    }))
    status = response.data?.[name]
  }
  if (status?.status !== "connected") {
    return yield* new ReviewerExecutionError({
      role: "goals",
      operation: "connect issue tracker",
      message: `${name} MCP is ${status?.status ?? "not configured"}`,
      retryable: status?.status === "failed" || status?.status === "needs_auth",
      sessionId: null,
    })
  }
})

/** Restrict each reviewer session to safe source, web, and goal-tracker tools. */
export const toolAccess = (
  toolIds: ReadonlyArray<string>,
  goal: GoalReference | null,
  allowTracker: boolean,
): Readonly<Record<string, boolean>> => Object.fromEntries(toolIds.flatMap((id) => {
  const lower = id.toLowerCase()
  if (lower === "read" || lower === "glob" || lower === "grep" || lower === "list" ||
    lower === "webfetch" || lower === "websearch") {
    return [[id, true]]
  }
  const trackerTool = lower.includes("linear") || lower.includes("atlassian") || lower.includes("jira")
  if (!trackerTool) return [[id, false]]
  if (!allowTracker || goal === null) return [[id, false]]
  const allowed = goal.tracker === "linear"
    ? lower.endsWith("linear_get_issue") || lower.endsWith("linear_list_comments")
    : lower.endsWith("getjiraissue") || lower.endsWith("searchjiraissuesusingjql") || lower.endsWith("getvisiblejiraprojects")
  return [[id, allowed]]
}))
