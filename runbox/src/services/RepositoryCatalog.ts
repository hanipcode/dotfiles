import { Context, Effect, Layer } from "effect"
import { basename, dirname, join } from "node:path"
import { access, readFile } from "node:fs/promises"
import type {
  GlobalView,
  InspectionQuery,
  PackageView,
  PreparationHealth,
  ProblemView,
  RepositoryDetail,
  RepositorySummary,
  WorktreeView,
} from "../application/model.ts"
import { commandId, repositoryRoot, stateRevision, type RepoState } from "../domain.ts"
import { RunboxError, toErrorInfo } from "../errors.ts"
import { LogStore } from "./LogStore.ts"
import { Metrics } from "./Metrics.ts"
import { Paths } from "./Paths.ts"
import { Project } from "./Project.ts"
import { Registry } from "./Registry.ts"
import { Shell } from "./Shell.ts"
import { request } from "../ipc.ts"

const activeStatuses = new Set(["preparing", "starting", "running", "stopping"])

export const parseWorktreeList = (raw: string): ReadonlyArray<{
  readonly path: string
  readonly head: string
  readonly branch: string | null
  readonly locked: string | null
  readonly prunable: string | null
}> => {
  const values: Array<{ path: string; head: string; branch: string | null; locked: string | null; prunable: string | null }> = []
  let current: { path: string; head: string; branch: string | null; locked: string | null; prunable: string | null } | null = null
  const finish = () => {
    if (current !== null) values.push(current)
    current = null
  }
  for (const line of `${raw}\n`.split("\n")) {
    if (line === "") {
      finish()
      continue
    }
    const space = line.indexOf(" ")
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? "" : line.slice(space + 1)
    if (key === "worktree") {
      finish()
      current = { path: value, head: "", branch: null, locked: null, prunable: null }
    } else if (current !== null && key === "HEAD") current.head = value
    else if (current !== null && key === "branch") current.branch = value.replace(/^refs\/heads\//, "")
    else if (current !== null && key === "locked") current.locked = value || "locked"
    else if (current !== null && key === "prunable") current.prunable = value || "prunable"
  }
  return values
}

const readJsonLines = async (path: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const raw = await readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return ""
    throw cause
  })
  const lines = raw.split("\n")
  if (!raw.endsWith("\n")) lines.pop()
  return lines.filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>)
}

export class RepositoryCatalog extends Context.Tag("@runbox/RepositoryCatalog")<
  RepositoryCatalog,
  {
    readonly inspect: (query?: InspectionQuery) => Effect.Effect<GlobalView, RunboxError>
  }
