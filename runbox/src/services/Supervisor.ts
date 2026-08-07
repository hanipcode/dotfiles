import { Context, Deferred, Effect, Fiber, Layer, Ref, Runtime } from "effect"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { parseEnv } from "node:util"
import type {
  CommandRecord,
  ForwardResult,
  ForwardStart,
  ProjectContext,
  RepoSnapshot,
  RepoState,
  SourceRef,
} from "../domain.ts"
import { commandId } from "../domain.ts"
import { RunboxError, ScriptNotFound } from "../errors.ts"
import { LogStore } from "./LogStore.ts"
import { Metrics } from "./Metrics.ts"
import { Paths } from "./Paths.ts"
import { Project } from "./Project.ts"
import { StateStore } from "./StateStore.ts"
import { Shell } from "./Shell.ts"
import { SourceSync } from "./SourceSync.ts"

const activeStatuses = new Set(["preparing", "starting", "running", "stopping"])
const startupGraceMs = Number.isFinite(Number(process.env.RUNBOX_STARTUP_GRACE_MS))
  ? Math.max(0, Number(process.env.RUNBOX_STARTUP_GRACE_MS))
  : 3_000

export const commandEnvironment = async (
  repoRoot: string,
  packageDir: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> => {
  let files: Record<string, string> = {}
  const root = resolve(repoRoot)
  let current = resolve(packageDir)
  const packageDirectories: Array<string> = []
  while (true) {
    const fromRoot = relative(root, current)
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) break
    const packageJson = await readFile(join(current, "package.json"), "utf8").catch(() => null)
    if (packageJson !== null) packageDirectories.push(current)
    if (current === root) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const directory of packageDirectories.reverse()) {
    for (const name of [".env", ".env.local"]) {
      const content = await readFile(join(directory, name), "utf8").catch(() => null)
      if (content !== null) {
        files = Object.fromEntries(
          Object.entries({ ...files, ...parseEnv(content) }).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        )
      }
    }
  }
  return { ...files, ...base }
}

export interface PreparedCommand {
  readonly record: CommandRecord
  readonly created: boolean
}

export interface ForwardObserver {
  readonly onStart: (start: ForwardStart) => void
  readonly onOutput: (stream: "stdout" | "stderr", text: string) => void
}

const elapsedSeconds = (value: string): number => {
  const dayParts = value.trim().split("-")
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0
  const clock = (dayParts.at(-1) ?? "0").split(":").map(Number)
  return days * 86_400 +
    (clock.length >= 3 ? (clock.at(-3) ?? 0) * 3_600 : 0) +
    (clock.at(-2) ?? 0) * 60 +
    (clock.at(-1) ?? 0)
}

export const ownsPersistedProcess = (record: CommandRecord): boolean => {
  if (record.pid === null || record.startedAt === null) return false
  if (record.processToken !== null) {
    const result = spawnSync("ps", ["eww", "-axo", "pgid=,command="], { encoding: "utf8" })
    const tokenMatches = result.status === 0 && result.stdout.split("\n").some((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/)
      return match !== null &&
        Number(match[1]) === record.pid &&
        (match[2] ?? "").includes(`RUNBOX_PROCESS_TOKEN=${record.processToken}`)
    })
    return tokenMatches
  }
  const result = spawnSync("ps", ["-p", String(record.pid), "-o", "etime="], { encoding: "utf8" })
  if (result.status !== 0 || result.stdout.trim() === "") return false
  const estimatedStart = Date.now() - elapsedSeconds(result.stdout) * 1_000
  return Math.abs(estimatedStart - record.startedAt) < 5_000
}

