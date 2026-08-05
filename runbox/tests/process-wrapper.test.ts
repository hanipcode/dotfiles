import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdtemp, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { RunboxError } from "../src/errors.ts"

describe("process wrapper", () => {
  it.effect("terminates descendants left behind by an exited command leader", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-wrapper-")))
      const pidFile = join(directory, "child.pid")
      const wrapper = spawn("bun", [
        resolve("bin/process-wrapper.ts"),
        "sh",
        "-c",
        `sleep 30 & echo $! > ${JSON.stringify(pidFile)}`,
      ], {
        detached: true,
        stdio: "ignore",
      })
      const exitCode = yield* Effect.tryPromise({
        try: () => new Promise<number>((resolveExit, reject) => {
          const timeout = setTimeout(() => reject("wrapper did not exit"), 5_000)
          wrapper.once("exit", (code) => {
            clearTimeout(timeout)
            resolveExit(code ?? -1)
          })
          wrapper.once("error", reject)
        }),
        catch: (cause) => new RunboxError({ operation: "test process wrapper", message: String(cause) }),
      }).pipe(
        Effect.ensuring(Effect.sync(() => {
          try {
            if (wrapper.pid !== undefined) process.kill(-wrapper.pid, "SIGKILL")
          } catch {
            // Wrapper already cleaned up.
          }
        })),
      )
      expect(exitCode).toBe(0)
      const descendant = Number((yield* Effect.promise(() => readFile(pidFile, "utf8"))).trim())
      expect(() => process.kill(descendant, 0)).toThrow()
    }),
    10_000,
  )
})
