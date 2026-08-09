import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Shell } from "../src/services/Shell.ts"

describe("Shell", () => {
  it.effect("retains only the newest captured output while streaming complete chunks", () =>
    Effect.gen(function* () {
      const shell = yield* Shell
      const stdoutChunks: Array<string> = []
      const stderrChunks: Array<string> = []
      const output = yield* shell.run([
        "sh",
        "-c",
        "printf '0123456789'; printf 'abcdefgh' >&2",
      ], {
        cwd: process.cwd(),
        captureBytes: 4,
        onStdout: (chunk) => stdoutChunks.push(chunk),
        onStderr: (chunk) => stderrChunks.push(chunk),
      })

      expect(output.stdout).toBe("6789")
      expect(output.stderr).toBe("efgh")
      expect(stdoutChunks.join("")).toBe("0123456789")
      expect(stderrChunks.join("")).toBe("abcdefgh")
    }).pipe(Effect.provide(Shell.layer)),
  )

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
