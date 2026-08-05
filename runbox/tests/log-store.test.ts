import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LogStore } from "../src/services/LogStore.ts"

describe("LogStore", () => {
  it.effect("drops a partial first line from truncated tails", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-log-")))
      const path = join(root, "command.log")
      yield* Effect.promise(() => writeFile(path, `${"x".repeat(70 * 1024)}\ncomplete line\n`))
      const logs = yield* LogStore

      expect(yield* logs.tail(path)).toBe("complete line\n")
    }).pipe(Effect.provide(LogStore.layer)),
  )
})
