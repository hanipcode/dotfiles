import { Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { ActionPlan, ActionReceipt, CommitRequest, GlobalView, InspectionQuery, OperatorIntent } from "./model.ts"
import { bootstrap, daemonRequest, ensureDaemonConfigured, sourceRef } from "../client.ts"
import { generateCommitMessage } from "../commit.ts"
import { sameSource, stateRevision } from "../domain.ts"
import { DirtyWorktree, InvalidState, RunboxError, ScriptNotFound } from "../errors.ts"
import { Git } from "../services/Git.ts"
import { Paths } from "../services/Paths.ts"
import { Project } from "../services/Project.ts"
import { Registry } from "../services/Registry.ts"
import { RepositoryCatalog } from "../services/RepositoryCatalog.ts"
import { StateStore } from "../services/StateStore.ts"
import { StorageMigration } from "../services/StorageMigration.ts"
import { Shell } from "../services/Shell.ts"

const activeStatuses = new Set(["preparing", "starting", "running", "stopping"])

export class RunboxApplication extends Context.Tag("@runbox/RunboxApplication")<
  RunboxApplication,
  {
    readonly inspect: (query?: InspectionQuery) => Effect.Effect<GlobalView, RunboxError>
    readonly plan: (intent: OperatorIntent) => Effect.Effect<ActionPlan, RunboxError | InvalidState | ScriptNotFound>
    readonly execute: (
      plan: ActionPlan,
    ) => Effect.Effect<
      ActionReceipt,
      RunboxError | InvalidState | DirtyWorktree | ScriptNotFound,
      Git | Paths | StateStore | StorageMigration
    >
    readonly commit: (request: CommitRequest) => Effect.Effect<ActionPlan, RunboxError | InvalidState | ScriptNotFound, Shell>
  }
>() {
  static readonly layer = Layer.effect(
    RunboxApplication,
    Effect.gen(function* () {
      const catalog = yield* RepositoryCatalog
      const registry = yield* Registry
      const projects = yield* Project
      const git = yield* Git
      const consumedPlans = new Set<string>()
      const stateFor = (repoId: string) => registry.resolve(repoId)

      const plan = Effect.fn("RunboxApplication.plan")(function* (intent: OperatorIntent) {
        const state = yield* stateFor(intent.repoId)
        const effects: string[] = []
        let dirtySummary: string | null = null
        let dirtyFingerprint: string | null = null
        const entry = (yield* registry.scan()).find((candidate) => candidate.repoId === intent.repoId)
        if (entry?.storage === "legacy") effects.push("Migrate legacy storage to ~/.runbox when the daemon is idle")
        if (intent.type === "run" || intent.type === "switch") {
          const packageDirectory = join(intent.worktreePath, intent.packagePath)
          const project = yield* projects.discover(packageDirectory)
          if (project.repoId !== intent.repoId) {
            return yield* new RunboxError({
              operation: "plan global action",
              message: "selected worktree belongs to another repository",
              code: "SOURCE_CHANGED",
            })
          }
          if (project.commit !== intent.expectedHead) {
            return yield* new RunboxError({
              operation: "plan global action",
              message: `selected worktree moved from ${intent.expectedHead.slice(0, 8)} to ${project.commit.slice(0, 8)}`,
              code: "SOURCE_CHANGED",
              suggestion: "Refresh the dashboard and review the action again.",
              retryable: true,
            })
          }
          dirtySummary = yield* git.dirty(project)
          if (dirtySummary !== "") {
            dirtyFingerprint = yield* git.dirtyFingerprint(project)
            effects.push("Commit source worktree changes before switching")
          }
          if (intent.type === "run") yield* projects.requireScript(project, intent.script)
          const target = sourceRef(project)
          if (state.source === null || !sameSource(state.source, target)) {
            effects.push(`Switch runner ${state.source?.commit.slice(0, 8) ?? "unprepared"} -> ${target.commit.slice(0, 8)}`)
            for (const record of Object.values(state.commands).filter((record) => activeStatuses.has(record.status))) {
              effects.push(`Restart ${record.id}`)
            }
          }
          if (intent.type === "run") effects.push(`Start ${intent.packagePath === "" ? "." : intent.packagePath}:${intent.script}`)
          else effects.push(`Activate ${target.branch ?? "detached"}@${target.commit.slice(0, 8)}`)
        } else {
          const record = yield* registry.command(state, intent.commandId)
          effects.push(`${intent.type === "stop" ? "Stop" : "Restart"} ${record.id}`)
        }
        return {
          id: randomUUID(),
          stateRevision: stateRevision(state),
          intent,
          title: intent.type === "run"
            ? `Run ${intent.packagePath === "" ? "." : intent.packagePath}:${intent.script}`
            : intent.type === "switch" ? "Switch managed runner" : `${intent.type === "stop" ? "Stop" : "Restart"} command`,
          effects,
          requiresConfirmation: true,
          dirtySummary: dirtySummary === "" ? null : dirtySummary,
          dirtyFingerprint,
        }
      })

      const commit = Effect.fn("RunboxApplication.commit")(function* (request: CommitRequest) {
        const intent = request.plan.intent
        if (intent.type !== "run" && intent.type !== "switch") {
          return yield* new RunboxError({ operation: "commit global source", message: "this action has no source worktree" })
        }
        const state = yield* stateFor(intent.repoId)
        if (stateRevision(state) !== request.plan.stateRevision) {
          return yield* new RunboxError({
            operation: "commit global source",
            message: "repository state changed while waiting for a commit message",
            code: "ACTION_PLAN_STALE",
            suggestion: "Refresh and review the action again.",
            retryable: true,
          })
        }
        const project = yield* projects.discover(join(intent.worktreePath, intent.packagePath))
        if (project.commit !== intent.expectedHead) {
          return yield* new RunboxError({
            operation: "commit global source",
            message: "source HEAD changed while waiting for a commit message",
            code: "SOURCE_CHANGED",
            suggestion: "Refresh and review the action again.",
            retryable: true,
          })
        }
        const currentDirty = yield* git.dirty(project)
        const currentFingerprint = currentDirty === "" ? null : yield* git.dirtyFingerprint(project)
        if (currentDirty !== request.plan.dirtySummary || currentFingerprint !== request.plan.dirtyFingerprint) {
          return yield* new RunboxError({
            operation: "commit global source",
            message: "worktree changes changed after the action was reviewed",
            code: "ACTION_PLAN_STALE",
            suggestion: "Refresh and review the updated changes before committing.",
            retryable: true,
          })
        }
        const message = request.mode === "luna"
          ? yield* generateCommitMessage(project)
          : request.message?.trim() ?? ""
        if (message === "") {
          return yield* new RunboxError({ operation: "commit global source", message: "commit message cannot be empty" })
        }
        const source = yield* git.commit(project, message)
        return yield* plan({ ...intent, expectedHead: source.commit })
      })

      const execute = Effect.fn("RunboxApplication.execute")(function* (action: ActionPlan) {
        const before = yield* stateFor(action.intent.repoId)
        if (stateRevision(before) !== action.stateRevision) {
          return yield* new RunboxError({
            operation: "execute global action",
            message: "repository state changed after the action was reviewed",
            code: "ACTION_PLAN_STALE",
            suggestion: "Refresh the dashboard and review the updated action.",
            retryable: true,
          })
        }
        if (consumedPlans.has(action.id)) {
          return yield* new RunboxError({
            operation: "execute global action",
            message: "action plan was already executed",
            code: "ACTION_PLAN_STALE",
            suggestion: "Refresh and create a new action plan.",
            retryable: true,
          })
        }
        consumedPlans.add(action.id)
        const intent = action.intent
        let query: InspectionQuery = { repositoryId: intent.repoId }
        if (intent.type === "run" || intent.type === "switch") {
          const project = yield* projects.discover(join(intent.worktreePath, intent.packagePath))
          if (project.commit !== intent.expectedHead) {
            return yield* new RunboxError({
              operation: "execute global action",
              message: "selected worktree HEAD changed after confirmation",
              code: "SOURCE_CHANGED",
              suggestion: "Refresh the dashboard and review the updated source.",
              retryable: true,
            })
          }
          yield* git.requireClean(project)
          if (intent.type === "run") yield* projects.requireScript(project, intent.script)
          const state = yield* bootstrap(project)
          const socket = yield* ensureDaemonConfigured(project, state)
          const store = yield* StateStore
          const expectedRevision = stateRevision(yield* store.load(project))
          if (intent.type === "run") {
            yield* daemonRequest(socket, {
              type: "activate",
              packagePath: project.packagePath,
              script: intent.script,
              args: intent.args,
              source: sourceRef(project),
              expectedRevision,
            })
            query = { repositoryId: intent.repoId, worktreePath: intent.worktreePath, commandId: `${project.packagePath === "" ? "." : project.packagePath}:${intent.script}` }
          } else {
            yield* daemonRequest(socket, { type: "switch", source: sourceRef(project), expectedRevision })
            query = { repositoryId: intent.repoId, worktreePath: intent.worktreePath }
          }
        } else {
          const record = yield* registry.command(before, intent.commandId)
          const project = yield* projects.discover(join(before.environmentSourceRoot ?? before.repoRoot, record.packagePath))
          const state = yield* bootstrap(project)
          const socket = yield* ensureDaemonConfigured(project, state)
          const store = yield* StateStore
          const expectedRevision = stateRevision(yield* store.load(project))
          yield* daemonRequest(socket, intent.type === "stop"
            ? { type: "stop", packagePath: record.packagePath, script: record.script, expectedRevision }
            : { type: "restart", packagePath: record.packagePath, script: record.script, expectedRevision })
          query = { repositoryId: intent.repoId, commandId: record.id }
        }
        const view = yield* catalog.inspect(query)
        return { message: `${action.title} requested`, view }
      })

      return RunboxApplication.of({ inspect: catalog.inspect, plan, execute, commit })
    }),
  )
}
