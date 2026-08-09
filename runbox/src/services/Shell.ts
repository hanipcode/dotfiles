import { Context, Effect, Layer } from "effect"
import { spawn } from "node:child_process"
import { constants } from "node:os"
import { CommandFailed } from "../errors.ts"

export interface RunOptions {
  readonly cwd: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly allowFailure?: boolean
  readonly timeoutMs?: number
  readonly captureBytes?: number
  readonly onStart?: () => void
  readonly onStdout?: (chunk: string) => void
  readonly onStderr?: (chunk: string) => void
}

export interface CommandOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly signal?: NodeJS.Signals | null
}

const signalExitCode = (signal: NodeJS.Signals): number =>
  128 + (constants.signals[signal] ?? 0)

const DEFAULT_CAPTURE_BYTES = 1024 * 1024

const captureLimit = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CAPTURE_BYTES
  return Math.max(0, Math.floor(value))
}

const retainSuffix = (current: Buffer, chunk: string, limit: number): Buffer => {
  const incoming = Buffer.from(chunk)
  if (limit === 0) return Buffer.alloc(0)
  if (incoming.length >= limit) return incoming.subarray(incoming.length - limit)

  const start = Math.max(0, current.length + incoming.length - limit)
  const result = Buffer.allocUnsafe(current.length - start + incoming.length)
  current.copy(result, 0, start)
  incoming.copy(result, current.length - start)
  return result
}

export class Shell extends Context.Tag("@runbox/Shell")<
  Shell,
  {
    readonly run: (
      command: ReadonlyArray<string>,
      options: RunOptions,
    ) => Effect.Effect<CommandOutput, CommandFailed>
  }
>() {
  static readonly layer = Layer.succeed(
    Shell,
    Shell.of({
      run: Effect.fn("Shell.run")(function* (
        command: ReadonlyArray<string>,
        options: RunOptions,
      ) {
        const [stdout, stderr, exitCode, signal] = yield* Effect.async<
          readonly [string, string, number, NodeJS.Signals | null],
          CommandFailed
        >((resume) => {
          const [executable, ...args] = command
          if (executable === undefined) {
            resume(Effect.fail(new CommandFailed({
              command: "",
              cwd: options.cwd,
              exitCode: -1,
              stderr: "empty command",
            })))
            return
          }
          const detached = process.platform !== "win32"
          const child = spawn(executable, args, {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            stdio: ["ignore", "pipe", "pipe"],
            detached,
          })
          const limit = captureLimit(options.captureBytes)
          let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
          let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
          let settled = false
          let killTimer: ReturnType<typeof setTimeout> | undefined
          const terminate = () => {
            if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
            try {
              if (detached) process.kill(-child.pid, "SIGTERM")
              else child.kill("SIGTERM")
            } catch {
              child.kill("SIGTERM")
            }
            killTimer = setTimeout(() => {
              if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
              try {
                if (detached) process.kill(-child.pid, "SIGKILL")
                else child.kill("SIGKILL")
              } catch {
                // The process already exited.
              }
            }, 1_000)
            killTimer.unref()
          }
          const finish = (effect: Effect.Effect<readonly [string, string, number, NodeJS.Signals | null], CommandFailed>) => {
            if (settled) return
            settled = true
            if (timeout !== undefined) clearTimeout(timeout)
            resume(effect)
          }
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            stdout = retainSuffix(stdout, chunk, limit)
            options.onStdout?.(chunk)
          })
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            stderr = retainSuffix(stderr, chunk, limit)
            options.onStderr?.(chunk)
          })
          child.once("spawn", () => options.onStart?.())
          child.once("error", (cause) => finish(Effect.fail(new CommandFailed({
            command: command.join(" "),
            cwd: options.cwd,
            exitCode: -1,
            stderr: String(cause),
          }))))
          child.once("close", (code, signal) => {
            if (killTimer !== undefined) clearTimeout(killTimer)
            finish(Effect.succeed([
              stdout.toString("utf8"),
              stderr.toString("utf8"),
              code ?? (signal === null ? -1 : signalExitCode(signal)),
              signal,
            ]))
          })
          const timeout = options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                terminate()
                finish(Effect.fail(new CommandFailed({
                  command: command.join(" "),
                  cwd: options.cwd,
                  exitCode: -1,
                  stderr: `command timed out after ${options.timeoutMs}ms`,
                })))
              }, options.timeoutMs)
          timeout?.unref()
          return Effect.sync(() => {
            if (timeout !== undefined) clearTimeout(timeout)
            terminate()
          })
        })

        if (exitCode !== 0 && options.allowFailure !== true) {
          return yield* new CommandFailed({
            command: command.join(" "),
            cwd: options.cwd,
            exitCode,
            stderr: stderr.trim(),
          })
        }
        return { stdout, stderr, exitCode, signal }
      }),
    }),
  )
}
