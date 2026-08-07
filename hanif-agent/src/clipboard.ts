import { Effect } from "effect"
import { spawn } from "node:child_process"
import { ClipboardError } from "./errors.ts"

/** Copy text into the macOS clipboard without invoking a shell. */
export function copyToClipboard(text: string): Effect.Effect<void, ClipboardError> {
  return Effect.async<void, ClipboardError>((resume) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "pipe"] })
    let stderr = ""
    let settled = false
    const finish = (effect: Effect.Effect<void, ClipboardError>) => {
      if (settled) return
      settled = true
      resume(effect)
    }
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    child.once("error", (cause) => finish(Effect.fail(new ClipboardError({ message: String(cause) }))))
    child.once("close", (code) => {
      if (code === 0) finish(Effect.void)
      else finish(Effect.fail(new ClipboardError({
        message: stderr.trim() || `pbcopy exited with ${code ?? -1}`,
      })))
    })
    child.stdin.once("error", (cause) => finish(Effect.fail(new ClipboardError({ message: String(cause) }))))
    child.stdin.end(text)
    return Effect.sync(() => child.kill("SIGTERM"))
  })
}
