import watcher, { type AsyncSubscription } from "@parcel/watcher"
import { Context, Effect, Layer, Ref, Runtime } from "effect"
import { chmod, link, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import type { ProjectContext, SourceRef, SyncResult, SyncSnapshot } from "../domain.ts"
import { RunboxError } from "../errors.ts"
import { LogStore } from "./LogStore.ts"
import { Paths } from "./Paths.ts"
import { Shell } from "./Shell.ts"

type EntryKind = "file" | "symlink" | "delete"
type EntryOrigin = "tracked" | "untracked"

interface ManifestEntry {
  readonly kind: EntryKind
  readonly origin: EntryOrigin
  readonly digest: string
  readonly mode: number
  readonly target: string | null
}

interface Manifest {
  readonly sourcePath: string
  readonly sourceCommit: string
  readonly revision: string
  readonly entries: Readonly<Record<string, ManifestEntry>>
}

interface SyncJournal {
  readonly version: 1
  readonly applied: Manifest | null
  readonly pending: Manifest | null
}

const emptySnapshot = (): SyncSnapshot => ({
  mode: "off",
  phase: "idle",
  sourcePath: null,
  sourceCommit: null,
  revision: null,
  lastCompletedAt: null,
  copied: 0,
  removed: 0,
  tracked: 0,
  untracked: 0,
  setupChanged: false,
  pending: false,
  error: null,
})

const setupNames = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".node-version",
  ".tool-versions",
  "pnpm-workspace.yaml",
  "turbo.json",
])

const isSetupPath = (path: string): boolean => {
  const name = basename(path)
  return setupNames.has(name) || path.startsWith(".agents/runbox/") ||
    (name.startsWith(".env") && name.endsWith(".example"))
}

const safeRelativePath = (path: string): boolean => {
  if (path === "" || path === "." || isAbsolute(path)) return false
  const parts = path.split(/[\\/]/)
  return parts.every((part) => part !== "" && part !== "." && part !== "..")
}

const isSecretEnvironmentPath = (path: string): boolean => {
  const name = basename(path)
  if (name === ".env" || name === ".env.local") return true
  if (!name.startsWith(".env.")) return false
  return ![".example", ".sample", ".template"].some((suffix) => name.endsWith(suffix))
}

const exists = (path: string) => lstat(path).then(() => true, () => false)

const assertConfinedParents = async (
  root: string,
  relativePath: string,
  location: "source" | "runner",
): Promise<void> => {
  const rootStat = await lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`managed ${location} root is not a physical directory: ${root}`)
  }
  let parent = root
  for (const part of relativePath.split(/[\\/]/).slice(0, -1)) {
    parent = join(parent, part)
    const stat = await lstat(parent).catch((cause: NodeJS.ErrnoException) =>
      cause.code === "ENOENT" ? null : Promise.reject(cause)
    )
    if (stat === null) return
    if (stat.isSymbolicLink()) throw new Error(`${relativePath} traverses symlinked ${location} directory ${parent}`)
  }
}

const hashEntry = (kind: EntryKind, content: Buffer | string, mode: number): string =>
  createHash("sha256").update(kind).update(String(mode)).update(content).digest("hex")

const manifestRevision = (entries: Readonly<Record<string, ManifestEntry>>): string => {
  const hash = createHash("sha256")
  for (const [path, entry] of Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path).update(JSON.stringify(entry))
  }
  return hash.digest("hex")
}

const decodeJournal = (raw: string): SyncJournal => {
  const value = JSON.parse(raw) as Partial<SyncJournal>
  if (value.version !== 1) throw new Error("unsupported sync journal version")
  for (const manifest of [value.applied, value.pending]) {
    if (manifest === null || manifest === undefined) continue
    if (
      typeof manifest.sourcePath !== "string" || typeof manifest.sourceCommit !== "string" ||
      typeof manifest.revision !== "string" || typeof manifest.entries !== "object" || manifest.entries === null
    ) throw new Error("invalid sync manifest")
    for (const [path, entry] of Object.entries(manifest.entries)) {
      if (!safeRelativePath(path)) throw new Error(`unsafe sync journal path: ${JSON.stringify(path)}`)
      if (
        entry === null || typeof entry !== "object" ||
        !["file", "symlink", "delete"].includes(entry.kind) ||
        !["tracked", "untracked"].includes(entry.origin) ||
        typeof entry.digest !== "string" || typeof entry.mode !== "number"
      ) throw new Error(`invalid sync journal entry: ${JSON.stringify(path)}`)
    }
  }
  return {
    version: 1,
    applied: value.applied ?? null,
    pending: value.pending ?? null,
  }
}

