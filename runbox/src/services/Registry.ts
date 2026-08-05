import { Context, Effect, Layer } from "effect"
import { access, readFile, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { repositoryRoot, type CommandRecord, type RepoState } from "../domain.ts"
import { InvalidState, RunboxError } from "../errors.ts"
import { Paths } from "./Paths.ts"
import { decodeState } from "./StateStore.ts"

export interface RegistryProblem {
  readonly path: string
  readonly message: string
}

export interface RegistryEntry {
  readonly repoId: string
  readonly storage: "current" | "legacy"
  readonly state: RepoState | null
  readonly problem: RegistryProblem | null
}

export class Registry extends Context.Tag("@runbox/Registry")<
  Registry,
  {
    readonly scan: () => Effect.Effect<ReadonlyArray<RegistryEntry>, RunboxError>
    readonly list: () => Effect.Effect<ReadonlyArray<RepoState>, RunboxError | InvalidState>
    readonly resolve: (query: string) => Effect.Effect<RepoState, RunboxError | InvalidState>
    readonly command: (state: RepoState, query: string) => Effect.Effect<CommandRecord, RunboxError>
  }
>() {
  static readonly layer = Layer.effect(
    Registry,
    Effect.gen(function* () {
      const paths = yield* Paths

      const scan = Effect.fn("Registry.scan")(function* () {
        const roots = [paths.stateRoot, paths.legacyStateRoot]
        const directories = yield* Effect.tryPromise({
          try: async () => {
            const entries = await Promise.all(roots.map((root) => readdir(root, { withFileTypes: true }).then(
              (values) => values.filter((entry) => entry.isDirectory()).map((entry) => ({ root, repoId: entry.name })),
              (cause: NodeJS.ErrnoException) => cause.code === "ENOENT" ? [] : Promise.reject(cause),
            )))
            const selected = new Map<string, string>()
            for (const entry of entries.flat()) {
              if (!selected.has(entry.repoId) || entry.root === paths.stateRoot) selected.set(entry.repoId, entry.root)
            }
            return [...selected].map(([repoId, root]) => ({
              repoId,
              root,
              storage: root === paths.stateRoot ? "current" as const : "legacy" as const,
            }))
          },
          catch: (cause) =>
            new RunboxError({ operation: "list runbox projects", message: String(cause) }),
        })
        const entries = yield* Effect.forEach(directories, ({ repoId, root, storage }) => {
          const path = join(root, repoId, "state.json")
          return Effect.tryPromise({
            try: () => readFile(path, "utf8"),
            catch: (cause) =>
              new RunboxError({ operation: "read runbox project state", message: String(cause), details: path }),
          }).pipe(
            Effect.flatMap((raw) => decodeState(raw, path)),
            Effect.match({
              onFailure: (error): RegistryEntry => ({
                repoId,
                storage,
                state: null,
                problem: { path, message: error.message },
              }),
              onSuccess: (state): RegistryEntry => ({ repoId, storage, state, problem: null }),
            }),
          )
        }, { concurrency: "unbounded" })
        return entries.sort((left, right) => {
          const leftName = left.state === null ? left.repoId : basename(repositoryRoot(left.state))
          const rightName = right.state === null ? right.repoId : basename(repositoryRoot(right.state))
          return leftName.localeCompare(rightName)
        })
      })

      const list = Effect.fn("Registry.list")(function* () {
        const entries = yield* scan()
        const invalid = entries.find((entry) => entry.state === null)
        if (invalid?.problem !== null && invalid?.problem !== undefined) {
          return yield* new InvalidState({
            path: invalid.problem.path,
            message: invalid.problem.message,
          })
        }
        return entries.flatMap((entry) => entry.state === null ? [] : [entry.state])
      })

      const resolve = Effect.fn("Registry.resolve")(function* (query: string) {
        const states = yield* list()
        const matches = states.filter((state) =>
          state.repoId === query ||
          state.repoRoot === query ||
          state.environmentSourceRoot === query ||
          basename(repositoryRoot(state)) === query ||
          `${basename(repositoryRoot(state))}#${state.repoId}` === query
        )
        const existing = yield* Effect.filter(matches, (state) =>
          Effect.promise(() => access(repositoryRoot(state)).then(() => true, () => false)),
        )
        const candidates = existing.length > 0 ? existing : matches
        if (candidates.length === 1) return candidates[0]!
        if (candidates.length > 1) {
          return yield* new RunboxError({
            operation: "resolve runbox project",
            message: `project identifier '${query}' is ambiguous`,
            code: "PROJECT_AMBIGUOUS",
            suggestion: "Run 'runbox projects --json' and retry with the repoId or name#repoId value.",
            details: candidates.map((state) => `${basename(repositoryRoot(state))}#${state.repoId}`).join(", "),
          })
        }
        return yield* new RunboxError({
          operation: "resolve runbox project",
          message: `runbox has no project named '${query}'`,
          code: "PROJECT_NOT_FOUND",
          suggestion: "Run 'runbox projects --json'. Initialize the project with 'runbox init' if it is absent.",
        })
      })

      const command = Effect.fn("Registry.command")(function* (state: RepoState, query: string) {
        const records = Object.values(state.commands)
        const exact = records.find((record) => record.id === query)
        if (exact !== undefined) return exact
        const matches = records.filter((record) => record.script === query)
        if (matches.length === 1) return matches[0]!
        if (matches.length > 1) {
          return yield* new RunboxError({
            operation: "resolve tracked command",
            message: `command '${query}' exists in multiple packages`,
            code: "COMMAND_AMBIGUOUS",
            suggestion: "Retry with the full command ID shown by 'runbox projects --json', such as apps/web:dev.",
            details: matches.map((record) => record.id).join(", "),
          })
        }
        return yield* new RunboxError({
          operation: "resolve tracked command",
          message: `project '${basename(repositoryRoot(state))}' has no tracked command '${query}'`,
          code: "COMMAND_NOT_TRACKED",
          suggestion: `Start it with 'runbox ${query}' in the project, then retry.`,
        })
      })

      return Registry.of({ scan, list, resolve, command })
    }),
  )
}
