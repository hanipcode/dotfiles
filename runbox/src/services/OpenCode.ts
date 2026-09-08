import { createOpencode, createOpencodeClient, type Event, type Part } from "@opencode-ai/sdk"
import { Context, Effect, Layer } from "effect"
import { createServer } from "node:net"
import { RunboxError } from "../errors.ts"

export interface OpenCodeRequest {
  readonly directory: string
  readonly prompt: string
  readonly model: string
  readonly agent?: string
  readonly onRecord?: (record: OpenCodeRecord) => void
}

export type OpenCodeRecord =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool"
      readonly sessionId: string
      readonly callId: string
      readonly tool: string
      readonly input: Readonly<Record<string, unknown>>
      readonly status: string
      readonly startedAt: number | null
      readonly endedAt: number | null
      readonly exitCode: number | null
      readonly output: string
    }

export interface OpenCodeResult {
  readonly sessionId: string
  readonly records: ReadonlyArray<OpenCodeRecord>
}

const availablePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (address === null || typeof address === "string") {
      server.close()
      reject(new Error("OpenCode server did not receive a TCP port"))
      return
    }
    server.close((error) => error === undefined ? resolve(address.port) : reject(error))
  })
})

export const parseOpenCodeModel = (value: string): { readonly providerID: string; readonly modelID: string } => {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`invalid OpenCode model '${value}'`)
  }
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
}

const records = (parts: ReadonlyArray<Part>): ReadonlyArray<OpenCodeRecord> => parts.flatMap(
  (part): ReadonlyArray<OpenCodeRecord> => {
  if (part.type === "text") return [{ type: "text" as const, text: part.text }]
  if (part.type !== "tool") return []

  const state = part.state
  const startedAt = "time" in state ? state.time.start : null
  const endedAt = "time" in state && "end" in state.time ? state.time.end : null
  const output = state.status === "completed" ? state.output : state.status === "error" ? state.error : ""
  const exit = "metadata" in state && state.metadata !== undefined ? state.metadata.exit : undefined
  return [{
    type: "tool" as const,
    sessionId: part.sessionID,
    callId: part.callID,
    tool: part.tool,
    input: state.input,
    status: state.status,
    startedAt,
    endedAt,
    exitCode: typeof exit === "number" ? exit : null,
    output,
  }]
  },
)

const message = (value: unknown): string => value instanceof Error ? value.message : String(value)

const streamRecords = async (
  stream: AsyncIterable<Event>,
  sessionId: string,
  onRecord: (record: OpenCodeRecord) => void,
): Promise<void> => {
  const textByPart = new Map<string, string>()
  for await (const event of stream) {
    if (event.type !== "message.part.updated" || event.properties.part.sessionID !== sessionId) continue
    const part = event.properties.part
    if (part.type === "text") {
      const previous = textByPart.get(part.id) ?? ""
      const text = event.properties.delta ?? (part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text)
      textByPart.set(part.id, part.text)
      if (text !== "") onRecord({ type: "text", text })
      continue
    }
    if (part.type === "tool") {
      const record = records([part])[0]
      if (record !== undefined) onRecord(record)
    }
  }
}

export class OpenCode extends Context.Tag("@runbox/OpenCode")<
  OpenCode,
  {
    readonly run: (request: OpenCodeRequest) => Effect.Effect<OpenCodeResult, RunboxError>
  }
>() {
  static readonly layer = Layer.succeed(
    OpenCode,
    OpenCode.of({
      run: Effect.fn("OpenCode.run")((request: OpenCodeRequest) =>
        Effect.async<OpenCodeResult, RunboxError>((resume) => {
          const controller = new AbortController()
          let close = () => {}
          let sessionId: string | null = null
          let client: ReturnType<typeof createOpencodeClient> | null = null

          void (async () => {
            try {
              const port = await availablePort()
              const instance = await createOpencode({
                hostname: "127.0.0.1",
                port,
                signal: controller.signal,
                timeout: 10_000,
                config: {
                  autoupdate: false,
                  share: "disabled",
                  permission: {
                    edit: "allow",
                    bash: "allow",
                    webfetch: "deny",
                    doom_loop: "deny",
                    external_directory: "deny",
                  },
                },
              })
              close = instance.server.close
              client = createOpencodeClient({ baseUrl: instance.server.url, directory: request.directory })
              const created = await client.session.create({
                body: { title: "Runbox preparation" },
                throwOnError: true,
              })
              sessionId = created.data.id
              if (request.onRecord !== undefined) {
                const events = await client.event.subscribe({ signal: controller.signal })
                void streamRecords(events.stream, sessionId, request.onRecord).catch(() => undefined)
              }
              const response = await client.session.prompt({
                path: { id: sessionId },
                body: {
                  model: parseOpenCodeModel(request.model),
                  ...(request.agent === undefined ? {} : { agent: request.agent }),
                  parts: [{ type: "text", text: request.prompt }],
                },
                throwOnError: true,
                signal: controller.signal,
              })
              if (response.data.info.error !== undefined) {
                throw new Error(JSON.stringify(response.data.info.error))
              }
              resume(Effect.succeed({ sessionId, records: records(response.data.parts) }))
            } catch (cause) {
              resume(Effect.fail(new RunboxError({
                operation: "run OpenCode session",
                message: message(cause),
                code: "PREPARATION_FAILED",
                suggestion: "Confirm stable OpenCode is installed and authenticated, then inspect the setup log.",
                retryable: true,
              })))
            } finally {
              close()
            }
          })()

          return Effect.sync(() => {
            controller.abort()
            if (client !== null && sessionId !== null) {
              void client.session.abort({ path: { id: sessionId } }).catch(() => undefined)
            }
            close()
          })
        })),
    }),
  )
}
