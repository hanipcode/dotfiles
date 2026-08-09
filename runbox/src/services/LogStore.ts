import { Context, Effect, Layer } from "effect"
import { appendFile, mkdir, open, stat, writeFile, type FileHandle } from "node:fs/promises"
import { dirname } from "node:path"
import { RunboxError } from "../errors.ts"

const MAX_LOG_BYTES = 5 * 1024 * 1024
const KEEP_LOG_BYTES = 2 * 1024 * 1024
const TAIL_BYTES = 64 * 1024

type ReadSuffix = {
  readonly content: Buffer
  readonly truncated: boolean
}

const emptySuffix: ReadSuffix = { content: Buffer.alloc(0), truncated: false }

const textSuffix = (text: string, maxBytes: number): Buffer => {
  if (Buffer.byteLength(text) <= maxBytes) return Buffer.from(text)

  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (Buffer.byteLength(text.slice(middle)) <= maxBytes) high = middle
    else low = middle + 1
  }
  return Buffer.from(text.slice(low))
}

const readSuffix = async (path: string, maxBytes: number): Promise<ReadSuffix> => {
  let file: FileHandle
  try {
    file = await open(path, "r")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return emptySuffix
    throw cause
  }

  try {
    const size = (await file.stat()).size
    const start = Math.max(0, size - maxBytes)
    const content = Buffer.alloc(size - start)
    let bytesRead = 0
    while (bytesRead < content.length) {
      const result = await file.read(content, bytesRead, content.length - bytesRead, start + bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    return { content: content.subarray(0, bytesRead), truncated: start > 0 }
  } finally {
    await file.close()
  }
}

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
    (() => {
      const writes = new Map<string, Promise<void>>()
      const enqueue = (path: string, operation: () => Promise<void>): Promise<void> => {
        const previous = writes.get(path) ?? Promise.resolve()
        const current = previous.catch(() => undefined).then(() => operation())
        writes.set(path, current)
        const cleanup = () => {
          if (writes.get(path) === current) writes.delete(path)
        }
        void current.then(cleanup, cleanup)
        return current
      }

      return LogStore.of({
        append: Effect.fn("LogStore.append")(function* (path: string, text: string) {
          const write = enqueue(path, async () => {
            await mkdir(dirname(path), { recursive: true })
            const incomingBytes = Buffer.byteLength(text)
            if (incomingBytes >= MAX_LOG_BYTES) {
              await writeFile(path, textSuffix(text, MAX_LOG_BYTES))
              return
            }
            const incoming = Buffer.from(text)
            const size = await stat(path).then((value) => value.size, () => 0)
            if (size + incomingBytes <= MAX_LOG_BYTES) {
              await appendFile(path, incoming)
            } else {
              const keep = Math.min(KEEP_LOG_BYTES, MAX_LOG_BYTES - incomingBytes)
              const current = keep === 0 ? emptySuffix : await readSuffix(path, keep)
              await writeFile(path, Buffer.concat([current.content, incoming]))
            }
          })
          yield* Effect.tryPromise({
            try: () => write,
            catch: (cause) =>
              new RunboxError({ operation: "append command log", message: String(cause) }),
          })
        }),
        clear: Effect.fn("LogStore.clear")(function* (path: string) {
          const write = enqueue(path, async () => {
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, "")
          })
          yield* Effect.tryPromise({
            try: () => write,
            catch: (cause) =>
              new RunboxError({ operation: "clear command log", message: String(cause) }),
          })
        }),
        tail: Effect.fn("LogStore.tail")(function* (path: string) {
          return yield* Effect.tryPromise({
            try: async () => {
              const result = await readSuffix(path, TAIL_BYTES).catch(() => emptySuffix)
              const tail = result.content.toString("utf8")
              if (!result.truncated) return tail
              const firstNewline = tail.indexOf("\n")
              return firstNewline === -1 ? "" : tail.slice(firstNewline + 1)
            },
            catch: (cause) =>
              new RunboxError({ operation: "read command log", message: String(cause) }),
          })
        }),
      })
    })(),
  )
}
