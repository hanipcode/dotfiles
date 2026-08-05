import { Context, Effect, Layer } from "effect"
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import type { ProjectContext, RepoState } from "../domain.ts"
import { RunboxError } from "../errors.ts"
import { request } from "../ipc.ts"
import { decodeState } from "./StateStore.ts"
import { Paths } from "./Paths.ts"
import { Shell } from "./Shell.ts"

const exists = (path: string) => access(path).then(() => true, () => false)
const activeStatuses = new Set(["preparing", "starting", "running", "stopping"])

export class StorageMigration extends Context.Tag("@runbox/StorageMigration")<
  StorageMigration,
  {
    readonly migrate: (project: ProjectContext) => Effect.Effect<boolean, RunboxError>
  }
>() {
  static readonly layer = Layer.effect(
    StorageMigration,
    Effect.gen(function* () {
      const paths = yield* Paths
      const shell = yield* Shell

      const migrate = Effect.fn("StorageMigration.migrate")(function* (project: ProjectContext) {
        const destinationState = join(paths.stateRoot, project.repoId)
        const legacyState = paths.legacyRepoState(project.repoId)
        const legacyStateFile = paths.legacyStateFile(project.repoId)
        if (yield* Effect.promise(() => exists(destinationState))) return false
        if (!(yield* Effect.promise(() => exists(legacyStateFile)))) return false

        const raw = yield* Effect.tryPromise({
          try: () => readFile(legacyStateFile, "utf8"),
          catch: (cause) => new RunboxError({ operation: "read legacy runbox state", message: String(cause) }),
        })
        const state = yield* decodeState(raw, legacyStateFile).pipe(
          Effect.mapError((error) => new RunboxError({ operation: "decode legacy runbox state", message: error.message })),
        )

        const socket = paths.socket(project.repoId)
        if (yield* Effect.promise(() => exists(socket))) {
          const status = yield* request(socket, { type: "status", packagePath: project.packagePath }, 500).pipe(
            Effect.option,
          )
          if (status._tag === "None") return false
          const snapshot = status.value.ok ? status.value.snapshot : undefined
          const active = snapshot === undefined
            ? true
            : Object.values(snapshot.state.commands).some((record) => activeStatuses.has(record.status))
          if (active) return false
          yield* request(socket, { type: "shutdown" }, 5_000).pipe(Effect.ignore)
          for (let attempt = 0; attempt < 50 && (yield* Effect.promise(() => exists(socket))); attempt += 1) {
            yield* Effect.sleep("100 millis")
          }
          if (yield* Effect.promise(() => exists(socket))) return false
        }

        const destinationRunner = join(paths.dataRoot, project.repoId, "worktree")
        const sourceRunner = state.runnerPath
        const sourceExists = yield* Effect.promise(() => exists(sourceRunner))
        const destinationExists = yield* Effect.promise(() => exists(destinationRunner))
        const temporaryState = `${destinationState}.${process.pid}.${randomUUID()}.tmp`
        let movedRunner = false

        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(destinationState), { recursive: true })
            await rm(temporaryState, { recursive: true, force: true })
            await cp(legacyState, temporaryState, { recursive: true })
          },
          catch: (cause) => new RunboxError({ operation: "stage runbox state migration", message: String(cause) }),
        })

        if (sourceExists && sourceRunner !== destinationRunner) {
          yield* Effect.tryPromise({
            try: () => mkdir(dirname(destinationRunner), { recursive: true }),
            catch: (cause) => new RunboxError({ operation: "create consolidated runner directory", message: String(cause) }),
          })
          yield* shell.run(["git", "worktree", "move", sourceRunner, destinationRunner], {
            cwd: project.repoRoot,
          }).pipe(
            Effect.mapError((error) =>
              new RunboxError({ operation: "move managed worktree", message: error.stderr }),
            ),
          )
          movedRunner = true
        } else if (!sourceExists && !destinationExists) {
          yield* Effect.tryPromise({
            try: () => rm(temporaryState, { recursive: true, force: true }),
            catch: () => new RunboxError({ operation: "clean staged runbox migration", message: "runner is missing" }),
          })
          return false
        }

        const migratedStateRoot = destinationState
        const migrated: RepoState = {
          ...state,
          runnerPath: destinationRunner,
          commands: Object.fromEntries(Object.entries(state.commands).map(([id, record]) => [id, {
            ...record,
            logFile: join(migratedStateRoot, "logs", basename(record.logFile)),
          }])),
        }
        const commit = yield* Effect.tryPromise({
          try: async () => {
            await writeFile(join(temporaryState, "state.json"), `${JSON.stringify(migrated, null, 2)}\n`)
            await rename(temporaryState, destinationState)
          },
          catch: (cause) => new RunboxError({ operation: "commit runbox storage migration", message: String(cause) }),
        }).pipe(Effect.either)
        if (commit._tag === "Left") {
          if (movedRunner) {
            const rollback = yield* shell.run(["git", "worktree", "move", destinationRunner, sourceRunner], {
              cwd: project.repoRoot,
            }).pipe(Effect.either)
            if (rollback._tag === "Left") {
              return yield* new RunboxError({
                operation: "roll back runbox storage migration",
                message: rollback.left.stderr,
                code: "STORAGE_MIGRATION_ROLLBACK_FAILED",
                suggestion: "Repair the managed worktree path using the staged state, then retry migration.",
                details: `commit error: ${commit.left.message}\nstaged state: ${temporaryState}\nrunner: ${destinationRunner}`,
              })
            }
          }
          yield* Effect.promise(() => rm(temporaryState, { recursive: true, force: true }))
          return yield* commit.left
        }
        yield* Effect.tryPromise({
          try: async () => {
            await rm(legacyState, { recursive: true, force: true })
            await rm(paths.legacyRepoData(project.repoId), { recursive: true, force: true })
          },
          catch: (cause) => new RunboxError({
            operation: "clean legacy runbox storage",
            message: String(cause),
            code: "STORAGE_MIGRATION_CLEANUP_FAILED",
            suggestion: "The migration committed successfully; remove the reported legacy directories after confirming the new state.",
            details: `${legacyState}\n${paths.legacyRepoData(project.repoId)}`,
          }),
        })
        return true
      })

      return StorageMigration.of({ migrate })
    }),
  )
}
