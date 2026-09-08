import { Effect } from "effect"
import { access, appendFile, mkdir, open } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import {
  RUNBOX_PROTOCOL_VERSION,
  type DaemonRequest,
  type DaemonResponse,
  type ForwardResult,
  type ForwardStart,
  type ProjectContext,
  type RepoState,
  type SourceRef,
} from "./domain.ts"
import { RunboxError } from "./errors.ts"
import { request, requestForward } from "./ipc.ts"
import { Git } from "./services/Git.ts"
import { Paths } from "./services/Paths.ts"
import { StateStore } from "./services/StateStore.ts"
import { StorageMigration } from "./services/StorageMigration.ts"

const exists = (path: string) => access(path).then(() => true, () => false)

export const sourceRef = (project: ProjectContext): SourceRef => ({
  kind: "worktree",
  worktreePath: project.repoRoot,
  branch: project.branch,
  commit: project.commit,
  stack: null,
})

export const bootstrap = Effect.fn("Client.bootstrap")(function* (
  project: ProjectContext,
  environmentSourceOverride?: string,
) {
  const git = yield* Git
  const store = yield* StateStore
  const migration = yield* StorageMigration
  yield* migration.migrate(project)
  let state = yield* store.load(project)
  const environmentSourceRoot = yield* git.environmentSource(
    project,
    state,
    environmentSourceOverride,
  )
  if (state.environmentSourceRoot !== environmentSourceRoot) {
    state = { ...state, environmentSourceRoot }
    yield* store.save(state).pipe(
      Effect.mapError((error) =>
        new RunboxError({ operation: "configure environment source", message: error.message }),
      ),
    )
  }
  const runnerExisted = yield* Effect.promise(() => exists(state.runnerPath))
  yield* git.ensureRunner(project, state)
  if (!runnerExisted) {
    if (state.source !== null && state.source.commit !== project.commit) {
      yield* git.checkout(state, state.source)
      yield* git.updateSubmodules(state)
    }
  }
  yield* git.syncEnvironment(state)
  if (state.source === null) {
    state = { ...state, source: sourceRef(project) }
    yield* store.save(state).pipe(
      Effect.mapError((error) =>
        new RunboxError({ operation: "initialize runbox state", message: error.message }),
      ),
    )
  }
  return state
})

export const ensureDaemon = Effect.fn("Client.ensureDaemon")(function* (
  project: ProjectContext,
  state: RepoState,
) {
  const paths = yield* Paths
  const socketPath = paths.socket(project.repoId)
  let probe = yield* request(socketPath, {
    type: "status",
    packagePath: project.packagePath,
  }, 250).pipe(Effect.either)
  if (probe._tag === "Right" && probe.right.ok) return socketPath
  if (probe._tag === "Left" && probe.left.operation === "wait for daemon response") {
    return socketPath
  }
  for (let attempt = 0; attempt < 50 && probe._tag === "Right"; attempt += 1) {
    yield* Effect.sleep("100 millis")
    probe = yield* request(socketPath, { type: "status", packagePath: project.packagePath }, 250).pipe(
      Effect.either,
    )
    if (probe._tag === "Right" && probe.right.ok) return socketPath
    if (probe._tag === "Left" && probe.left.operation === "wait for daemon response") {
      return socketPath
    }
  }
  if (probe._tag === "Right") {
    return yield* new RunboxError({
      operation: "wait for runbox daemon shutdown",
      message: "the previous daemon is still shutting down",
      code: "DAEMON_SHUTTING_DOWN",
      suggestion: "Retry the command after the current stop operation completes.",
      retryable: true,
    })
  }

  const launchDaemon = Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
      const daemonLog = `${paths.repoState(project.repoId)}/daemon.log`
      await mkdir(dirname(daemonLog), { recursive: true })
      const handle = await open(daemonLog, "a")
      const entrypoint = fileURLToPath(new URL("../bin/daemon.ts", import.meta.url))
      const child = spawn(process.execPath, [entrypoint, project.packageDir], {
        detached: true,
        stdio: ["ignore", handle.fd, handle.fd],
        env: process.env,
      })
      child.once("error", (cause) => {
        void appendFile(daemonLog, `[runbox] failed to spawn daemon: ${String(cause)}\n`)
      })
      child.unref()
      await handle.close()
    },
    catch: (cause) => new RunboxError({ operation: "start runbox daemon", message: String(cause) }),
  })
  yield* launchDaemon

  for (let attempt = 0; attempt < 50; attempt += 1) {
    yield* Effect.sleep("100 millis")
    const response = yield* request(socketPath, {
      type: "status",
      packagePath: project.packagePath,
    }, 250).pipe(Effect.option)
    if (response._tag === "Some" && response.value.ok) return socketPath
    if (attempt > 0 && attempt % 10 === 0 && !(yield* Effect.promise(() => exists(socketPath)))) {
      yield* launchDaemon
    }
  }
  return yield* new RunboxError({
    operation: "start runbox daemon",
    message: `daemon did not create ${socketPath}; inspect ${paths.repoState(state.repoId)}/daemon.log`,
  })
})

