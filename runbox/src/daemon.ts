import { Effect, Fiber, Layer, Runtime, Schema } from "effect"
import { createServer, type Socket } from "node:net"
import { mkdir, readFile, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { spawnSync } from "node:child_process"
import {
  DaemonRequestSchema,
  RUNBOX_PROTOCOL_VERSION,
  stateRevision,
  type DaemonRequest,
  type DaemonResponse,
  type ForwardStart,
  type ProjectContext,
  type RepoState,
} from "./domain.ts"
import { RunboxError, toErrorInfo } from "./errors.ts"
import { CoreLayer } from "./layers.ts"
import { Supervisor } from "./services/Supervisor.ts"
import { Workflow } from "./services/Workflow.ts"
import { SourceSync } from "./services/SourceSync.ts"
import {
  encodeFrame,
  MAX_FORWARD_FRAME_BYTES,
  MAX_REQUEST_FRAME_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
  splitUtf8,
} from "./ipcProtocol.ts"

interface ForwardObserver {
  readonly onStart: (start: ForwardStart) => void
  readonly onOutput: (stream: "stdout" | "stderr", text: string) => void
}

type SuccessResponse = Extract<DaemonResponse, { readonly ok: true }>

const success = (response: Omit<SuccessResponse, "ok" | "protocolVersion"> = {}): SuccessResponse => ({
  ok: true,
  protocolVersion: RUNBOX_PROTOCOL_VERSION,
  ...response,
})

const handler = (request: DaemonRequest, forwardObserver?: ForwardObserver) =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor
    const workflow = yield* Workflow
    const expectedRevision = "expectedRevision" in request ? request.expectedRevision : undefined
    if (expectedRevision !== undefined) {
      const currentRevision = stateRevision(yield* supervisor.state)
      if (currentRevision !== expectedRevision) {
        return yield* new RunboxError({
          operation: "execute daemon action",
          message: "repository state changed after the action was reviewed",
          code: "ACTION_PLAN_STALE",
          suggestion: "Refresh the dashboard and review the updated action.",
          retryable: true,
        })
      }
    }
    switch (request.type) {
      case "ping":
        return success({ message: "ready" })
      case "status":
        return success({ snapshot: yield* supervisor.snapshot(request.packagePath) })
      case "start":
        yield* workflow.start(request.source, request.packagePath, request.script, request.args, request.watch ?? false)
        return success({ snapshot: yield* supervisor.snapshot(request.packagePath) })
      case "setup":
        yield* workflow.setup(request.source, request.packagePath)
        return success({ message: `prepared ${request.source.commit.slice(0, 8)}` })
      case "stop":
        if (request.script === "all") yield* workflow.stopAll()
        else yield* workflow.stop(request.packagePath, request.script)
        return success({ snapshot: yield* supervisor.snapshot(request.packagePath) })
      case "restart": {
        const state = yield* supervisor.state
        const id = `${request.packagePath === "" ? "." : request.packagePath}:${request.script}`
        const record = state.commands[id]
        if (record === undefined) {
          return yield* new RunboxError({
            operation: "restart tracked command",
            message: `command '${id}' has never been tracked`,
            code: "COMMAND_NOT_TRACKED",
            suggestion: "Run 'runbox commands --json', start the command once, then retry restart.",
          })
        }
        if (state.source === null) {
          return yield* new RunboxError({
            operation: "restart tracked command",
            message: "runner has no active source",
            code: "RUNNER_NOT_INITIALIZED",
            suggestion: "Run 'runbox init' or start a package command in the project.",
          })
        }
        yield* workflow.stop(record.packagePath, record.script)
        yield* workflow.start(state.source, record.packagePath, record.script, record.args, record.sourceWatch)
        return success({ snapshot: yield* supervisor.snapshot(record.packagePath) })
      }
      case "configure": {
        yield* supervisor.setEnvironmentSourceRoot(request.environmentSourceRoot)
        return success({ message: "configured environment source" })
      }
      case "switch":
        yield* workflow.switchTo(request.source)
        return success({ message: `switched to ${request.source.branch ?? request.source.commit}` })
      case "activate":
        yield* workflow.activate(
          request.source,
          request.packagePath,
          request.script,
          request.args,
          request.watch ?? false,
        )
        return success({ snapshot: yield* supervisor.snapshot(request.packagePath) })
      case "forward":
        if (forwardObserver === undefined) {
          return yield* new RunboxError({
            operation: "forward command",
            message: "forward output observer is unavailable",
            code: "INTERNAL_ERROR",
          })
        }
        return success({
          forward: yield* workflow.forward(
            request.source,
            request.packagePath,
            request.argv,
            forwardObserver,
          ),
        })
      case "sync":
        return success({ sync: yield* workflow.sync(request.source, request.packagePath) })
      case "shutdown":
        yield* workflow.stopAll()
        return success({ message: "stopped" })
    }
  })

