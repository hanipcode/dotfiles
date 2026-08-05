import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Shell } from "../src/services/Shell.ts"

describe("Shell", () => {
  it.live("terminates commands that exceed their deadline", () =>
    Effect.gen(function* () {
      const shell = yield* Shell
      const startedAt = Date.now()
      const error = yield* shell.run(["sh", "-c", "sleep 10"], {
        cwd: process.cwd(),
        timeoutMs: 25,
      }).pipe(Effect.flip)
      expect(error.stderr).toContain("timed out after 25ms")
      expect(Date.now() - startedAt).toBeLessThan(1_000)
    }).pipe(Effect.provide(Shell.layer)),
  )
})