export class SourceSync extends Context.Tag("@runbox/SourceSync")<
  SourceSync,
  {
    readonly reconcile: (source: SourceRef) => Effect.Effect<SyncResult, RunboxError>
    readonly watch: (
      source: SourceRef,
      onInvalidated: () => void,
    ) => Effect.Effect<void, RunboxError>
    readonly unwatch: Effect.Effect<void, RunboxError>
    readonly snapshot: Effect.Effect<SyncSnapshot>
  }
>() {
  static layer = (project: ProjectContext, runnerPath: string) =>
    Layer.scoped(
      SourceSync,
      Effect.gen(function* () {
        const shell = yield* Shell
        const paths = yield* Paths
        const logs = yield* LogStore
        const runtime = yield* Effect.runtime<never>()
        const runFork = Runtime.runFork(runtime)
        const snapshotRef = yield* Ref.make(emptySnapshot())
        const operation = yield* Effect.makeSemaphore(1)
        const journalPath = join(paths.repoState(project.repoId), "sync.json")
        const logPath = join(paths.repoState(project.repoId), "logs", "sync.log")
        let subscription: AsyncSubscription | null = null
        let debounceTimer: ReturnType<typeof setTimeout> | null = null
        let headTimer: ReturnType<typeof setInterval> | null = null
        let retryTimer: ReturnType<typeof setTimeout> | null = null
        let generation = 0
        let watchedPath: string | null = null
        let watchedCommit: string | null = null
        let headPollRunning = false

        const filesystem = <A>(operation: string, path: string, run: () => Promise<A>) =>
          Effect.tryPromise({
            try: run,
            catch: (cause) => new RunboxError({
              operation,
              message: String(cause),
              code: "SYNC_FAILED",
              suggestion: "Inspect 'runbox logs sync --json' and retry 'runbox sync --json'.",
              retryable: true,
              details: path,
            }),
          })

        const destinationFor = Effect.fn("SourceSync.destinationFor")(function* (relativePath: string) {
          if (!safeRelativePath(relativePath)) {
            return yield* new RunboxError({
              operation: "resolve sync destination",
              message: `unsafe synchronization path: ${JSON.stringify(relativePath)}`,
              code: "SYNC_UNSAFE_PATH",
              suggestion: "Inspect the sync journal and repository index before retrying.",
            })
          }
          const root = resolve(runnerPath)
          const destination = resolve(root, relativePath)
          if (destination === root || !destination.startsWith(`${root}${sep}`)) {
            return yield* new RunboxError({
              operation: "resolve sync destination",
              message: `${relativePath} escapes the managed runner`,
              code: "SYNC_UNSAFE_PATH",
              suggestion: "Inspect the sync journal and repository index before retrying.",
            })
          }
          yield* filesystem("inspect sync destination", relativePath, () =>
            assertConfinedParents(root, relativePath, "runner")
          ).pipe(Effect.mapError((error) => new RunboxError({
            operation: "resolve sync destination",
            message: error.message,
            code: error.message.includes("physical directory") || error.message.includes("symlinked runner directory")
              ? "SYNC_UNSAFE_PATH"
              : error.code,
            suggestion: error.message.includes("physical directory") || error.message.includes("symlinked runner directory")
              ? "Remove or ignore the symlinked parent before syncing."
              : error.suggestion,
            retryable: error.retryable,
            details: error.details,
          })))
          return destination
        })

        const runGit = (cwd: string, args: ReadonlyArray<string>, allowFailure = false) =>
          shell.run(["git", "--no-optional-locks", ...args], { cwd, allowFailure }).pipe(
            Effect.mapError((error) =>
              new RunboxError({
                operation: `sync git ${args[0] ?? ""}`,
                message: error.stderr,
                code: "SYNC_FAILED",
                suggestion: "Inspect 'runbox logs sync --json' and retry 'runbox sync --json'.",
                retryable: true,
              })
            ),
          )

        const saveJournal = (journal: SyncJournal) => Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(journalPath), { recursive: true })
            const temporary = `${journalPath}.${randomUUID()}.tmp`
            await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`)
            await rename(temporary, journalPath)
          },
          catch: (cause) => new RunboxError({
            operation: "save sync journal",
            message: String(cause),
            code: "SYNC_JOURNAL_FAILED",
            suggestion: `Check permissions for ${journalPath}, then retry.`,
          }),
        })

        const loadJournal = Effect.tryPromise({
          try: () => readFile(journalPath, "utf8").then(
            decodeJournal,
            (cause: NodeJS.ErrnoException) => cause.code === "ENOENT"
              ? { version: 1 as const, applied: null, pending: null }
              : Promise.reject(cause),
          ),
          catch: (cause) => new RunboxError({
            operation: "load sync journal",
            message: String(cause),
            code: "SYNC_JOURNAL_INVALID",
            suggestion: `Inspect ${journalPath} and remove it only if it cannot be repaired.`,
          }),
        })

        const discoverEntry = Effect.fn("SourceSync.discoverEntry")(function* (
          sourcePath: string,
          relativePath: string,
          origin: EntryOrigin,
        ) {
          if (!safeRelativePath(relativePath)) {
            return yield* new RunboxError({
              operation: "discover sync path",
              message: `Git returned an unsafe path: ${JSON.stringify(relativePath)}`,
              code: "SYNC_UNSAFE_PATH",
              suggestion: "Inspect the repository index and retry.",
            })
          }
          const absolute = join(sourcePath, relativePath)
          yield* filesystem("inspect sync source", relativePath, () =>
            assertConfinedParents(sourcePath, relativePath, "source")
          ).pipe(Effect.mapError((error) => new RunboxError({
            operation: "discover sync path",
            message: error.message,
            code: error.message.includes("physical directory") || error.message.includes("symlinked source directory")
              ? "SYNC_UNSAFE_PATH"
              : error.code,
            suggestion: error.message.includes("physical directory") || error.message.includes("symlinked source directory")
              ? "Replace the symlinked source parent with a physical directory before syncing."
              : error.suggestion,
            retryable: error.retryable,
            details: error.details,
          })))
          const stat = yield* filesystem("inspect sync source", relativePath, () =>
            lstat(absolute).catch((cause: NodeJS.ErrnoException) => cause.code === "ENOENT" ? null : Promise.reject(cause))
          )
          if (stat === null) {
            return {
              kind: "delete" as const,
              origin,
              digest: hashEntry("delete", "", 0),
              mode: 0,
              target: null,
            }
          }
          if (stat.isDirectory()) {
            return yield* new RunboxError({
              operation: "sync submodule",
              message: `${relativePath} is a changed directory or submodule`,
              code: "SYNC_SUBMODULE_DIRTY",
              suggestion: "Commit or clean the submodule separately before syncing the parent repository.",
              details: relativePath,
            })
          }
          if (stat.isSymbolicLink()) {
            const target = yield* filesystem("read sync source", relativePath, () => readlink(absolute))
            return {
              kind: "symlink" as const,
              origin,
              digest: hashEntry("symlink", target, stat.mode & 0o777),
              mode: stat.mode & 0o777,
              target,
            }
          }
          if (!stat.isFile()) {
            return yield* new RunboxError({
              operation: "discover sync path",
              message: `${relativePath} is not a regular file or symlink`,
              code: "SYNC_UNSUPPORTED_FILE",
              suggestion: "Remove the unsupported filesystem entry before syncing.",
              details: relativePath,
            })
          }
          const content = yield* filesystem("read sync source", relativePath, () => readFile(absolute))
          const after = yield* filesystem("inspect sync source", relativePath, () =>
            lstat(absolute).catch((cause: NodeJS.ErrnoException) => cause.code === "ENOENT" ? null : Promise.reject(cause))
          )
          if (
            after === null || !after.isFile() || after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino
          ) {
            return yield* new RunboxError({
              operation: "read sync source",
              message: `${relativePath} changed while it was being read`,
              code: "SYNC_UNSTABLE_FILE",
              suggestion: "Wait for the editor or generator to finish writing, then retry sync.",
              retryable: true,
              details: relativePath,
            })
          }
          return {
            kind: "file" as const,
            origin,
            digest: hashEntry("file", content, stat.mode & 0o777),
            mode: stat.mode & 0o777,
            target: null,
          }
        })

        const discover = Effect.fn("SourceSync.discover")(function* (source: SourceRef) {
          if (source.kind !== "worktree" || source.worktreePath === null) {
            return yield* new RunboxError({
              operation: "sync source",
              message: "only a direct Git worktree can be synchronized",
              code: "SYNC_SOURCE_UNSUPPORTED",
              suggestion: "Run sync from a normal worktree; gh-stack sources remain commit-only.",
            })
          }
          const sourcePath = resolve(source.worktreePath)
          const root = (yield* runGit(sourcePath, ["rev-parse", "--show-toplevel"])).stdout.trim()
          const commonRaw = (yield* runGit(sourcePath, ["rev-parse", "--git-common-dir"])).stdout.trim()
          const common = resolve(isAbsolute(commonRaw) ? commonRaw : join(sourcePath, commonRaw))
          if (resolve(root) !== sourcePath || common !== project.commonDir) {
            return yield* new RunboxError({
              operation: "sync source",
              message: `${sourcePath} is not a worktree of the active repository`,
              code: "SYNC_SOURCE_MISMATCH",
              suggestion: "Run sync from a worktree belonging to this repository.",
            })
          }
          const head = (yield* runGit(sourcePath, ["rev-parse", "HEAD"])).stdout.trim()
          if (head !== source.commit) {
            return yield* new RunboxError({
              operation: "sync source",
              message: `source HEAD moved from ${source.commit.slice(0, 8)} to ${head.slice(0, 8)}`,
              code: "SYNC_SOURCE_CHANGED",
              suggestion: "Refresh the source revision and retry synchronization.",
              retryable: true,
              details: head,
            })
          }
          const trackedOutput = yield* runGit(sourcePath, ["diff", "--name-only", "--no-renames", "-z", "HEAD"])
          const untrackedOutput = yield* runGit(sourcePath, ["ls-files", "--others", "--exclude-standard", "-z"])
          const trackedPaths = trackedOutput.stdout.split("\0").filter(Boolean)
          const tracked = new Set(trackedPaths)
          const untrackedPaths = untrackedOutput.stdout.split("\0").filter((path) =>
            path !== "" && !tracked.has(path) && !isSecretEnvironmentPath(path)
          )
          const filesystemPaths = new Map<string, string>()
          for (const path of [...trackedPaths, ...untrackedPaths]) {
            const key = path.normalize("NFC").toLocaleLowerCase("en-US")
            const collision = filesystemPaths.get(key)
            if (collision !== undefined && collision !== path) {
              return yield* new RunboxError({
                operation: "discover sync paths",
                message: `${collision} and ${path} collide on a case-insensitive filesystem`,
                code: "SYNC_PATH_COLLISION",
                suggestion: "Commit the rename or use distinct filenames before syncing.",
              })
            }
            filesystemPaths.set(key, path)
          }
          const entries: Record<string, ManifestEntry> = {}
          for (const path of trackedPaths) entries[path] = yield* discoverEntry(sourcePath, path, "tracked")
          for (const path of untrackedPaths) entries[path] = yield* discoverEntry(sourcePath, path, "untracked")
          const revision = manifestRevision(entries)
          return {
            sourcePath,
            sourceCommit: head,
            revision,
            entries,
            tracked: trackedPaths.length,
            untracked: untrackedPaths.length,
          }
        })

        const destinationMatches = Effect.fn("SourceSync.destinationMatches")(function* (
          path: string,
          entry: ManifestEntry,
        ) {
          const stat = yield* filesystem("inspect sync destination", path, () =>
            lstat(path).catch((cause: NodeJS.ErrnoException) => cause.code === "ENOENT" ? null : Promise.reject(cause))
          )
          if (entry.kind === "delete") return stat === null
          if (stat === null) return false
          if (entry.kind === "symlink") {
            if (!stat.isSymbolicLink()) return false
            const target = yield* filesystem("read sync destination", path, () => readlink(path))
            return hashEntry("symlink", target, stat.mode & 0o777) === entry.digest
          }
          if (!stat.isFile()) return false
          const content = yield* filesystem("read sync destination", path, () => readFile(path))
          return hashEntry("file", content, stat.mode & 0o777) === entry.digest
        })

        const writeEntry = Effect.fn("SourceSync.writeEntry")(function* (
          sourcePath: string,
          relativePath: string,
          entry: ManifestEntry,
          owned: boolean,
        ) {
          const source = join(sourcePath, relativePath)
          const destination = yield* destinationFor(relativePath)
          if (yield* destinationMatches(destination, entry)) return false
          if (entry.origin === "untracked" && !owned && (yield* filesystem(
            "inspect sync destination",
            relativePath,
            () => exists(destination),
          ))) {
            return yield* new RunboxError({
              operation: "sync untracked file",
              message: `${relativePath} conflicts with an unowned runner file`,
              code: "SYNC_DESTINATION_CONFLICT",
              suggestion: "Remove or ignore the runner-generated path, then retry sync.",
              details: relativePath,
            })
          }
          if (entry.kind === "delete") {
            yield* filesystem("remove synchronized path", relativePath, () =>
              rm(destination, { recursive: true, force: true })
            )
            return true
          }
          yield* filesystem("create sync destination", relativePath, () =>
            mkdir(dirname(destination), { recursive: true })
          )
          const temporary = `${destination}.${randomUUID()}.sync`
          if (entry.origin === "untracked" && !owned) {
            yield* Effect.tryPromise({
              try: async () => {
                if (entry.kind === "symlink") {
                  await assertConfinedParents(resolve(runnerPath), relativePath, "runner")
                  await symlink(entry.target ?? "", destination)
                  return
                }
                try {
                  await assertConfinedParents(sourcePath, relativePath, "source")
                  await writeFile(temporary, await readFile(source))
                  await chmod(temporary, entry.mode)
                  await assertConfinedParents(resolve(runnerPath), relativePath, "runner")
                  await link(temporary, destination)
                } finally {
                  await rm(temporary, { force: true })
                }
              },
              catch: (cause) => (cause as NodeJS.ErrnoException).code === "EEXIST"
                ? new RunboxError({
                    operation: "sync untracked file",
                    message: `${relativePath} was created in the runner during synchronization`,
                    code: "SYNC_DESTINATION_CONFLICT",
                    suggestion: "Remove or ignore the runner-generated path, then retry sync.",
                    details: relativePath,
                  })
                : new RunboxError({
                    operation: "write synchronized path",
                    message: String(cause),
                    code: "SYNC_FAILED",
                    suggestion: "Inspect 'runbox logs sync --json' and retry 'runbox sync --json'.",
                    retryable: true,
                    details: relativePath,
                  }),
            })
            return true
          }
          yield* filesystem("write synchronized path", relativePath, async () => {
            await rm(temporary, { recursive: true, force: true })
            if (entry.kind === "symlink") {
              await symlink(entry.target ?? "", temporary)
            } else {
              await assertConfinedParents(sourcePath, relativePath, "source")
              await writeFile(temporary, await readFile(source))
              await chmod(temporary, entry.mode)
            }
            const current = await lstat(destination).catch(() => null)
            if (current?.isDirectory()) await rm(destination, { recursive: true, force: true })
            await assertConfinedParents(resolve(runnerPath), relativePath, "runner")
            await rename(temporary, destination)
          })
          return true
        })

        const restoreEntry = Effect.fn("SourceSync.restoreEntry")(function* (
          relativePath: string,
          entry: ManifestEntry,
        ) {
          const destination = yield* destinationFor(relativePath)
          if (entry.origin === "untracked") {
            const present = yield* filesystem("inspect synchronized path", relativePath, () => exists(destination))
            if (present) yield* filesystem("remove synchronized path", relativePath, () =>
              rm(destination, { recursive: true, force: true })
            )
            return present
          }
          const restored = yield* runGit(runnerPath, ["checkout", "HEAD", "--", relativePath], true)
          if (restored.exitCode === 0) return true
          const present = yield* filesystem("inspect synchronized path", relativePath, () => exists(destination))
          if (present) yield* filesystem("remove synchronized path", relativePath, () =>
            rm(destination, { recursive: true, force: true })
          )
          return present
        })

        const reconcile = Effect.fn("SourceSync.reconcile")(function* (source: SourceRef) {
          return yield* operation.withPermits(1)(Effect.uninterruptible(Effect.gen(function* () {
            const before = yield* Ref.get(snapshotRef)
            yield* Ref.set(snapshotRef, {
              ...before,
              phase: "syncing" as const,
              sourcePath: source.worktreePath,
              sourceCommit: source.commit,
              pending: true,
              error: null,
            })
            const discovered = yield* discover(source)
            const journal = yield* loadJournal
            const matchingApplied = journal.applied?.sourcePath === discovered.sourcePath &&
                journal.applied.sourceCommit === discovered.sourceCommit
              ? journal.applied.entries
              : {}
            const matchingPending = journal.pending?.sourcePath === discovered.sourcePath &&
                journal.pending.sourceCommit === discovered.sourceCommit
              ? journal.pending.entries
              : {}
            const previousEntries: Record<string, ManifestEntry> = { ...matchingApplied }
            const desired: Manifest = {
              sourcePath: discovered.sourcePath,
              sourceCommit: discovered.sourceCommit,
              revision: discovered.revision,
              entries: discovered.entries,
            }
            const ownedPaths = new Set(Object.keys(matchingApplied))
            for (const [path, pendingEntry] of Object.entries(matchingPending)) {
              const destination = yield* destinationFor(path)
              if (yield* destinationMatches(destination, pendingEntry)) {
                ownedPaths.add(path)
                previousEntries[path] = pendingEntry
              }
            }
            for (const [path, entry] of Object.entries(discovered.entries)) {
              if (entry.origin !== "untracked" || ownedPaths.has(path)) continue
              const destination = yield* destinationFor(path)
              if (yield* destinationMatches(destination, entry)) continue
              if (yield* filesystem("inspect sync destination", path, () => exists(destination))) {
                return yield* new RunboxError({
                  operation: "sync untracked file",
                  message: `${path} conflicts with an unowned runner file`,
                  code: "SYNC_DESTINATION_CONFLICT",
                  suggestion: "Remove or ignore the runner-generated path, then retry sync.",
                  details: path,
                })
              }
            }
            yield* saveJournal({ version: 1, applied: journal.applied, pending: desired })
            let copied = 0
            let removed = 0
            for (const [path, entry] of Object.entries(previousEntries)) {
              if (discovered.entries[path] !== undefined) continue
              if (yield* restoreEntry(path, entry)) removed += 1
            }
            for (const [path, entry] of Object.entries(discovered.entries)) {
              if (yield* writeEntry(discovered.sourcePath, path, entry, ownedPaths.has(path))) {
                if (entry.kind === "delete") removed += 1
                else copied += 1
              }
            }
            const finalHead = (yield* runGit(discovered.sourcePath, ["rev-parse", "HEAD"])).stdout.trim()
            if (finalHead !== discovered.sourceCommit) {
              return yield* new RunboxError({
                operation: "sync source",
                message: "source HEAD changed during synchronization",
                code: "SYNC_SOURCE_CHANGED",
                suggestion: "Retry synchronization with the new source revision.",
                retryable: true,
                details: finalHead,
              })
            }
            const confirmed = yield* discover(source)
            if (confirmed.revision !== discovered.revision) {
              return yield* new RunboxError({
                operation: "sync source",
                message: "source files changed during synchronization",
                code: "SYNC_SOURCE_CHANGED",
                suggestion: "Retry synchronization after the current file writes settle.",
                retryable: true,
              })
            }
            yield* saveJournal({ version: 1, applied: desired, pending: null })
            const completedAt = Date.now()
            const setupChanged = [...new Set([
              ...Object.keys(previousEntries),
              ...Object.keys(discovered.entries),
            ])].some(isSetupPath)
            const mode = subscription === null ? "off" as const : "watch" as const
            yield* Ref.set(snapshotRef, {
              mode,
              phase: mode === "watch" ? "watching" as const : "idle" as const,
              sourcePath: discovered.sourcePath,
              sourceCommit: discovered.sourceCommit,
              revision: discovered.revision,
              lastCompletedAt: completedAt,
              copied,
              removed,
              tracked: discovered.tracked,
              untracked: discovered.untracked,
              setupChanged,
              pending: false,
              error: null,
            })
            yield* logs.append(logPath, `${JSON.stringify({
              at: completedAt,
              sourcePath: discovered.sourcePath,
              sourceCommit: discovered.sourceCommit,
              revision: discovered.revision,
              copied,
              removed,
              tracked: discovered.tracked,
              untracked: discovered.untracked,
              setupChanged,
            })}\n`)
            return {
              sourcePath: discovered.sourcePath,
              sourceCommit: discovered.sourceCommit,
              revision: discovered.revision,
              copied,
              removed,
              tracked: discovered.tracked,
              untracked: discovered.untracked,
              setupChanged,
              completedAt,
            }
          }))).pipe(
            Effect.tapError((error) => Ref.update(snapshotRef, (snapshot) => ({
              ...snapshot,
              phase: "failed" as const,
              pending: false,
              error: error.message,
            }))),
          )
        })

        const clearTimers = () => {
          if (debounceTimer !== null) clearTimeout(debounceTimer)
          if (headTimer !== null) clearInterval(headTimer)
          if (retryTimer !== null) clearTimeout(retryTimer)
          debounceTimer = null
          headTimer = null
          retryTimer = null
        }

        const unsubscribeRaw = Effect.fn("SourceSync.unsubscribeRaw")(function* () {
          generation += 1
          clearTimers()
          const current = subscription
          if (current !== null) {
            yield* Effect.tryPromise({
              try: () => current.unsubscribe(),
              catch: (cause) => new RunboxError({
                operation: "stop source watcher",
                message: String(cause),
                code: "WATCH_STOP_FAILED",
                suggestion: "Run 'runbox stop all --json' to restart the repository daemon cleanly.",
              }),
            })
            if (subscription === current) subscription = null
          }
          if (subscription === null) {
            watchedPath = null
            watchedCommit = null
          }
          yield* Ref.update(snapshotRef, (snapshot) => ({
            ...snapshot,
            mode: "off" as const,
            phase: snapshot.phase === "failed" ? "failed" as const : "idle" as const,
            pending: false,
          }))
        })

        const unwatch = operation.withPermits(1)(unsubscribeRaw())

        const watch = Effect.fn("SourceSync.watch")(function* (
          source: SourceRef,
          onInvalidated: () => void,
        ) {
          return yield* operation.withPermits(1)(Effect.uninterruptible(Effect.gen(function* () {
          if (source.kind !== "worktree" || source.worktreePath === null) {
            yield* unsubscribeRaw()
            return
          }
          const sourcePath = resolve(source.worktreePath)
          if (subscription !== null && watchedPath === sourcePath && watchedCommit === source.commit) return
          yield* unsubscribeRaw()
          const activeGeneration = generation
          const invalidate = () => {
            if (activeGeneration !== generation) return
            runFork(Ref.update(snapshotRef, (snapshot) => ({ ...snapshot, pending: true })))
            if (debounceTimer !== null) clearTimeout(debounceTimer)
            debounceTimer = setTimeout(() => {
              debounceTimer = null
              if (activeGeneration === generation) onInvalidated()
            }, 75)
          }
          subscription = yield* Effect.tryPromise({
            try: async () => {
              const next = await watcher.subscribe(sourcePath, (error, events) => {
                if (activeGeneration !== generation) return
                if (error !== null) {
                  watchedCommit = null
                  runFork(Ref.update(snapshotRef, (snapshot) => ({
                    ...snapshot,
                    phase: "failed" as const,
                    error: String(error),
                  })))
                  if (retryTimer === null) {
                    retryTimer = setTimeout(() => {
                      retryTimer = null
                      if (activeGeneration === generation) onInvalidated()
                    }, 1_000)
                  }
                  return
                }
                if (events.length > 0) invalidate()
              }, { ignore: [".git", ".git/**", "**/.git/**"] })
              if (activeGeneration !== generation) {
                await next.unsubscribe()
                throw new Error("watch source changed during subscription")
              }
              return next
            },
            catch: (cause) => new RunboxError({
              operation: "start source watcher",
              message: String(cause),
              code: "WATCH_START_FAILED",
              suggestion: "Run 'runbox sync --json' and inspect 'runbox logs sync --json'.",
              retryable: true,
            }),
          })
          watchedPath = sourcePath
          watchedCommit = source.commit
          headTimer = setInterval(() => {
            if (activeGeneration !== generation || headPollRunning) return
            headPollRunning = true
            runFork(runGit(sourcePath, ["rev-parse", "HEAD"], true).pipe(
              Effect.tap((output) => Effect.sync(() => {
                if (output.exitCode === 0 && output.stdout.trim() !== source.commit) invalidate()
              })),
              Effect.ignore,
              Effect.ensuring(Effect.sync(() => { headPollRunning = false })),
            ))
          }, 1_000)
          yield* Ref.update(snapshotRef, (snapshot) => ({
            ...snapshot,
            mode: "watch" as const,
            phase: "watching" as const,
            sourcePath,
            sourceCommit: source.commit,
            error: null,
          }))
          })))
        })

        yield* Effect.addFinalizer(() => unsubscribeRaw().pipe(Effect.retry({ times: 2 }), Effect.orDie))

        return SourceSync.of({
          reconcile,
          watch,
          unwatch,
          snapshot: Ref.get(snapshotRef),
        })
      }),
    )
}