export class Supervisor extends Context.Tag("@runbox/Supervisor")<
  Supervisor,
  {
    readonly start: (
      packagePath: string,
      script: string,
      args: ReadonlyArray<string>,
      preparationToken: string,
    ) => Effect.Effect<CommandRecord, RunboxError | ScriptNotFound>
    readonly prepare: (
      packagePath: string,
      script: string,
      args: ReadonlyArray<string>,
      message: string,
      sourceWatch?: boolean,
      expectedToken?: string,
    ) => Effect.Effect<PreparedCommand, RunboxError>
    readonly updatePreparation: (
      id: string,
      token: string,
      message: string,
    ) => Effect.Effect<void, RunboxError>
    readonly failPreparation: (
      id: string,
      token: string,
      message: string,
    ) => Effect.Effect<void, RunboxError>
    readonly awaitExit: (processToken: string) => Effect.Effect<CommandRecord, RunboxError>
    readonly stop: (packagePath: string, script: string) => Effect.Effect<void, RunboxError>
    readonly stopAll: () => Effect.Effect<ReadonlyArray<CommandRecord>, RunboxError>
    readonly snapshot: (packagePath: string) => Effect.Effect<RepoSnapshot, RunboxError>
    readonly state: Effect.Effect<RepoState>
    readonly setSource: (source: SourceRef) => Effect.Effect<void, RunboxError>
    readonly markPrepared: (commit: string) => Effect.Effect<void, RunboxError>
    readonly markCommandPrepared: (key: string) => Effect.Effect<void, RunboxError>
    readonly invalidatePreparation: (commit: string) => Effect.Effect<void, RunboxError>
    readonly setEnvironmentSourceRoot: (root: string) => Effect.Effect<void, RunboxError>
    readonly forward: (
      packagePath: string,
      argv: ReadonlyArray<string>,
      observer: ForwardObserver,
    ) => Effect.Effect<ForwardResult, RunboxError>
  }
