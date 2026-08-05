import { Context, Effect, Fiber, Layer } from "effect"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { commandId, sameSource, type CommandRecord, type ProjectContext, type RepoState, type SourceRef } from "../domain.ts"
import { RunboxError, toErrorInfo } from "../errors.ts"
import { Agent } from "./Agent.ts"
import { Git } from "./Git.ts"
import { LogStore } from "./LogStore.ts"
import { Paths } from "./Paths.ts"
import { PreparationMemory } from "./PreparationMemory.ts"
import { Supervisor } from "./Supervisor.ts"

const exists = (path: string) => access(path).then(() => true, () => false)
const stabilizationMs = Number.isFinite(Number(process.env.RUNBOX_STABILIZATION_MS))
  ? Math.max(0, Number(process.env.RUNBOX_STABILIZATION_MS))
  : 180_000

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
    ) => Effect.Effect<CommandRecord, RunboxError>
    readonly stop: (packagePath: string, script: string) => Effect.Effect<void, RunboxError>
    readonly stopAll: () => Effect.Effect<ReadonlyArray<CommandRecord>, RunboxError>
    readonly switchTo: (source: SourceRef) => Effect.Effect<void, RunboxError>
    readonly activate: (
      source: SourceRef,
      packagePath: string,
      script: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<CommandRecord, RunboxError>
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
        const jobs = new Map<string, LaunchJob>()

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
        ) {
          const state = yield* supervisor.state
          yield* git.syncEnvironment(state)
          if (state.preparedCommits.includes(source.commit)) return
          const fingerprint = yield* git.setupFingerprint(state, source.commit)
          if (yield* memory.hasSuccess(state, fingerprint, packagePath, null)) {
            yield* supervisor.markPrepared(source.commit)
            return
          }
          const previous = state.preparedCommits.at(-1)
          if (previous !== undefined && !(yield* git.setupChanged(state, previous, source.commit))) {
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
                  new RunboxError({ operation: `start ${script}`, message: error.message }),
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
                token,
              )
              token = repair.record.processToken ?? token
              yield* prepareCommand(packagePath, script, output)
            }
          })

          yield* lifecycle.pipe(
            Effect.catchAll((error) => {
              const info = toErrorInfo(error)
              return supervisor.failPreparation(id, token, info.message).pipe(Effect.catchAll(() => Effect.void))
            }),
          )
        })

        const schedule = Effect.fn("Workflow.schedule")(function* (
          source: SourceRef,
          packagePath: string,
          script: string,
          args: ReadonlyArray<string>,
        ) {
          const state = yield* supervisor.state
          if (state.source !== null && !sameSource(state.source, source)) {
            return yield* new RunboxError({
              operation: `start ${script}`,
              message: `runner is on ${state.source.branch ?? "detached"}@${state.source.commit.slice(0, 8)}, not ${source.branch ?? "detached"}@${source.commit.slice(0, 8)}; run 'runbox switch' first`,
            })
          }
          const queued = yield* supervisor.prepare(packagePath, script, args, "queued for preparation")
          if (!queued.created) return queued.record
          const token = queued.record.processToken
          if (token === null) {
            return yield* new RunboxError({ operation: `start ${script}`, message: "queued command has no lifecycle token" })
          }
          const id = queued.record.id
          jobs.set(id, { token, fiber: null })
          const fiber = yield* runLifecycle(source, packagePath, script, args, token).pipe(
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
          return yield* supervisor.stopAll()
        })

        const waitUntilStarted = Effect.fn("Workflow.waitUntilStarted")(function* (id: string) {
          const deadline = Date.now() + 10 * 60_000
          while (Date.now() < deadline) {
            const record = (yield* supervisor.state).commands[id]
            if (record === undefined) return
            if (record.status === "running" || record.status === "completed") return
            if (record.status === "failed") {
              return yield* new RunboxError({
                operation: `start ${record.script}`,
                message: record.message ?? "command failed during startup",
              })
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

        const start = Effect.fn("Workflow.start")(function* (
          source: SourceRef,
          packagePath: string,
          script: string,
          args: ReadonlyArray<string>,
        ) {
          return yield* schedule(source, packagePath, script, args)
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

        const switchTo = Effect.fn("Workflow.switchTo")(function* (source: SourceRef) {
          const active = yield* stopAll()
          const state = yield* supervisor.state
          yield* git.checkout(state, source)
          yield* supervisor.setSource(source)
          yield* git.updateSubmodules(state)
          yield* prepareCommit(source, active[0]?.packagePath ?? project.packagePath)
          for (const record of active) {
            const queued = yield* schedule(source, record.packagePath, record.script, record.args)
            yield* waitUntilStarted(queued.id)
          }
        })

        const activate = Effect.fn("Workflow.activate")(function* (
          source: SourceRef,
          packagePath: string,
          script: string,
          args: ReadonlyArray<string>,
        ) {
          const state = yield* supervisor.state
          if (state.source === null || !sameSource(state.source, source)) {
            yield* switchTo(source)
          }
          return yield* schedule(source, packagePath, script, args)
        })

        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [...jobs.values()],
            (job) => job.fiber === null ? Effect.void : Fiber.interrupt(job.fiber),
            { concurrency: "unbounded", discard: true },
          ),
        )

        return Workflow.of({ setup, start, stop, stopAll, switchTo, activate })
      }),
    )
}
