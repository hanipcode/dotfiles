import { Context, Effect, Fiber, Layer, Runtime } from "effect"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { commandId, sameSource, type CommandRecord, type ProjectContext, type RepoState, type SourceRef, type SyncResult } from "../domain.ts"
import { commandFailureError, RunboxError, toErrorInfo } from "../errors.ts"
import { Agent } from "./Agent.ts"
import { Git } from "./Git.ts"
import { LogStore } from "./LogStore.ts"
import { Paths } from "./Paths.ts"
import { PreparationMemory } from "./PreparationMemory.ts"
import { Supervisor, type ForwardObserver } from "./Supervisor.ts"
import type { ForwardResult } from "../domain.ts"
import { SourceSync } from "./SourceSync.ts"

const exists = (path: string) => access(path).then(() => true, () => false)
const stabilizationMs = Number.isFinite(Number(process.env.RUNBOX_STABILIZATION_MS))
  ? Math.max(0, Number(process.env.RUNBOX_STABILIZATION_MS))
  : 180_000
const activeStatuses = new Set(["preparing", "starting", "running", "stopping"])

interface LaunchJob {
  readonly token: string
  readonly fiber: Fiber.RuntimeFiber<void, never> | null
}

export class Workflow extends Context.Tag("@runbox/Workflow")<
  Workflow,
  {
    readonly setup: (
      source: SourceRef,
      packagePath: string,
    ) => Effect.Effect<void, RunboxError>
    readonly start: (
      source: SourceRef,
      packagePath: string,
      script: string,
      args: ReadonlyArray<string>,
      watch?: boolean,
    ) => Effect.Effect<CommandRecord, RunboxError>
    readonly stop: (packagePath: string, script: string) => Effect.Effect<void, RunboxError>
    readonly stopAll: () => Effect.Effect<ReadonlyArray<CommandRecord>, RunboxError>
    readonly switchTo: (source: SourceRef) => Effect.Effect<void, RunboxError>
    readonly activate: (
      source: SourceRef,
      packagePath: string,
      script: string,
      args: ReadonlyArray<string>,
      watch?: boolean,
    ) => Effect.Effect<CommandRecord, RunboxError>
    readonly sync: (source: SourceRef, packagePath: string) => Effect.Effect<SyncResult, RunboxError>
    readonly forward: (
      source: SourceRef,
      packagePath: string,
      argv: ReadonlyArray<string>,
      observer: ForwardObserver,
    ) => Effect.Effect<ForwardResult, RunboxError>
  }
