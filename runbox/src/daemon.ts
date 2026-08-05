import { Effect, Layer, Runtime, Schema } from "effect"
import { createServer } from "node:net"
import { mkdir, readFile, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { spawnSync } from "node:child_process"
import { DaemonRequestSchema, stateRevision, type DaemonRequest, type DaemonResponse, type ProjectContext, type RepoState } from "./domain.ts"
import { RunboxError, toErrorInfo } from "./errors.ts"
import { CoreLayer } from "./layers.ts"
import { Supervisor } from "./services/Supervisor.ts"
import { Workflow } from "./services/Workflow.ts"

const handler = (request: DaemonRequest) =>
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
        return { ok: true, message: "ready" } satisfies DaemonResponse
      case "status":
        return { ok: true, snapshot: yield* supervisor.snapshot(request.packagePath) } satisfies DaemonResponse
      case "start":
        yield* workflow.start(request.source, request.packagePath, request.script, request.args)
        return {
          ok: true,
          snapshot: yield* supervisor.snapshot(request.packagePath),
        } satisfies DaemonResponse
      case "setup":
        yield* workflow.setup(request.source, request.packagePath)
        return { ok: true, message: `prepared ${request.source.commit.slice(0, 8)}` } satisfies DaemonResponse
      case "stop":
        if (request.script === "all") yield* workflow.stopAll()
        else yield* workflow.stop(request.packagePath, request.script)
        return {
          ok: true,
          snapshot: yield* supervisor.snapshot(request.packagePath),
        } satisfies DaemonResponse
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
        yield* workflow.start(state.source, record.packagePath, record.script, record.args)
        return {
          ok: true,
          snapshot: yield* supervisor.snapshot(record.packagePath),
        } satisfies DaemonResponse
      }
      case "configure": {
        yield* supervisor.setEnvironmentSourceRoot(request.environmentSourceRoot)
        return { ok: true, message: "configured environment source" } satisfies DaemonResponse
      }
      case "switch":
        yield* workflow.switchTo(request.source)
        return { ok: true, message: `switched to ${request.source.branch ?? request.source.commit}` } satisfies DaemonResponse
      case "activate":
        yield* workflow.activate(request.source, request.packagePath, request.script, request.args)
        return {
          ok: true,
          snapshot: yield* supervisor.snapshot(request.packagePath),
        } satisfies DaemonResponse
      case "shutdown":
        yield* workflow.stopAll()
        return { ok: true, message: "stopped" } satisfies DaemonResponse
    }
  })

export const runDaemon = (
  project: ProjectContext,
  state: RepoState,
  socketPath: string,
): Effect.Effect<never, RunboxError> => {
  const SupervisorLayer = Supervisor.layer(project, state).pipe(Layer.provideMerge(CoreLayer))
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
      const mutex = yield* Effect.makeSemaphore(1)
      return yield* Effect.async<never, RunboxError>((resume) => {
        let shuttingDown = false
        let cleanupStarted = false
        const server = createServer((socket) => {
          let input = ""
          socket.setEncoding("utf8")
          socket.on("error", () => socket.destroy())
        socket.on("data", (chunk: string) => {
          input += chunk
          const newline = input.indexOf("\n")
          if (newline === -1) return
          const line = input.slice(0, newline)
          input = input.slice(newline + 1)
          let parsed: DaemonRequest
          try {
            parsed = Schema.decodeUnknownSync(DaemonRequestSchema)(JSON.parse(line))
          } catch (cause) {
            socket.end(`${JSON.stringify({
              ok: false,
              error: toErrorInfo(new RunboxError({
                operation: "decode daemon request",
                message: String(cause),
                code: "INVALID_REQUEST",
                suggestion: "Upgrade the runbox client and retry the command.",
              })),
            })}\n`)
            return
          }
          if (shuttingDown) {
            socket.end(`${JSON.stringify({
              ok: false,
              error: toErrorInfo(new RunboxError({
                operation: "daemon request",
                message: "daemon is shutting down",
                code: "DAEMON_SHUTTING_DOWN",
                suggestion: "Retry once the current stop operation completes.",
                retryable: true,
              })),
            })}\n`)
            return
          }
          const terminal = (parsed.type === "stop" && parsed.script === "all") || parsed.type === "shutdown"
          if (terminal) shuttingDown = true
          const requestEffect = parsed.type === "status" || parsed.type === "ping"
            ? handler(parsed)
            : mutex.withPermits(1)(handler(parsed))
          void runPromiseExit(requestEffect).then((exit) => {
            if (exit._tag === "Success") socket.end(`${JSON.stringify(exit.value)}\n`)
            else {
              const failure = exit.cause._tag === "Fail" ? exit.cause.error : exit.cause
              socket.end(`${JSON.stringify({ ok: false, error: toErrorInfo(failure) })}\n`)
            }
            if (terminal && !cleanupStarted) {
              cleanupStarted = true
              void rm(socketPath, { force: true }).finally(() => {
                server.close(() => {
                  void releaseLock().finally(() => process.exit(0))
                })
              })
            }
          })
        })
      })
      server.once("error", (cause) => {
        resume(Effect.fail(new RunboxError({ operation: "run daemon", message: String(cause) })))
      })
      server.listen(socketPath)
      return Effect.promise(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(socketPath, { force: true })
        await releaseLock()
      })
    })
  }).pipe(Effect.provide(AppLayer))

  return acquireLock.pipe(
    Effect.zipRight(
      serve.pipe(Effect.ensuring(Effect.promise(releaseLock))),
    ),
  )
}
