import { Context, Effect, Layer } from "effect"
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { RunboxError } from "../errors.ts"

const MAX_LOG_BYTES = 5 * 1024 * 1024
const KEEP_LOG_BYTES = 2 * 1024 * 1024
const TAIL_BYTES = 64 * 1024

export class LogStore extends Context.Tag("@runbox/LogStore")<
  LogStore,
  {
    readonly append: (path: string, text: string) => Effect.Effect<void, RunboxError>
    readonly clear: (path: string) => Effect.Effect<void, RunboxError>
    readonly tail: (path: string) => Effect.Effect<string, RunboxError>
  }
>() {
  static readonly layer = Layer.succeed(
    LogStore,
    LogStore.of({
      append: Effect.fn("LogStore.append")(function* (path: string, text: string) {
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true })
            const size = await stat(path).then((value) => value.size, () => 0)
            if (size > MAX_LOG_BYTES) {
              const current = await readFile(path)
              await writeFile(path, current.subarray(Math.max(0, current.length - KEEP_LOG_BYTES)))
            }
            await appendFile(path, text)
          },
          catch: (cause) =>
            new RunboxError({ operation: "append command log", message: String(cause) }),
        })
      }),
      clear: Effect.fn("LogStore.clear")(function* (path: string) {
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, "")
          },
          catch: (cause) =>
            new RunboxError({ operation: "clear command log", message: String(cause) }),
        })
      }),
      tail: Effect.fn("LogStore.tail")(function* (path: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            const content = await readFile(path).catch(() => Buffer.alloc(0))
            const start = Math.max(0, content.length - TAIL_BYTES)
            const tail = content.subarray(start).toString("utf8")
            if (start === 0) return tail
            const firstNewline = tail.indexOf("\n")
            return firstNewline === -1 ? "" : tail.slice(firstNewline + 1)
          },
          catch: (cause) =>
            new RunboxError({ operation: "read command log", message: String(cause) }),
        })
      }),
    }),
  )
}
