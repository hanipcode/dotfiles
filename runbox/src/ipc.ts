import { Effect, Schema } from "effect"
import { connect } from "node:net"
import { DaemonResponseSchema, type DaemonRequest, type DaemonResponse } from "./domain.ts"
import { RunboxError } from "./errors.ts"

export const request = Effect.fn("Ipc.request")(function* (
  socketPath: string,
  value: DaemonRequest,
  timeoutMs = 10 * 60 * 1_000,
) {
  return yield* Effect.async<DaemonResponse, RunboxError>((resume) => {
    const socket = connect(socketPath)
    let response = ""
    let settled = false
    const finish = (effect: Effect.Effect<DaemonResponse, RunboxError>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resume(effect)
    }
    const timer = setTimeout(() => {
      socket.destroy()
      finish(Effect.fail(new RunboxError({
        operation: "wait for daemon response",
        message: `daemon did not respond within ${timeoutMs}ms`,
        code: "DAEMON_UNAVAILABLE",
        suggestion: "Run 'runbox doctor --json' and inspect the daemon log.",
        retryable: true,
      })))
    }, timeoutMs)
    socket.setEncoding("utf8")
    socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`))
    socket.on("data", (chunk: string) => {
      response += chunk
      const newline = response.indexOf("\n")
      if (newline === -1) return
      const line = response.slice(0, newline)
      socket.end()
      try {
        finish(Effect.succeed(Schema.decodeUnknownSync(DaemonResponseSchema)(JSON.parse(line))))
      } catch (cause) {
        finish(Effect.fail(new RunboxError({ operation: "decode daemon response", message: String(cause) })))
      }
    })
    socket.once("error", (cause) => {
      finish(Effect.fail(new RunboxError({ operation: "connect to daemon", message: String(cause) })))
    })
    socket.once("close", () => {
      if (response.indexOf("\n") === -1) {
        finish(Effect.fail(new RunboxError({
          operation: "read daemon response",
          message: "daemon closed the connection without a response",
          code: "DAEMON_UNAVAILABLE",
          suggestion: "Run 'runbox doctor --json' and inspect the daemon log.",
          retryable: true,
        })))
      }
    })
    return Effect.sync(() => {
      clearTimeout(timer)
      socket.destroy()
    })
  })
})