>() {
  static layer = (project: ProjectContext, initial: RepoState) =>
    Layer.scoped(
      Supervisor,
      Effect.gen(function* () {
        const projects = yield* Project
        const store = yield* StateStore
        const logs = yield* LogStore
        const metrics = yield* Metrics
        const paths = yield* Paths
        const shell = yield* Shell
        const sourceSync = yield* SourceSync
        const runtime = yield* Effect.runtime<never>()
        const runFork = Runtime.runFork(runtime)
        const runPromise = Runtime.runPromise(runtime)
        const stateRef = yield* Ref.make(initial)
        const stateMutex = yield* Effect.makeSemaphore(1)
        const children = new Map<string, { readonly token: string; readonly child: ChildProcess }>()
        const fibers = new Map<string, { readonly token: string; readonly fiber: Fiber.RuntimeFiber<number, RunboxError> }>()
        const exits = new Map<string, Deferred.Deferred<CommandRecord>>()
        const requestedStops = new Set<string>()

        const persist = Effect.fn("Supervisor.persist")(function* (
          update: (state: RepoState) => RepoState,
        ) {
          return yield* stateMutex.withPermits(1)(Effect.gen(function* () {
            const state = update(yield* Ref.get(stateRef))
            yield* store.save(state).pipe(
              Effect.mapError((error) =>
                new RunboxError({ operation: "persist supervisor state", message: error.message }),
              ),
            )
            yield* Ref.set(stateRef, state)
            return state
          }))
        })

        const updateCommand = (id: string, update: (record: CommandRecord) => CommandRecord) =>
          persist((state) => {
            const current = state.commands[id]
            if (current === undefined) return state
            return { ...state, commands: { ...state.commands, [id]: update(current) } }
          })

        const updateCommandForToken = (
          id: string,
          token: string,
          update: (record: CommandRecord) => CommandRecord,
        ) =>
          persist((state) => {
            const current = state.commands[id]
            if (current === undefined || current.processToken !== token) return state
            return { ...state, commands: { ...state.commands, [id]: update(current) } }
          })

        const observe = (child: ChildProcess, logFile: string): Promise<number> =>
          new Promise((resolve) => {
            child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
              runFork(logs.append(logFile, chunk))
            })
            child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
              runFork(logs.append(logFile, chunk))
            })
            child.once("error", (cause) => {
              runFork(logs.append(logFile, `\n[runbox] process error: ${String(cause)}\n`))
              resolve(-1)
            })
            child.once("close", (code) => resolve(code ?? -1))
          })

        const monitor = (
          id: string,
          pid: number,
          processToken: string,
          exit: Promise<number>,
          settled: Deferred.Deferred<CommandRecord>,
        ): Effect.Effect<number, RunboxError> =>
          Effect.promise(() => exit).pipe(
            Effect.tap((exitCode) => Effect.gen(function* () {
              if (!requestedStops.has(processToken)) {
                const descendantsRemain = yield* Effect.sync(() => {
                  try {
                    process.kill(-pid, 0)
                    return true
                  } catch {
                    return false
                  }
                })
                if (descendantsRemain) {
                  yield* Effect.sync(() => {
                    try {
                      process.kill(-pid, "SIGTERM")
                    } catch {
                      // The group exited between the probe and signal.
                    }
                  })
                  yield* Effect.sleep("1 second")
                  yield* Effect.sync(() => {
                    try {
                      process.kill(-pid, 0)
                      process.kill(-pid, "SIGKILL")
                    } catch {
                      // Descendants exited during the grace period.
                    }
                  })
                }
              }
              const next = yield* updateCommandForToken(id, processToken, (record) => ({
                  ...record,
                  status: requestedStops.delete(processToken)
                    ? "completed"
                    : exitCode === 0
                      ? "completed"
                      : "failed",
                  pid: null,
                  exitCode,
                  message: exitCode === 0 ? null : `exited with code ${exitCode}`,
                }))
              const current = next.commands[id]
              if (current !== undefined && current.processToken === processToken) {
                yield* Deferred.succeed(settled, current)
              }
            }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (children.get(id)?.token === processToken) children.delete(id)
                if (fibers.get(id)?.token === processToken) fibers.delete(id)
              }),
            ),
          )

        const prepare = Effect.fn("Supervisor.prepare")(function* (
          packagePath: string,
          script: string,
          args: ReadonlyArray<string>,
          message: string,
          sourceWatch = false,
          expectedToken?: string,
        ) {
          const id = commandId(packagePath, script)
          const state = yield* Ref.get(stateRef)
          const existing = state.commands[id]
          if (expectedToken === undefined && existing !== undefined && activeStatuses.has(existing.status)) {
            if (sourceWatch && !existing.sourceWatch) {
              const next = yield* updateCommand(id, (record) => ({ ...record, sourceWatch: true }))
              return { record: next.commands[id] ?? existing, created: false }
            }
            return { record: existing, created: false }
          }
          if (expectedToken !== undefined && existing?.processToken !== expectedToken) {
            return yield* new RunboxError({
              operation: `prepare ${script}`,
              message: "command lifecycle was replaced",
              code: "COMMAND_REPLACED",
              suggestion: "Refresh command status before retrying.",
              retryable: true,
            })
          }
          const token = randomUUID()
          const logFile = existing?.logFile ??
            join(paths.repoState(state.repoId), "logs", `${id.replaceAll("/", "_").replaceAll(":", "_")}.log`)
          const record: CommandRecord = {
            id,
            packagePath,
            script,
            args: [...args],
            status: "preparing",
            pid: null,
            startedAt: null,
            exitCode: null,
            message,
            logFile,
            processToken: token,
            sourceWatch,
          }
          yield* persist((current) => ({
            ...current,
            commands: { ...current.commands, [id]: record },
          }))
          return { record, created: true }
        })

        const updatePreparation = Effect.fn("Supervisor.updatePreparation")(function* (
          id: string,
          token: string,
          message: string,
        ) {
          yield* updateCommandForToken(id, token, (record) => ({ ...record, message }))
        })

        const failPreparation = Effect.fn("Supervisor.failPreparation")(function* (
          id: string,
          token: string,
          message: string,
        ) {
          yield* updateCommandForToken(id, token, (record) => ({
            ...record,
            status: "failed",
            pid: null,
            exitCode: -1,
            message,
          }))
        })

        const awaitExit = Effect.fn("Supervisor.awaitExit")(function* (processToken: string) {
          const settled = exits.get(processToken)
          if (settled === undefined) {
            return yield* new RunboxError({
              operation: "watch command startup",
              message: "command exit is no longer observable",
              code: "COMMAND_REPLACED",
              suggestion: "Refresh command status before retrying.",
              retryable: true,
            })
          }
          return yield* Deferred.await(settled).pipe(
            Effect.ensuring(Effect.sync(() => exits.delete(processToken))),
          )
        })

        const start = Effect.fn("Supervisor.start")(function* (
          packagePath: string,
          script: string,
          args: ReadonlyArray<string>,
          preparationToken: string,
        ) {
          const id = commandId(packagePath, script)
          const state = yield* Ref.get(stateRef)
          const existing = state.commands[id]
          if (existing?.status !== "preparing" || existing.processToken !== preparationToken) {
            return yield* new RunboxError({
              operation: `start ${script}`,
              message: "command lifecycle was replaced",
              code: "COMMAND_REPLACED",
              suggestion: "Refresh command status before retrying.",
              retryable: true,
            })
          }
          const packageDir = join(state.runnerPath, packagePath)
          const runnerProject: ProjectContext = {
            ...project,
            repoRoot: state.runnerPath,
            packageDir,
            packagePath,
            packageJsonPath: join(packageDir, "package.json"),
            commit: state.source?.commit ?? project.commit,
          }
          const info = yield* projects.requireScript(runnerProject, script).pipe(
            Effect.mapError((error) =>
              error._tag === "ScriptNotFound"
                ? error
                : new RunboxError({ operation: "load runner package", message: error.message }),
            ),
          )
          const argv = projects.command(info, script, args)
          const [executable, ...commandArgs] = argv
          if (executable === undefined) {
            return yield* new RunboxError({ operation: "start command", message: "empty command" })
          }
          const logFile = join(paths.repoState(state.repoId), "logs", `${id.replaceAll("/", "_").replaceAll(":", "_")}.log`)
          yield* logs.append(logFile, `\n[runbox] ${argv.join(" ")}\n`)
          const processToken = randomUUID()
          const wrapper = fileURLToPath(new URL("../../bin/process-wrapper.ts", import.meta.url))
          const env = yield* Effect.tryPromise({
            try: () => commandEnvironment(state.runnerPath, packageDir),
            catch: (cause) => new RunboxError({ operation: "load command environment", message: String(cause) }),
          })
          const child = yield* Effect.try({
            try: () =>
              spawn(process.execPath, [wrapper, executable, ...commandArgs], {
                cwd: packageDir,
                env: { ...env, RUNBOX_PROCESS_TOKEN: processToken },
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
              }),
            catch: (cause) => new RunboxError({ operation: "spawn command", message: String(cause) }),
          })
          if (child.pid === undefined) {
            return yield* new RunboxError({ operation: "spawn command", message: "process has no pid" })
          }
          const exit = observe(child, logFile)
          const settled = yield* Deferred.make<CommandRecord>()
          exits.set(processToken, settled)
          children.set(id, { token: processToken, child })
          const record: CommandRecord = {
            id,
            packagePath,
            script,
            args: [...args],
            status: "starting",
            pid: child.pid,
            startedAt: Date.now(),
            exitCode: null,
            message: null,
            logFile,
            processToken,
            sourceWatch: existing.sourceWatch,
          }
          yield* persist((current) => ({
            ...current,
            commands: { ...current.commands, [id]: record },
          }))
          const fiber = yield* monitor(id, child.pid, processToken, exit, settled).pipe(Effect.forkDaemon)
          fibers.set(id, { token: processToken, fiber })
          yield* Effect.sleep(startupGraceMs)
          const after = yield* Ref.get(stateRef)
          const current = after.commands[id]
          if (current?.status === "starting" && current.processToken === processToken) {
            yield* updateCommandForToken(id, processToken, (value) => ({ ...value, status: "running" }))
          }
          return (yield* Ref.get(stateRef)).commands[id] ?? record
        })

        const stop = Effect.fn("Supervisor.stop")(function* (packagePath: string, script: string) {
          const id = commandId(packagePath, script)
          const state = yield* Ref.get(stateRef)
          const record = state.commands[id]
          if (record === undefined) return
          if (!activeStatuses.has(record.status)) {
            if (record.sourceWatch) yield* updateCommand(id, (value) => ({ ...value, sourceWatch: false }))
            return
          }
          if (record.processToken !== null) requestedStops.add(record.processToken)
          yield* updateCommand(id, (value) => ({ ...value, status: "stopping" }))
          const pid = record.pid
          if (pid !== null) {
            yield* Effect.sync(() => {
              try {
                process.kill(-pid, "SIGTERM")
              } catch {
                // Already gone.
              }
            })
            yield* Effect.sleep("3 seconds")
            yield* Effect.sync(() => {
              try {
                process.kill(-pid, 0)
                process.kill(-pid, "SIGKILL")
              } catch {
                // Graceful stop completed.
              }
            })
          }
          const running = fibers.get(id)
          if (running !== undefined) yield* Fiber.await(running.fiber)
          else if (record.processToken !== null) requestedStops.delete(record.processToken)
          const latest = (yield* Ref.get(stateRef)).commands[id]
          if (latest?.status === "stopping") {
            yield* updateCommand(id, (value) => ({
              ...value,
              status: "completed",
              pid: null,
              message: "stopped",
              sourceWatch: false,
            }))
          }
        })

        const stopAll = Effect.fn("Supervisor.stopAll")(function* () {
          const state = yield* Ref.get(stateRef)
          const active = Object.values(state.commands).filter((record) => activeStatuses.has(record.status))
          yield* Effect.forEach(active, (record) => stop(record.packagePath, record.script), {
            concurrency: 1,
            discard: true,
          })
          yield* persist((current) => ({
            ...current,
            commands: Object.fromEntries(
              Object.entries(current.commands).map(([id, record]) => [
                id,
                record.sourceWatch ? { ...record, sourceWatch: false } : record,
              ]),
            ),
          }))
          return active
        })

        const snapshot = Effect.fn("Supervisor.snapshot")(function* (packagePath: string) {
          const state = yield* Ref.get(stateRef)
          const packageDir = join(state.runnerPath, packagePath)
          const runnerProject: ProjectContext = {
            ...project,
            repoRoot: state.runnerPath,
            packageDir,
            packagePath,
            packageJsonPath: join(packageDir, "package.json"),
          }
          const info = yield* projects.packageInfo(runnerProject).pipe(
            Effect.mapError((error) =>
              new RunboxError({ operation: "load dashboard scripts", message: error.message }),
            ),
          )
          const records = Object.values(state.commands)
          const outputLogs: Record<string, string> = {}
          yield* Effect.forEach(records, (record) =>
            logs.tail(record.logFile).pipe(
              Effect.tap((text) => Effect.sync(() => { outputLogs[record.id] = text })),
            ), { concurrency: "unbounded", discard: true })
          outputLogs.setup = yield* logs.tail(join(paths.repoState(state.repoId), "logs", "setup.log"))
          const pids = records.flatMap((record) => record.pid === null ? [] : [record.pid])
          const byPid = yield* metrics.forPids(pids)
          const commandMetrics: RepoSnapshot["metrics"] = Object.fromEntries(
            records.flatMap((record) => {
              const value = record.pid === null ? undefined : byPid[String(record.pid)]
              return value === undefined ? [] : [[record.id, value]]
            }),
          )
          return {
            state,
            scripts: Object.keys(info.scripts).sort(),
            packagePath,
            logs: outputLogs,
            metrics: commandMetrics,
            sync: yield* sourceSync.snapshot,
          }
        })

        const setSource = Effect.fn("Supervisor.setSource")(function* (source: SourceRef) {
          yield* persist((state) => ({ ...state, source }))
        })
        const markPrepared = Effect.fn("Supervisor.markPrepared")(function* (commit: string) {
          yield* persist((state) => ({
            ...state,
            preparedCommits: state.preparedCommits.includes(commit)
              ? state.preparedCommits
              : [...state.preparedCommits, commit],
          }))
        })
        const markCommandPrepared = Effect.fn("Supervisor.markCommandPrepared")(function* (key: string) {
          yield* persist((state) => ({
            ...state,
            preparedCommands: state.preparedCommands.includes(key)
              ? state.preparedCommands
              : [...state.preparedCommands, key],
          }))
        })
        const invalidatePreparation = Effect.fn("Supervisor.invalidatePreparation")(function* (commit: string) {
          yield* persist((state) => ({
            ...state,
            preparedCommits: state.preparedCommits.filter((value) => value !== commit),
            preparedCommands: state.preparedCommands.filter((value) => !value.startsWith(`${commit}:`)),
          }))
        })
        const setEnvironmentSourceRoot = Effect.fn("Supervisor.setEnvironmentSourceRoot")(function* (root: string) {
          yield* persist((state) => ({ ...state, environmentSourceRoot: root }))
        })

        const forward = Effect.fn("Supervisor.forward")(function* (
          packagePath: string,
          argv: ReadonlyArray<string>,
          observer: ForwardObserver,
        ) {
          const state = yield* Ref.get(stateRef)
          if (state.source === null) {
            return yield* new RunboxError({
              operation: "forward command",
              message: "runner has no active source",
              code: "RUNNER_NOT_INITIALIZED",
              suggestion: "Run 'runbox init' or start a package command, then retry.",
            })
          }
          const executable = argv[0]
          if (executable === undefined) {
            return yield* new RunboxError({
              operation: "forward command",
              message: "the forwarded command is empty",
              code: "INVALID_ARGUMENT",
              suggestion: "Pass the complete command, for example 'runbox forward pnpm install'.",
            })
          }
          const cwd = join(state.runnerPath, packagePath)
          const invocationId = randomUUID()
          const startedAt = Date.now()
          const logFile = join(paths.repoState(state.repoId), "logs", "forward.log")
          const start: ForwardStart = {
            invocationId,
            argv: [...argv],
            cwd,
            sourceCommit: state.source.commit,
            startedAt,
            logFile,
          }

          const warnings: Array<{ code: string; message: string }> = []
          const header = `\n[runbox forward ${invocationId}] ${JSON.stringify({
            argv,
            cwd,
            sourceCommit: state.source.commit,
            startedAt,
          })}\n`
          const initialLog = yield* logs.append(logFile, header).pipe(Effect.either)
          if (initialLog._tag === "Left") {
            warnings.push({ code: "FORWARD_LOG_INCOMPLETE", message: initialLog.left.message })
          }
          let logQueue = Promise.resolve()
          let logFailure: string | null = null
          const appendLog = (text: string) => {
            logQueue = logQueue.then(() => runPromise(logs.append(logFile, text))).catch((cause) => {
              logFailure = String(cause)
            })
          }
          const env = yield* Effect.tryPromise({
            try: () => commandEnvironment(state.runnerPath, cwd),
            catch: (cause) => new RunboxError({
              operation: "load forwarded command environment",
              message: String(cause),
              code: "FORWARD_ENVIRONMENT_FAILED",
              suggestion: "Check the selected package path and its .env files, then retry.",
              retryable: true,
              details: JSON.stringify({ invocationId, argv, cwd, started: false }),
            }),
          })
          const output = yield* shell.run(argv, {
            cwd,
            env,
            allowFailure: true,
            onStart: () => observer.onStart(start),
            onStdout: (text) => {
              observer.onOutput("stdout", text)
              appendLog(text)
            },
            onStderr: (text) => {
              observer.onOutput("stderr", text)
              appendLog(text)
            },
          }).pipe(
            Effect.mapError((error) => {
              const executableMissing = error.exitCode === -1 && (
                error.stderr.toLowerCase().includes("enoent") ||
                error.stderr.toLowerCase().includes("executable not found")
              )
              return new RunboxError({
                operation: "start forwarded command",
                message: error.stderr,
                code: executableMissing ? "FORWARD_EXECUTABLE_NOT_FOUND" : "FORWARD_START_FAILED",
                suggestion: executableMissing
                  ? `Ensure '${executable}' is installed in the managed runner or pass an executable path.`
                  : "Inspect the forward log and run 'runbox doctor --json' before retrying.",
                details: JSON.stringify({ invocationId, argv, cwd, started: false }),
              })
            }),
          )
          const finishedAt = Date.now()
          const signal = output.signal ?? null
          appendLog(`\n[runbox forward ${invocationId}] ${JSON.stringify({
            exitCode: output.exitCode,
            signal,
            durationMs: finishedAt - startedAt,
            finishedAt,
          })}\n`)
          yield* Effect.promise(() => logQueue)
          if (logFailure !== null && !warnings.some((warning) => warning.code === "FORWARD_LOG_INCOMPLETE")) {
            warnings.push({ code: "FORWARD_LOG_INCOMPLETE", message: logFailure })
          }
          return {
            ...start,
            started: true as const,
            finishedAt,
            durationMs: finishedAt - startedAt,
            exitCode: output.exitCode,
            signal,
            warnings,
          }
        })

        const stalePids = Object.values(initial.commands).flatMap((record) =>
          activeStatuses.has(record.status) && ownsPersistedProcess(record) && record.pid !== null
            ? [record.pid]
            : [],
        )
        yield* Effect.forEach(stalePids, (pid) =>
          Effect.sync(() => {
            try {
              process.kill(-pid, "SIGTERM")
            } catch {
              // The stale process group may already be gone.
            }
          }), { discard: true })
        if (stalePids.length > 0) {
          yield* Effect.sleep("1 second")
          yield* Effect.forEach(stalePids, (pid) =>
            Effect.sync(() => {
              try {
                process.kill(-pid, 0)
                process.kill(-pid, "SIGKILL")
              } catch {
                // Graceful stale cleanup completed.
              }
            }), { discard: true })
        }

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const { child } of children.values()) {
              try {
                if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM")
              } catch {
                // Child already exited.
              }
            }
          }),
        )

        const stale = {
          ...initial,
          commands: Object.fromEntries(
            Object.entries(initial.commands).map(([id, record]) => [
              id,
              activeStatuses.has(record.status)
                ? { ...record, status: "stale" as const, pid: null, message: "daemon restarted" }
                : record,
            ]),
          ),
        }
        yield* Ref.set(stateRef, stale)
        yield* store.save(stale).pipe(Effect.orDie)

        return Supervisor.of({
          prepare,
          updatePreparation,
          failPreparation,
          start,
          awaitExit,
          stop,
          stopAll,
          snapshot,
          state: Ref.get(stateRef),
          setSource,
          markPrepared,
          markCommandPrepared,
          invalidatePreparation,
          setEnvironmentSourceRoot,
          forward,
        })
      }),
    )
}
