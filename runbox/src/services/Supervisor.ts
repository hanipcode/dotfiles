import { Context, Deferred, Effect, Fiber, Layer, Ref, Runtime } from "effect"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { parseEnv } from "node:util"
import type { CommandRecord, ProjectContext, RepoSnapshot, RepoState, SourceRef } from "../domain.ts"
import { commandId } from "../domain.ts"
import { RunboxError, ScriptNotFound } from "../errors.ts"
import { LogStore } from "./LogStore.ts"
import { Metrics } from "./Metrics.ts"
import { Paths } from "./Paths.ts"
import { Project } from "./Project.ts"
import { StateStore } from "./StateStore.ts"

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
    readonly setEnvironmentSourceRoot: (root: string) => Effect.Effect<void, RunboxError>
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
        const runtime = yield* Effect.runtime<never>()
        const runFork = Runtime.runFork(runtime)
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
          expectedToken?: string,
        ) {
          const id = commandId(packagePath, script)
          const state = yield* Ref.get(stateRef)
          const existing = state.commands[id]
          if (expectedToken === undefined && existing !== undefined && activeStatuses.has(existing.status)) {
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
          if (record === undefined || !activeStatuses.has(record.status)) return
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
            yield* updateCommand(id, (value) => ({ ...value, status: "completed", pid: null, message: "stopped" }))
          }
        })

        const stopAll = Effect.fn("Supervisor.stopAll")(function* () {
          const state = yield* Ref.get(stateRef)
          const active = Object.values(state.commands).filter((record) => activeStatuses.has(record.status))
          yield* Effect.forEach(active, (record) => stop(record.packagePath, record.script), {
            concurrency: 1,
            discard: true,
          })
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
        const setEnvironmentSourceRoot = Effect.fn("Supervisor.setEnvironmentSourceRoot")(function* (root: string) {
          yield* persist((state) => ({ ...state, environmentSourceRoot: root }))
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
          setEnvironmentSourceRoot,
        })
      }),
    )
}