>() {
  static layer = (project: ProjectContext) =>
    Layer.scoped(
      Workflow,
      Effect.gen(function* () {
        const supervisor = yield* Supervisor
        const agent = yield* Agent
        const git = yield* Git
        const logs = yield* LogStore
        const paths = yield* Paths
        const memory = yield* PreparationMemory
        const sourceSync = yield* SourceSync
        const runtime = yield* Effect.runtime<never>()
        const runFork = Runtime.runFork(runtime)
        const mutation = yield* Effect.makeSemaphore(1)
        const jobs = new Map<string, LaunchJob>()
        let watchGuard: Fiber.RuntimeFiber<void, never> | null = null
        let watchSyncFiber: Fiber.RuntimeFiber<void, never> | null = null
        let watchSyncRunning = false
        let watchSyncPending = false
        let closing = false

        const recordReuse = Effect.fn("Workflow.recordPreparationReuse")(function* (
          state: RepoState,
          fingerprint: string,
          packagePath: string,
          script: string | null,
          message: string,
        ) {
          yield* memory.appendHistory(state.repoId, {
            kind: "run",
            phase: "succeeded",
            at: Date.now(),
            runId: randomUUID(),
            commit: state.source?.commit ?? "unbound",
            fingerprint,
            scope: script === null ? "setup" : "command",
            packagePath,
            script,
            durationMs: 0,
            message,
          })
        })

        const prepareCommit = Effect.fn("Workflow.prepareCommit")(function* (
          source: SourceRef,
          packagePath: string,
          force = false,
        ) {
          const state = yield* supervisor.state
          yield* git.syncEnvironment(state)
          if (!force && state.preparedCommits.includes(source.commit)) return
          const fingerprint = yield* git.setupFingerprint(state, source.commit)
          if (!force && (yield* memory.hasSuccess(state, fingerprint, packagePath, null))) {
            yield* supervisor.markPrepared(source.commit)
            return
          }
          const previous = state.preparedCommits.at(-1)
          if (!force && previous !== undefined && !(yield* git.setupChanged(state, previous, source.commit))) {
            yield* recordReuse(state, fingerprint, packagePath, null, `reused setup from ${previous}`)
            yield* supervisor.markPrepared(source.commit)
            return
          }
          const logFile = join(paths.repoState(state.repoId), "logs", "setup.log")
          yield* agent.prepare({ state, packagePath, script: null, logFile, fingerprint }).pipe(
            Effect.mapError((error) =>
              error instanceof RunboxError
                ? error
                : new RunboxError({
                    operation: "prepare commit",
                    message: "OpenCode changed protected runner state",
                    code: "AGENT_MUTATION_REJECTED",
                    suggestion: "Inspect setup logs and narrow .agents/runbox/setup.md before retrying.",
                    details: error.summary,
                  }),
            ),
          )
          yield* supervisor.markPrepared(source.commit)
        })

        const prepareCommand = Effect.fn("Workflow.prepareCommand")(function* (
          packagePath: string,
          script: string,
          failureOutput?: string,
        ) {
          const state = yield* supervisor.state
          const instruction = join(
            state.runnerPath,
            ".agents",
            "runbox",
            "instructions",
            packagePath,
            script,
          )
          const id = commandId(packagePath, script)
          const preparationKey = `${state.source?.commit ?? "unbound"}:${id}`
          if (failureOutput === undefined && state.preparedCommands.includes(preparationKey)) return
          const setupFingerprint = state.source === null
            ? "unbound"
            : yield* git.setupFingerprint(state, state.source.commit)
          const fingerprint = `${setupFingerprint}:${id}`
          if (
            failureOutput === undefined &&
            (yield* memory.hasSuccess(state, fingerprint, packagePath, script))
          ) {
            yield* supervisor.markCommandPrepared(preparationKey)
            return
          }
          if (failureOutput === undefined && state.source !== null) {
            const reusable = [...state.preparedCommands].reverse().find((key) => key.endsWith(`:${id}`))
            const previousCommit = reusable?.slice(0, reusable.indexOf(":"))
            if (
              previousCommit !== undefined &&
              previousCommit !== state.source.commit &&
              !(yield* git.setupChanged(state, previousCommit, state.source.commit))
            ) {
              yield* recordReuse(state, fingerprint, packagePath, script, `reused command setup from ${previousCommit}`)
              yield* supervisor.markCommandPrepared(preparationKey)
              return
            }
          }
          if (failureOutput === undefined && !(yield* Effect.promise(() => exists(instruction)))) return
          const logFile = state.commands[id]?.logFile ??
            join(paths.repoState(state.repoId), "logs", `${id.replaceAll("/", "_").replaceAll(":", "_")}.log`)
          yield* agent.prepare({
            state,
            packagePath,
            script,
            ...(failureOutput === undefined ? {} : { failureOutput }),
            logFile,
            fingerprint,
          }).pipe(
            Effect.mapError((error) =>
              error instanceof RunboxError
                ? error
                : new RunboxError({
                    operation: `prepare ${script}`,
                    message: "OpenCode changed protected runner state",
                    code: "AGENT_MUTATION_REJECTED",
                    suggestion: "Inspect command logs and narrow the runbox instruction before retrying.",
                    details: error.summary,
                  }),
            ),
          )
          yield* supervisor.markCommandPrepared(preparationKey)
        })

        const runLifecycle = Effect.fn("Workflow.runLifecycle")(function* (
          source: SourceRef,
          packagePath: string,
          script: string,
          args: ReadonlyArray<string>,
          initialToken: string,
        ) {
          const id = commandId(packagePath, script)
          let token = initialToken
          const lifecycle = Effect.gen(function* () {
            yield* supervisor.updatePreparation(id, token, "preparing repository with Luna")
            yield* prepareCommit(source, packagePath)
            yield* supervisor.updatePreparation(id, token, "preparing command")
            yield* prepareCommand(packagePath, script)

            for (let attempt = 0; attempt < 4; attempt += 1) {
              const record = yield* supervisor.start(packagePath, script, args, token).pipe(
                Effect.mapError((error) =>
                  error instanceof RunboxError ? error : new RunboxError(toErrorInfo(error)),
                ),
              )
              if (record.processToken === null) {
                return yield* new RunboxError({
                  operation: `start ${script}`,
                  message: "started command has no lifecycle token",
                })
              }
              token = record.processToken
              const outcome = record.status === "running" || record.status === "starting"
                ? yield* Effect.race(
                  Effect.sleep(stabilizationMs).pipe(Effect.as({ stable: true as const })),
                  supervisor.awaitExit(token).pipe(Effect.map((settled) => ({ stable: false as const, settled }))),
                )
                : { stable: false as const, settled: yield* supervisor.awaitExit(token) }
              if (outcome.stable || outcome.settled.status !== "failed") return
              if (attempt === 3) return

              const output = (yield* logs.tail(outcome.settled.logFile)).slice(-16 * 1024)
              const repair = yield* supervisor.prepare(
                packagePath,
                script,
                args,
                `repairing startup with Luna (${attempt + 1}/3)`,
                (yield* supervisor.state).commands[id]?.sourceWatch ?? false,
                token,
              )
              token = repair.record.processToken ?? token
              yield* prepareCommand(packagePath, script, output)
            }
          })

          yield* lifecycle.pipe(
            Effect.catchAll((error) => {
              const info = toErrorInfo(error)
              return supervisor.failPreparation(id, token, info).pipe(Effect.catchAll(() => Effect.void))
            }),
          )
        })

        const schedule = Effect.fn("Workflow.schedule")(function* (
          source: SourceRef,
          packagePath: string,
          script: string,
          args: ReadonlyArray<string>,
          watch = false,
        ) {
          const state = yield* supervisor.state
          if (state.source !== null && !sameSource(state.source, source)) {
            return yield* new RunboxError({
              operation: `start ${script}`,
              message: `runner is on ${state.source.branch ?? "detached"}@${state.source.commit.slice(0, 8)}, not ${source.branch ?? "detached"}@${source.commit.slice(0, 8)}; run 'runbox switch' first`,
            })
          }
          const queued = yield* supervisor.prepare(packagePath, script, args, "queued for preparation", watch)
          if (!queued.created) return queued.record
          const token = queued.record.processToken
          if (token === null) {
            return yield* new RunboxError({ operation: `start ${script}`, message: "queued command has no lifecycle token" })
          }
          const id = queued.record.id
          jobs.set(id, { token, fiber: null })
          const fiber = yield* runLifecycle(source, packagePath, script, args, token).pipe(
            Effect.interruptible,
            Effect.ensuring(Effect.sync(() => {
              if (jobs.get(id)?.token === token) jobs.delete(id)
            })),
            Effect.forkDaemon,
          )
          if (jobs.get(id)?.token === token) jobs.set(id, { token, fiber })
          return queued.record
        })

        const cancel = Effect.fn("Workflow.cancel")(function* (id: string) {
          const job = jobs.get(id)
          if (job?.fiber !== null && job?.fiber !== undefined) yield* Fiber.interrupt(job.fiber)
          if (jobs.get(id)?.token === job?.token) jobs.delete(id)
        })

        const stop = Effect.fn("Workflow.stop")(function* (packagePath: string, script: string) {
          yield* cancel(commandId(packagePath, script))
          yield* supervisor.stop(packagePath, script)
        })

        const stopAll = Effect.fn("Workflow.stopAll")(function* () {
          yield* Effect.forEach(
            [...jobs.values()],
            (job) => job.fiber === null ? Effect.void : Fiber.interrupt(job.fiber),
            { concurrency: "unbounded", discard: true },
          )
          jobs.clear()
          const watcherStop = yield* Effect.either(sourceSync.unwatch)
          const stopped = yield* supervisor.stopAll()
          if (watcherStop._tag === "Left") return yield* watcherStop.left
          return stopped
        })

        const waitUntilStarted = Effect.fn("Workflow.waitUntilStarted")(function* (id: string) {
          const deadline = Date.now() + 10 * 60_000
          while (Date.now() < deadline) {
            const record = (yield* supervisor.state).commands[id]
            if (record === undefined) return
            if (record.readiness === "failed" && !jobs.has(id)) return yield* commandFailureError(record)
            if ((record.status === "running" || record.status === "completed") && record.readiness !== "waiting" && record.readiness !== "failed") return
            if (record.status === "failed" && !jobs.has(id)) {
              return yield* commandFailureError(record)
            }
            yield* Effect.sleep(100)
          }
          return yield* new RunboxError({
            operation: "wait for command startup",
            message: "command did not start within ten minutes",
            code: "PREPARATION_TIMEOUT",
            suggestion: "Inspect runbox logs and retry the command.",
            retryable: true,
          })
        })

        const watchedCommands = Effect.fn("Workflow.watchedCommands")(function* () {
          const state = yield* supervisor.state
          return Object.values(state.commands).filter((record) =>
            record.sourceWatch && activeStatuses.has(record.status)
          )
        })

        const startWatchGuard = Effect.fn("Workflow.startWatchGuard")(function* () {
          if (watchGuard !== null) return
          watchGuard = yield* Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep("500 millis")
              const stopped = yield* mutation.withPermits(1)(Effect.gen(function* () {
                if ((yield* watchedCommands()).length > 0) return false
                return yield* sourceSync.unwatch.pipe(
                  Effect.as(true),
                  Effect.catchAll(() => Effect.succeed(false)),
                )
              }))
              if (stopped) return
            }
          }).pipe(
            Effect.interruptible,
            Effect.ensuring(Effect.sync(() => { watchGuard = null })),
            Effect.forkDaemon,
          )
        })

        const syncFailure = (error: unknown) =>
          logs.append(join(paths.repoState(project.repoId), "logs", "sync.log"), `${JSON.stringify({
            at: Date.now(),
            phase: "failed",
            error: toErrorInfo(error),
          })}\n`).pipe(Effect.catchAll(() => Effect.void))

        let watchSource: (source: SourceRef, packagePath: string) => Effect.Effect<void, RunboxError>

        const movingSyncInternal = Effect.fn("Workflow.movingSyncInternal")(function* (
          source: SourceRef,
          packagePath: string,
          _enableWatch: boolean,
        ) {
          const state = yield* supervisor.state
          const previous = state.source
          const sourceChanged = previous === null || !sameSource(previous, source)
          const keepWatching = _enableWatch || (yield* watchedCommands()).length > 0
          const restartRecords = sourceChanged
            ? Object.values(state.commands).filter((record) =>
                activeStatuses.has(record.status) && !record.sourceWatch
              )
            : []
          const stopForMove = Effect.forEach(restartRecords, (record) =>
            cancel(record.id).pipe(Effect.zipRight(supervisor.stop(record.packagePath, record.script))), {
            concurrency: 1,
            discard: true,
          })
          const restartedDuringMove = new Set<string>()
          const restartAfterMove = (target: SourceRef, track: boolean) => Effect.forEach(restartRecords, (record) =>
            schedule(target, record.packagePath, record.script, record.args, false).pipe(
              Effect.tap((queued) => Effect.sync(() => {
                if (track) restartedDuringMove.add(queued.id)
              })),
              Effect.flatMap((queued) => waitUntilStarted(queued.id)),
            ), {
            concurrency: 1,
            discard: true,
          })
          const apply = Effect.gen(function* () {
            if (sourceChanged) {
              yield* stopForMove
              yield* sourceSync.unwatch
              yield* git.checkout(state, source)
              yield* supervisor.setSource(source)
              yield* git.updateSubmodules(state)
              yield* git.syncEnvironment({ ...state, source })
            }
            const result = yield* sourceSync.reconcile(source)
            if (result.setupChanged) yield* supervisor.invalidatePreparation(source.commit)
            if (keepWatching) yield* watchSource(source, packagePath)
            yield* restartAfterMove(source, true)
            return result
          })
          return yield* Effect.uninterruptible(apply.pipe(Effect.catchAll((error) => {
            if (!sourceChanged || previous === null) return Effect.fail(error)
            return Effect.gen(function* () {
              const rollback = yield* Effect.gen(function* () {
                yield* Effect.forEach(restartRecords.filter((record) => restartedDuringMove.has(record.id)), (record) =>
                  cancel(record.id).pipe(Effect.zipRight(supervisor.stop(record.packagePath, record.script))), {
                  concurrency: 1,
                  discard: true,
                })
                restartedDuringMove.clear()
                let rollbackSource = previous
                if (previous.kind === "worktree" && previous.worktreePath !== null) {
                  rollbackSource = yield* git.sourceAt(previous.worktreePath, project.commonDir)
                }
                yield* sourceSync.unwatch
                yield* git.checkout(state, rollbackSource)
                yield* supervisor.setSource(rollbackSource)
                yield* git.updateSubmodules(state)
                yield* git.syncEnvironment({ ...state, source: rollbackSource })
                if (rollbackSource.kind === "worktree") {
                  const result = yield* sourceSync.reconcile(rollbackSource)
                  if (result.setupChanged) yield* supervisor.invalidatePreparation(rollbackSource.commit)
                  if (keepWatching) yield* watchSource(rollbackSource, packagePath)
                }
                yield* restartAfterMove(rollbackSource, false)
              }).pipe(Effect.either)
              if (rollback._tag === "Left") {
                yield* supervisor.stopAll().pipe(Effect.catchAll(() => Effect.succeed([])))
                return yield* new RunboxError({
                  operation: "rollback synchronized source",
                  message: "source activation failed and the previous source could not be restored",
                  code: "SYNC_ROLLBACK_FAILED",
                  suggestion: "Inspect 'runbox logs sync --json', repair the source worktree, then run 'runbox sync --json'.",
                  details: JSON.stringify({
                    activationError: toErrorInfo(error),
                    rollbackError: toErrorInfo(rollback.left),
                  }),
                })
              }
              return yield* error
            })
          })))
        })

        const handleInvalidation = (sourcePath: string, packagePath: string) => {
          if (closing) return
          if (watchSyncRunning) {
            watchSyncPending = true
            return
          }
          watchSyncRunning = true
          watchSyncFiber = runFork(Effect.gen(function* () {
            do {
              watchSyncPending = false
              yield* mutation.withPermits(1)(Effect.gen(function* () {
                const state = yield* supervisor.state
                if (state.source?.kind !== "worktree" || state.source.worktreePath !== sourcePath) return
                const next = yield* git.sourceAt(sourcePath, project.commonDir)
                yield* movingSyncInternal(next, packagePath, true)
              }).pipe(Effect.tapError(syncFailure), Effect.catchAll(() => Effect.void)))
            } while (watchSyncPending)
          }).pipe(Effect.ensuring(Effect.sync(() => {
            watchSyncRunning = false
            watchSyncFiber = null
            if (!closing && watchSyncPending) {
              watchSyncPending = false
              queueMicrotask(() => handleInvalidation(sourcePath, packagePath))
            }
          }))))
        }

        watchSource = Effect.fn("Workflow.watchSource")(function* (
          source: SourceRef,
          packagePath: string,
        ) {
          if (source.kind !== "worktree" || source.worktreePath === null) {
            yield* sourceSync.unwatch
            return
          }
          const sourcePath = source.worktreePath
          yield* sourceSync.watch(source, () => handleInvalidation(sourcePath, packagePath))
        })

        const cleanupUnownedWatcher = () => watchedCommands().pipe(
          Effect.flatMap((owners) => owners.length === 0 ? sourceSync.unwatch : Effect.void),
          Effect.catchAll(() => Effect.void),
        )

        const sync = Effect.fn("Workflow.sync")(function* (
          source: SourceRef,
          packagePath: string,
        ) {
          return yield* mutation.withPermits(1)(movingSyncInternal(source, packagePath, false))
        })

        const start = Effect.fn("Workflow.start")(function* (
          source: SourceRef,
          packagePath: string,
          script: string,
          args: ReadonlyArray<string>,
          watch = false,
        ) {
          return yield* Effect.uninterruptible(Effect.gen(function* () {
            if (watch) yield* mutation.withPermits(1)(movingSyncInternal(source, packagePath, true))
            const record = yield* schedule(source, packagePath, script, args, watch)
            if (watch) yield* startWatchGuard()
            return record
          }).pipe(Effect.tapError(() => watch ? cleanupUnownedWatcher() : Effect.void)))
        })

        const setup = Effect.fn("Workflow.setup")(function* (
          source: SourceRef,
          packagePath: string,
        ) {
          const state = yield* supervisor.state
          if (state.source !== null && !sameSource(state.source, source)) {
            return yield* new RunboxError({
              operation: "setup runner",
              message: `runner is on ${state.source.branch ?? "detached"}@${state.source.commit.slice(0, 8)}, not ${source.branch ?? "detached"}@${source.commit.slice(0, 8)}; use runbox switch`,
            })
          }
          yield* prepareCommit(source, packagePath)
        })

        const switchToInternal = Effect.fn("Workflow.switchToInternal")(function* (source: SourceRef) {
          const state = yield* supervisor.state
          const active = Object.values(state.commands).filter((record) => activeStatuses.has(record.status))
          const watched = active.find((record) => record.sourceWatch)
          const restoreCommands = (target: SourceRef, recovering: boolean) => Effect.gen(function* () {
            yield* git.checkout(state, target)
            yield* supervisor.setSource(target)
            yield* git.updateSubmodules(state)
            if (watched !== undefined && target.kind === "worktree") {
              const result = yield* sourceSync.reconcile(target)
              if (result.setupChanged) yield* supervisor.invalidatePreparation(target.commit)
            }
            // A failed setup can have changed ignored dependencies; cached success is not proof they still work.
            yield* prepareCommit(target, active[0]?.packagePath ?? project.packagePath, recovering)
            for (const record of active) {
              const queued = yield* schedule(target, record.packagePath, record.script, record.args, record.sourceWatch)
              yield* waitUntilStarted(queued.id)
            }
            if (watched !== undefined && target.kind === "worktree") {
              yield* watchSource(target, watched.packagePath)
              yield* startWatchGuard()
            }
          })
          yield* Effect.uninterruptible(Effect.gen(function* () {
            yield* stopAll()
            yield* restoreCommands(source, false)
          }).pipe(Effect.catchAll((activationError) => Effect.gen(function* () {
            const previous = state.source
            const rollback = yield* Effect.gen(function* () {
              yield* stopAll()
              if (previous !== null) yield* restoreCommands(previous, true)
            }).pipe(Effect.either)
            if (rollback._tag === "Left") {
              yield* stopAll().pipe(Effect.catchAll(() => Effect.succeed([])))
              return yield* new RunboxError({
                operation: "rollback source switch",
                message: "Source switch failed and the previous commands could not be restored",
                code: "SWITCH_ROLLBACK_FAILED",
                suggestion: "Inspect 'runbox logs sync --json' and setup logs, repair the source, then switch again.",
                details: JSON.stringify({ activationError: toErrorInfo(activationError), rollbackError: toErrorInfo(rollback.left) }),
              })
            }
            return yield* activationError
          })), Effect.tapError(syncFailure)))
        })

        const switchTo = Effect.fn("Workflow.switchTo")(function* (source: SourceRef) {
          yield* mutation.withPermits(1)(switchToInternal(source))
        })

        const activate = Effect.fn("Workflow.activate")(function* (
          source: SourceRef,
          packagePath: string,
          script: string,
          args: ReadonlyArray<string>,
          watch = false,
        ) {
          return yield* mutation.withPermits(1)(Effect.uninterruptible(Effect.gen(function* () {
            const state = yield* supervisor.state
            const previous = state.source
            const sourceChanged = previous !== null && !sameSource(previous, source)
            if (watch || (yield* watchedCommands()).length > 0) {
              yield* movingSyncInternal(source, packagePath, true)
            } else if (state.source === null || !sameSource(state.source, source)) {
              yield* switchToInternal(source)
            }
            const record = yield* schedule(source, packagePath, script, args, watch).pipe(Effect.catchAll((error) => {
              if (!sourceChanged || previous === null) return Effect.fail(error)
              const rollback = previous.kind === "worktree"
                ? movingSyncInternal(previous, packagePath, false)
                : switchToInternal(previous)
              return rollback.pipe(
                Effect.catchAll((rollbackError) => new RunboxError({
                  operation: "rollback failed activation",
                  message: "command scheduling failed and the previous source could not be restored",
                  code: "SYNC_ROLLBACK_FAILED",
                  suggestion: "Inspect 'runbox logs sync --json', repair the source worktree, then retry activation.",
                  details: JSON.stringify({
                    activationError: toErrorInfo(error),
                    rollbackError: toErrorInfo(rollbackError),
                  }),
                })),
                Effect.zipRight(Effect.fail(error)),
              )
            }))
            if (watch) {
              yield* startWatchGuard()
            }
            return record
          }).pipe(Effect.tapError(() => watch ? cleanupUnownedWatcher() : Effect.void))))
        })

        const forward = Effect.fn("Workflow.forward")(function* (
          source: SourceRef,
          packagePath: string,
          argv: ReadonlyArray<string>,
          observer: ForwardObserver,
        ) {
          return yield* mutation.withPermits(1)(Effect.gen(function* () {
            const state = yield* supervisor.state
            if ((yield* watchedCommands()).length > 0) {
              yield* movingSyncInternal(source, packagePath, true)
            } else if (state.source === null || !sameSource(state.source, source)) {
              yield* switchToInternal(source)
            } else {
              yield* prepareCommit(source, packagePath)
            }
            return yield* supervisor.forward(packagePath, argv, observer)
          }))
        })

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            closing = true
            watchSyncPending = false
            if (watchGuard !== null) yield* Fiber.interrupt(watchGuard)
            if (watchSyncFiber !== null) yield* Fiber.interrupt(watchSyncFiber)
            yield* Effect.forEach(
              [...jobs.values()],
              (job) => job.fiber === null ? Effect.void : Fiber.interrupt(job.fiber),
              { concurrency: "unbounded", discard: true },
            )
          }),
        )

        return Workflow.of({ setup, start, stop, stopAll, switchTo, activate, sync, forward })
      }),
    )
}