export const runDaemon = (
  project: ProjectContext,
  state: RepoState,
  socketPath: string,
): Effect.Effect<void, RunboxError> => {
  const SourceSyncLayer = SourceSync.layer(project, state.runnerPath).pipe(Layer.provideMerge(CoreLayer))
  const SupervisorLayer = Supervisor.layer(project, state).pipe(Layer.provideMerge(SourceSyncLayer))
  const AppLayer = Workflow.layer(project).pipe(Layer.provideMerge(SupervisorLayer))

  const lockPath = `${socketPath}.lock`
  let lockHeld = false
  const releaseLock = async (): Promise<void> => {
    if (!lockHeld) return
    lockHeld = false
    await rm(lockPath, { force: true })
  }
  const acquireLock = Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
      const result = spawnSync("/usr/bin/shlock", ["-p", String(process.pid), "-f", lockPath], {
        encoding: "utf8",
      })
      if (result.status !== 0) {
        const owner = await readFile(lockPath, "utf8").catch(() => "unknown")
        throw new Error(`daemon ${owner.trim()} already owns ${socketPath}`)
      }
      lockHeld = true
    },
    catch: (cause) => new RunboxError({ operation: "acquire daemon lock", message: String(cause) }),
  })

  const serve = Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        await rm(socketPath, { force: true })
      },
      catch: (cause) => new RunboxError({ operation: "prepare daemon socket", message: String(cause) }),
    })
    const runtime = yield* Effect.runtime<Supervisor | Workflow>()
    const runPromiseExit = Runtime.runPromiseExit(runtime)
    const runFork = Runtime.runFork(runtime)
    const mutex = yield* Effect.makeSemaphore(1)
    return yield* Effect.async<void, RunboxError>((resume) => {
      let shuttingDown = false
      let cleanupStarted = false
      const sockets = new Set<Socket>()
      const requestFibers = new Set<Fiber.RuntimeFiber<DaemonResponse, RunboxError>>()
      const server = createServer((socket) => {
        sockets.add(socket)
        socket.once("close", () => sockets.delete(socket))
        let input = ""
        socket.setEncoding("utf8")
        socket.on("error", () => socket.destroy())
        socket.on("data", (chunk: string) => {
          input += chunk
          if (Buffer.byteLength(input) > MAX_REQUEST_FRAME_BYTES) {
            socket.destroy()
            return
          }
          const newline = input.indexOf("\n")
          if (newline === -1) return
          const line = input.slice(0, newline)
          input = input.slice(newline + 1)
          let parsed: DaemonRequest
          try {
            parsed = Schema.decodeUnknownSync(DaemonRequestSchema)(JSON.parse(line))
          } catch (cause) {
            socket.end(encodeFrame({
              ok: false,
              error: toErrorInfo(new RunboxError({
                operation: "decode daemon request",
                message: String(cause),
                code: "INVALID_REQUEST",
                suggestion: "Upgrade the runbox client and retry the command.",
              })),
            }, MAX_RESPONSE_FRAME_BYTES))
            return
          }
          if (shuttingDown) {
            socket.end(encodeFrame({
              ok: false,
              error: toErrorInfo(new RunboxError({
                operation: "daemon request",
                message: "daemon is shutting down",
                code: "DAEMON_SHUTTING_DOWN",
                suggestion: "Retry once the current stop operation completes.",
                retryable: true,
              })),
            }, MAX_RESPONSE_FRAME_BYTES))
            return
          }
          const terminal = (parsed.type === "stop" && parsed.script === "all") || parsed.type === "shutdown"
          if (terminal) shuttingDown = true
          const observer = parsed.type === "forward"
            ? {
                onStart: (data: ForwardStart) => {
                  try {
                    if (!socket.write(encodeFrame({ type: "start", data }, MAX_RESPONSE_FRAME_BYTES))) socket.destroy()
                  } catch {
                    socket.destroy()
                  }
                },
                onOutput: (stream: "stdout" | "stderr", text: string) => {
                  try {
                    for (const part of splitUtf8(text, MAX_FORWARD_FRAME_BYTES - 256)) {
                      if (!socket.write(encodeFrame({ type: "output", stream, text: part }, MAX_FORWARD_FRAME_BYTES))) {
                        socket.destroy()
                        return
                      }
                    }
                  } catch {
                    socket.destroy()
                  }
                },
              }
            : undefined
          const requestEffect = parsed.type === "status" || parsed.type === "ping"
            ? handler(parsed, observer)
            : mutex.withPermits(1)(handler(parsed, observer))
          const fiber = runFork(requestEffect)
          requestFibers.add(fiber)
          let completed = false
          socket.once("close", () => {
            if (!completed) runFork(Fiber.interrupt(fiber))
          })
          void runPromiseExit(Fiber.join(fiber)).then((exit) => {
            completed = true
            requestFibers.delete(fiber)
            if (exit._tag === "Success") {
              try {
                socket.end(encodeFrame(exit.value, MAX_RESPONSE_FRAME_BYTES))
              } catch (cause) {
                socket.end(encodeFrame({
                  ok: false,
                  error: toErrorInfo(new RunboxError({
                    operation: "encode daemon response",
                    message: String(cause),
                    code: "RESPONSE_TOO_LARGE",
                    suggestion: "Inspect the daemon state and retry with a narrower request.",
                  })),
                }, MAX_RESPONSE_FRAME_BYTES))
              }
            }
            else {
              const failure = exit.cause._tag === "Fail" ? exit.cause.error : exit.cause
              socket.end(encodeFrame({ ok: false, error: toErrorInfo(failure) }, MAX_RESPONSE_FRAME_BYTES))
            }
            if (terminal && !cleanupStarted) {
              cleanupStarted = true
              const close = async () => {
                try {
                  await runPromiseExit(Effect.forEach(
                    [...requestFibers],
                    (active) => Fiber.interrupt(active),
                    { concurrency: "unbounded", discard: true },
                  ))
                  for (const connection of sockets) {
                    if (connection !== socket) connection.destroy()
                  }
                  await new Promise<void>((resolve) => server.close(() => resolve()))
                  await rm(socketPath, { force: true })
                } finally {
                  resume(Effect.void)
                }
              }
              void close()
            }
          })
        })
      })
      server.once("error", (cause) => {
        resume(Effect.fail(new RunboxError({ operation: "run daemon", message: String(cause) })))
      })
      server.listen(socketPath)
      return Effect.promise(async () => {
        for (const socket of sockets) socket.destroy()
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(socketPath, { force: true })
      })
    })
  }).pipe(Effect.provide(AppLayer))

  return Effect.acquireUseRelease(
    acquireLock,
    () => serve,
    () => Effect.promise(releaseLock),
  )
}
