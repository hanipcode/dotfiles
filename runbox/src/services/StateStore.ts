import { Context, Effect, Layer, Schema } from "effect"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { LegacyRepoState, RepoState, type ProjectContext } from "../domain.ts"
import { InvalidState } from "../errors.ts"
import { Paths } from "./Paths.ts"

export const decodeState = Effect.fn("StateStore.decodeState")(function* (
  raw: string,
  path: string,
) {
  const json = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) => new InvalidState({ path, message: String(cause) }),
  })
  const current = yield* Schema.decodeUnknown(RepoState)(json).pipe(Effect.option)
  if (current._tag === "Some") return current.value
  const legacy = yield* Schema.decodeUnknown(LegacyRepoState)(json).pipe(
    Effect.mapError((cause) => new InvalidState({ path, message: String(cause) })),
  )
  return RepoState.make({
    ...legacy,
    version: 2,
    source: legacy.source === null
      ? null
      : {
          kind: "worktree",
          worktreePath: legacy.source.worktreePath,
          branch: legacy.source.branch,
          commit: legacy.source.commit,
          stack: null,
        },
  })
})

export class StateStore extends Context.Tag("@runbox/StateStore")<
  StateStore,
  {
    readonly load: (project: ProjectContext) => Effect.Effect<RepoState, InvalidState>
    readonly save: (state: RepoState) => Effect.Effect<void, InvalidState>
  }
>() {
  static readonly layer = Layer.effect(
    StateStore,
    Effect.gen(function* () {
      const paths = yield* Paths

      const load = Effect.fn("StateStore.load")(function* (project: ProjectContext) {
        const path = paths.stateFile(project.repoId)
        const raw = yield* Effect.tryPromise({
          try: () => readFile(path, "utf8").then(
            (value) => value,
            (cause: NodeJS.ErrnoException) => cause.code === "ENOENT" ? null : Promise.reject(cause),
          ),
          catch: (cause) => new InvalidState({ path, message: String(cause) }),
        })
        if (raw === null) {
          return RepoState.make({
            version: 2,
            repoId: project.repoId,
            repoRoot: project.repoRoot,
            commonDir: project.commonDir,
            runnerPath: paths.runner(project.repoId),
            source: null,
            preparedCommits: [],
            commands: {},
          })
        }
        const state = yield* decodeState(raw, path)
        if (state.commonDir !== project.commonDir) {
          return yield* new InvalidState({
            path,
            message: `state belongs to Git common directory ${state.commonDir}, not ${project.commonDir}`,
          })
        }
        return state
      })

      const save = Effect.fn("StateStore.save")(function* (state: RepoState) {
        const path = paths.stateFile(state.repoId)
        const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true })
            await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`)
            await rename(temp, path)
          },
          catch: (cause) => new InvalidState({ path, message: String(cause) }),
        })
      })

      return StateStore.of({ load, save })
    }),
  )
}