>() {
  static readonly layer = Layer.effect(
    RepositoryCatalog,
    Effect.gen(function* () {
      const registry = yield* Registry
      const shell = yield* Shell
      const projectService = yield* Project
      const paths = yield* Paths
      const logs = yield* LogStore
      const metrics = yield* Metrics

      const problem = (error: unknown, path: string | null = null): ProblemView => {
        const info = toErrorInfo(error)
        return { code: info.code, message: info.message, path: info.details ?? path }
      }

      const daemonHealth = Effect.fn("RepositoryCatalog.daemonHealth")(function* (repoId: string) {
        const socket = paths.socket(repoId)
        const present = yield* Effect.promise(() => access(socket).then(() => true, () => false))
        if (!present) return "offline" as const
        const response = yield* request(socket, { type: "ping" }, 250).pipe(Effect.either)
        if (response._tag === "Left") return "unreachable" as const
        if (response.right.ok) return "online" as const
        return response.right.error.code === "INVALID_REQUEST" ? "upgrade-required" as const : "unreachable" as const
      })

      const worktrees = Effect.fn("RepositoryCatalog.worktrees")(function* (state: RepoState) {
        const result = yield* shell.run(["git", "worktree", "list", "--porcelain"], {
          cwd: repositoryRoot(state),
        }).pipe(Effect.mapError((error) => new RunboxError({
          operation: "list repository worktrees",
          message: error.stderr,
          details: repositoryRoot(state),
        })))
        return parseWorktreeList(result.stdout).filter((entry) => entry.path !== state.runnerPath).map((entry): WorktreeView => {
          return {
            ...entry,
            isActiveSource: state.source?.kind === "worktree" && state.source.worktreePath === entry.path,
            isEnvironmentSource: state.environmentSourceRoot === entry.path,
          }
        })
      })

      const packages = Effect.fn("RepositoryCatalog.packages")(function* (
        state: RepoState,
        selectedWorktree: WorktreeView,
      ) {
        const result = yield* shell.run([
          "git",
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          "package.json",
          "**/package.json",
        ], { cwd: selectedWorktree.path }).pipe(Effect.mapError((error) => new RunboxError({
          operation: "list repository packages",
          message: error.stderr,
          details: selectedWorktree.path,
        })))
        const manifests = [...new Set(result.stdout.split("\n").filter((line) => line !== ""))].sort()
        const inspected = yield* Effect.forEach(manifests, (manifest) => Effect.gen(function* () {
          const directory = manifest === "package.json" ? selectedWorktree.path : dirname(join(selectedWorktree.path, manifest))
          const project = yield* projectService.discover(directory)
          const info = yield* projectService.packageInfo(project)
          const raw = yield* Effect.tryPromise({
            try: () => readFile(project.packageJsonPath, "utf8"),
            catch: (cause) => new RunboxError({ operation: "read package manifest", message: String(cause) }),
          })
          const json = yield* Effect.try({
            try: () => JSON.parse(raw) as { readonly name?: unknown },
            catch: (cause) => new RunboxError({ operation: "parse package manifest", message: String(cause) }),
          })
          return {
            path: project.packagePath,
            name: typeof json.name === "string" ? json.name : null,
            manager: info.manager,
            scripts: Object.entries(info.scripts).map(([name, command]) => {
              const id = commandId(project.packagePath, name)
              return {
                name,
                command,
                prepared: state.preparedCommands.includes(`${selectedWorktree.head}:${id}`),
                tracked: state.commands[id] ?? null,
              }
            }).sort((left, right) => left.name.localeCompare(right.name)),
          } satisfies PackageView
        }).pipe(
          Effect.mapError((error) => new RunboxError({
            operation: error.operation,
            message: error.message,
            code: error.code,
            suggestion: error.suggestion,
            retryable: error.retryable,
            details: join(selectedWorktree.path, manifest),
          })),
          Effect.either,
        ), { concurrency: 4 })
        return {
          packages: inspected.flatMap((entry) => entry._tag === "Right" ? [entry.right] : [])
            .sort((left, right) => left.path.localeCompare(right.path)),
          problems: inspected.flatMap((entry) => entry._tag === "Left" ? [problem(entry.left)] : []),
        }
      })

      const preparation = Effect.fn("RepositoryCatalog.preparation")(function* (state: RepoState) {
        const result = yield* Effect.tryPromise({
          try: async () => {
            const history = await readJsonLines(paths.historyFile(state.repoId))
            const instructions = await readJsonLines(paths.instructionsFile(state.repoId))
            const active = new Map<string, boolean>()
            for (const record of instructions) {
              if (typeof record.key !== "string" || typeof record.status !== "string") continue
              const scope = typeof record.scope === "string" ? record.scope : "unknown"
              const packagePath = typeof record.packagePath === "string" ? record.packagePath : ""
              const script = typeof record.script === "string" ? record.script : ""
              active.set(`${scope}:${packagePath}:${script}:${record.key}`, record.status === "active")
            }
            const last = [...history].reverse().find((record) =>
              record.kind === "run" && record.scope === "setup" && record.commit === state.source?.commit
            )
            const lastPhase = typeof last?.phase === "string" ? last.phase : null
            const lastAt = typeof last?.at === "number"
              ? last.at
              : typeof last?.startedAt === "number" ? last.startedAt : null
            const activeCommit = state.source?.commit
            return {
              setup: lastPhase === "failed"
                ? "failed"
                : activeCommit !== undefined && state.preparedCommits.includes(activeCommit) ? "ready" : "pending",
              preparedCommandCount: state.preparedCommands.length,
              activeInstructionCount: [...active.values()].filter(Boolean).length,
              lastPhase,
              lastAt,
              problem: null,
            } satisfies PreparationHealth
          },
          catch: (cause) => new RunboxError({
            operation: "summarize preparation history",
            message: String(cause),
            details: paths.repoState(state.repoId),
          }),
        }).pipe(Effect.either)
        return result._tag === "Right" ? result.right : {
          setup: "unknown",
          preparedCommandCount: state.preparedCommands.length,
          activeInstructionCount: 0,
          lastPhase: null,
          lastAt: null,
          problem: problem(result.left),
        } satisfies PreparationHealth
      })

      const inspect = Effect.fn("RepositoryCatalog.inspect")(function* (query: InspectionQuery = {}) {
        const entries = yield* registry.scan()
        const summaries = yield* Effect.forEach(entries, (entry): Effect.Effect<RepositorySummary, never> => Effect.gen(function* () {
          if (entry.state === null) {
            return {
              repoId: entry.repoId,
              name: entry.repoId,
              key: entry.repoId,
              repositoryRoot: entry.problem?.path ?? "",
              storage: entry.storage,
              runnerPath: "",
              environmentSourceRoot: null,
              activeSource: null,
              daemon: "offline",
              commandCount: 0,
              activeCommandCount: 0,
              stateRevision: "invalid",
              problem: entry.problem === null ? null : {
                code: "INVALID_STATE",
                message: entry.problem.message,
                path: entry.problem.path,
              },
            }
          }
          const commands = Object.values(entry.state.commands)
          const name = basename(repositoryRoot(entry.state))
          return {
            repoId: entry.repoId,
            name,
            key: `${name}#${entry.repoId}`,
            repositoryRoot: repositoryRoot(entry.state),
            storage: entry.storage,
            runnerPath: entry.state.runnerPath,
            environmentSourceRoot: entry.state.environmentSourceRoot,
            activeSource: entry.state.source,
            daemon: yield* daemonHealth(entry.repoId),
            commandCount: commands.length,
            activeCommandCount: commands.filter((record) => activeStatuses.has(record.status)).length,
            stateRevision: stateRevision(entry.state),
            problem: null,
          }
        }), { concurrency: "unbounded" }).pipe(Effect.map((values) => values.sort((left, right) =>
          right.activeCommandCount - left.activeCommandCount || left.name.localeCompare(right.name)
        )))
        const selectedSummary = query.repositoryId === undefined
          ? undefined
          : summaries.find((summary) => summary.repoId === query.repositoryId)
        const selectedEntry = selectedSummary === undefined
          ? undefined
          : entries.find((entry) => entry.repoId === selectedSummary.repoId)
        let selected: RepositoryDetail | null = null
        if (selectedEntry?.state !== null && selectedEntry?.state !== undefined) {
          const state = selectedEntry.state
          const issues: ProblemView[] = []
          const worktreeResult = yield* worktrees(state).pipe(Effect.either)
          const allWorktrees = worktreeResult._tag === "Right" ? worktreeResult.right : []
          if (worktreeResult._tag === "Left") issues.push(problem(worktreeResult.left))
          const preferredPath = query.worktreePath ??
            (state.source?.kind === "worktree" ? state.source.worktreePath : null) ??
            state.environmentSourceRoot ?? allWorktrees[0]?.path ?? null
          const selectedWorktree = allWorktrees.find((entry) => entry.path === preferredPath) ?? null
          const packageResult = selectedWorktree === null
            ? null
            : yield* packages(state, selectedWorktree).pipe(Effect.either)
          const packageViews = packageResult?._tag === "Right" ? packageResult.right.packages : []
          if (packageResult?._tag === "Right") issues.push(...packageResult.right.problems)
          if (packageResult?._tag === "Left") issues.push(problem(packageResult.left))
          const record = query.commandId === undefined ? null : state.commands[query.commandId] ?? null
          const selectedLog = record === null ? "" : yield* logs.tail(record.logFile).pipe(Effect.orElseSucceed(() => ""))
          const metricValues = record?.pid === null || record?.pid === undefined
            ? {}
            : yield* metrics.forPids([record.pid]).pipe(Effect.orElseSucceed(() => ({})))
          selected = {
            state,
            worktrees: allWorktrees,
            selectedWorktreePath: selectedWorktree?.path ?? null,
            packages: packageViews,
            selectedCommand: record,
            selectedLog,
            selectedMetrics: record?.pid === null || record?.pid === undefined ? null : metricValues[String(record.pid)] ?? null,
            preparation: yield* preparation(state),
            problems: issues,
          }
        }
        return { generatedAt: Date.now(), repositories: summaries, selected }
      })

      return RepositoryCatalog.of({ inspect })
    }),
  )
}
