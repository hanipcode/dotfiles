import { Effect, Schema } from "effect"
import { connect } from "node:net"
import {
  DaemonResponseSchema,
  ForwardStreamFrame,
  type DaemonRequest,
  type DaemonResponse,
  type ForwardStart,
} from "./domain.ts"
import { RunboxError } from "./errors.ts"
import {
  encodeFrame,
  MAX_FORWARD_FRAME_BYTES,
  MAX_REQUEST_FRAME_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
} from "./ipcProtocol.ts"

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
    socket.once("connect", () => {
      try {
        socket.write(encodeFrame(value, MAX_REQUEST_FRAME_BYTES))
      } catch (cause) {
        socket.destroy()
        finish(Effect.fail(new RunboxError({ operation: "encode daemon request", message: String(cause) })))
      }
    })
    socket.on("data", (chunk: string) => {
      response += chunk
      if (Buffer.byteLength(response) > MAX_RESPONSE_FRAME_BYTES) {
        socket.destroy()
        finish(Effect.fail(new RunboxError({
          operation: "read daemon response",
          message: `daemon response exceeds ${MAX_RESPONSE_FRAME_BYTES} bytes`,
          code: "INVALID_RESPONSE",
          suggestion: "Inspect the daemon state and retry with a narrower request.",
        })))
        return
      }
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

export interface ForwardCallbacks {
  readonly onStart: (start: ForwardStart) => void
  readonly onOutput: (stream: "stdout" | "stderr", text: string) => void
}

export const requestForward = Effect.fn("Ipc.requestForward")(function* (
  socketPath: string,
  value: Extract<DaemonRequest, { readonly type: "forward" }>,
  callbacks: ForwardCallbacks,
) {
  return yield* Effect.async<DaemonResponse, RunboxError>((resume) => {
    const socket = connect(socketPath)
    let response = ""
    let settled = false
    let start: ForwardStart | null = null
    let bufferedBytes = 0
    const finish = (effect: Effect.Effect<DaemonResponse, RunboxError>) => {
      if (settled) return
      settled = true
      resume(effect)
    }
    socket.setEncoding("utf8")
    socket.once("connect", () => {
      try {
        socket.write(encodeFrame(value, MAX_REQUEST_FRAME_BYTES))
      } catch (cause) {
        socket.destroy()
        finish(Effect.fail(new RunboxError({ operation: "encode forwarded command request", message: String(cause) })))
      }
    })
    socket.on("data", (chunk: string) => {
      let searchFrom = response.length
      response += chunk
      bufferedBytes += Buffer.byteLength(chunk)
      while (true) {
        const newline = response.indexOf("\n", searchFrom)
        if (newline === -1) {
          if (bufferedBytes > MAX_RESPONSE_FRAME_BYTES) {
            socket.destroy()
            finish(Effect.fail(new RunboxError({
              operation: "read forwarded command response",
              message: "Forward response exceeds the frame limit before its terminator",
              code: "INVALID_RESPONSE",
              suggestion: "Inspect 'runbox logs forward --json' before retrying; startup may have occurred.",
              retryable: false,
              details: start === null ? null : JSON.stringify({ ...start, started: true }),
            })))
          }
          return
        }
        const line = response.slice(0, newline)
        response = response.slice(newline + 1)
        bufferedBytes -= Buffer.byteLength(line) + 1
        searchFrom = 0
        if (Buffer.byteLength(line) > MAX_RESPONSE_FRAME_BYTES) {
          socket.destroy()
          finish(Effect.fail(new RunboxError({
            operation: "read forwarded command response",
            message: `daemon response frame exceeds ${MAX_RESPONSE_FRAME_BYTES} bytes`,
            code: "INVALID_RESPONSE",
            suggestion: "Upgrade runbox and retry the command.",
          })))
          return
        }
        try {
          const parsed: unknown = JSON.parse(line)
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "type" in parsed &&
            (parsed.type === "start" || parsed.type === "output")
          ) {
            const frame = Schema.decodeUnknownSync(ForwardStreamFrame)(parsed)
            if (frame.type === "start") {
              start = frame.data
              callbacks.onStart(frame.data)
            } else {
              if (Buffer.byteLength(line) > MAX_FORWARD_FRAME_BYTES) {
                throw new Error(`forward output frame exceeds ${MAX_FORWARD_FRAME_BYTES} bytes`)
              }
              callbacks.onOutput(frame.stream, frame.text)
            }
            continue
          }
          const final = Schema.decodeUnknownSync(DaemonResponseSchema)(parsed)
          socket.end()
          finish(Effect.succeed(final))
          return
        } catch (cause) {
          socket.destroy()
          finish(Effect.fail(new RunboxError({
            operation: "decode forwarded command response",
            message: String(cause),
            code: "INVALID_RESPONSE",
            suggestion: "Upgrade runbox and retry the command.",
            details: start === null ? null : JSON.stringify({ ...start, started: true }),
          })))
          return
        }
      }
    })
    socket.once("error", (cause) => {
      finish(Effect.fail(new RunboxError({
        operation: "stream forwarded command",
        message: String(cause),
        code: "DAEMON_UNAVAILABLE",
        suggestion: start === null
          ? "Run 'runbox doctor --json' and retry after the daemon is healthy."
          : "Inspect 'runbox logs forward --json' before retrying because the command may have produced side effects.",
        retryable: start === null,
        details: start === null ? null : JSON.stringify({ ...start, started: true }),
      })))
    })
    socket.once("close", () => {
      if (!settled) {
        finish(Effect.fail(new RunboxError({
          operation: "stream forwarded command",
          message: "daemon closed the connection before reporting the command result",
          code: "DAEMON_UNAVAILABLE",
          suggestion: start === null
            ? "Run 'runbox doctor --json' and retry after the daemon is healthy."
            : "Inspect 'runbox logs forward --json' before retrying because the command may have produced side effects.",
          retryable: start === null,
          details: start === null ? null : JSON.stringify({ ...start, started: true }),
        })))
      }
    })
    return Effect.sync(() => socket.destroy())
  })
})
