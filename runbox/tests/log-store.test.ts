import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LogStore } from "../src/services/LogStore.ts"

const MAX_LOG_BYTES = 5 * 1024 * 1024
const TAIL_BYTES = 64 * 1024

describe("LogStore", () => {
  it.effect("drops a partial first line from truncated tails", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-log-")))
      const path = join(root, "command.log")
      yield* Effect.promise(() => writeFile(path, `${"x".repeat(TAIL_BYTES)}discarded line\ncomplete line\n`))
      const logs = yield* LogStore

      expect(yield* logs.tail(path)).toBe("complete line\n")
    }).pipe(Effect.provide(LogStore.layer)),
  )

  it.effect("keeps a huge append within the byte cap", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-log-")))
      const path = join(root, "command.log")
      const incoming = "0123456789".repeat(Math.ceil((MAX_LOG_BYTES + 1) / 10))
      const logs = yield* LogStore

      yield* logs.append(path, incoming)

      expect((yield* Effect.promise(() => stat(path))).size).toBe(MAX_LOG_BYTES)
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(incoming.slice(-MAX_LOG_BYTES))
    }).pipe(Effect.provide(LogStore.layer)),
  )
})