export const daemonRequest = Effect.fn("Client.daemonRequest")(function* (
  socketPath: string,
  value: DaemonRequest,
) {
  const response = yield* request(socketPath, value)
  if (!response.ok) {
    return yield* new RunboxError({
      operation: response.error.operation,
      message: response.error.message,
      code: response.error.code,
      suggestion: response.error.suggestion,
      retryable: response.error.retryable,
      details: response.error.details,
    })
  }
  return response as Extract<DaemonResponse, { readonly ok: true }>
})

export const ensureDaemonConfigured = Effect.fn("Client.ensureDaemonConfigured")(function* (
  project: ProjectContext,
  state: RepoState,
) {
  let socket = yield* ensureDaemon(project, state)
  const status = yield* daemonRequest(socket, {
    type: "status",
    packagePath: project.packagePath,
  })
  const configure = () => state.environmentSourceRoot === null
    ? Effect.void
    : daemonRequest(socket, {
        type: "configure",
        environmentSourceRoot: state.environmentSourceRoot,
      }).pipe(Effect.asVoid)
  if (status.protocolVersion === RUNBOX_PROTOCOL_VERSION) {
    yield* configure()
    return socket
  }
  if (status.protocolVersion !== undefined && status.protocolVersion > RUNBOX_PROTOCOL_VERSION) {
    return yield* new RunboxError({
      operation: "connect to runbox daemon",
      message: `daemon protocol ${status.protocolVersion} is newer than client protocol ${RUNBOX_PROTOCOL_VERSION}`,
      code: "DAEMON_PROTOCOL_NEWER",
      suggestion: "Upgrade the runbox client before issuing repository commands.",
    })
  }

  const previous = status.snapshot
  yield* daemonRequest(socket, { type: "shutdown" }).pipe(
    Effect.catchAll((error) =>
      error.code === "DAEMON_UNAVAILABLE" ? Effect.void : Effect.fail(error)
    ),
  )
  yield* Effect.sleep("100 millis")
  socket = yield* ensureDaemon(project, state)
  yield* configure()
  if (previous?.state.source !== null && previous?.state.source !== undefined) {
    for (const record of Object.values(previous.state.commands)) {
      if (record.status !== "preparing" && record.status !== "starting" && record.status !== "running") continue
      yield* daemonRequest(socket, {
        type: "start",
        packagePath: record.packagePath,
        script: record.script,
        args: record.args,
        source: previous.state.source,
        watch: record.sourceWatch,
      })
    }
  }
  return socket
})

export const daemonForward = Effect.fn("Client.daemonForward")(function* (
  socketPath: string,
  value: Extract<DaemonRequest, { readonly type: "forward" }>,
  callbacks: {
    readonly onStart: (start: ForwardStart) => void
    readonly onOutput: (stream: "stdout" | "stderr", text: string) => void
  },
) {
  const response = yield* requestForward(socketPath, value, callbacks)
  if (!response.ok) {
    return yield* new RunboxError({
      operation: response.error.operation,
      message: response.error.message,
      code: response.error.code,
      suggestion: response.error.suggestion,
      retryable: response.error.retryable,
      details: response.error.details,
    })
  }
  if (response.forward === undefined) {
    return yield* new RunboxError({
      operation: "read forwarded command result",
      message: "daemon returned no forwarded command result",
      code: "INVALID_RESPONSE",
      suggestion: "Upgrade runbox and retry the command.",
    })
  }
  return response.forward satisfies ForwardResult
})
