import { Context, Effect, Layer } from "effect"
import { access, cp, lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { createHash } from "node:crypto"
import type { ProjectContext, RepoState, SourceRef } from "../domain.ts"
import { DirtyWorktree, RunboxError } from "../errors.ts"
import { Shell } from "./Shell.ts"

const exists = (path: string) => access(path).then(() => true, () => false)

export class Git extends Context.Tag("@runbox/Git")<
  Git,
  {
    readonly dirty: (project: ProjectContext) => Effect.Effect<string, RunboxError>
    readonly dirtyFingerprint: (project: ProjectContext) => Effect.Effect<string, RunboxError>
    readonly commit: (
      project: ProjectContext,
      message: string,
    ) => Effect.Effect<SourceRef, RunboxError>
    readonly requireClean: (project: ProjectContext) => Effect.Effect<void, RunboxError | DirtyWorktree>
    readonly ensureRunner: (
      project: ProjectContext,
      state: RepoState,
    ) => Effect.Effect<void, RunboxError>
    readonly checkout: (
      state: RepoState,
      source: SourceRef,
    ) => Effect.Effect<void, RunboxError>
    readonly updateSubmodules: (state: RepoState) => Effect.Effect<void, RunboxError>
    readonly setupChanged: (
      state: RepoState,
      fromCommit: string,
      toCommit: string,
    ) => Effect.Effect<boolean, RunboxError>
    readonly setupFingerprint: (
      state: RepoState,
      commit: string,
    ) => Effect.Effect<string, RunboxError>
    readonly environmentSource: (
      project: ProjectContext,
      state: RepoState,
      override?: string,
    ) => Effect.Effect<string, RunboxError>
    readonly syncEnvironment: (state: RepoState) => Effect.Effect<void, RunboxError>
  }
>() {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const shell = yield* Shell

      const runGit = (cwd: string, args: ReadonlyArray<string>) =>
        shell.run(["git", ...args], { cwd }).pipe(
          Effect.mapError((error) =>
            new RunboxError({ operation: `git ${args[0] ?? ""}`, message: error.stderr }),
          ),
        )

      const dirty = Effect.fn("Git.dirty")(function* (project: ProjectContext) {
        const output = yield* runGit(project.repoRoot, ["status", "--short", "--untracked-files=all"])
        return output.stdout.trim()
      })

      const dirtyFingerprint = Effect.fn("Git.dirtyFingerprint")(function* (project: ProjectContext) {
        const diff = yield* runGit(project.repoRoot, ["diff", "--binary", "HEAD"])
        const untracked = yield* runGit(project.repoRoot, ["ls-files", "--others", "--exclude-standard"])
        const files = untracked.stdout.split("\n").filter((path) => path !== "").sort()
        const content = yield* Effect.forEach(files, (path) => Effect.tryPromise({
          try: async () => {
            const absolute = join(project.repoRoot, path)
            const stat = await lstat(absolute)
            return {
              mode: stat.mode,
              type: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other",
              content: stat.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute),
            }
          },
          catch: (cause) => new RunboxError({ operation: "fingerprint untracked source", message: String(cause), details: path }),
        }), { concurrency: 4 })
        const hash = createHash("sha256")
        hash.update(diff.stdout)
        for (let index = 0; index < files.length; index += 1) {
          hash.update(files[index] ?? "")
          const entry = content[index]
          hash.update(String(entry?.mode ?? ""))
          hash.update(entry?.type ?? "")
          hash.update(entry?.content ?? Buffer.alloc(0))
        }
        return hash.digest("hex")
      })

      const requireClean = Effect.fn("Git.requireClean")(function* (project: ProjectContext) {
        const summary = yield* dirty(project)
        if (summary !== "") {
          return yield* new DirtyWorktree({ path: project.repoRoot, summary })
        }
      })

      const commit = Effect.fn("Git.commit")(function* (
        project: ProjectContext,
        message: string,
      ) {
        yield* runGit(project.repoRoot, ["add", "-A"])
        yield* runGit(project.repoRoot, ["commit", "-m", message])
        const head = yield* runGit(project.repoRoot, ["rev-parse", "HEAD"])
        const branch = yield* runGit(project.repoRoot, ["branch", "--show-current"])
        return {
          kind: "worktree" as const,
          worktreePath: project.repoRoot,
          branch: branch.stdout.trim() || null,
          commit: head.stdout.trim(),
          stack: null,
        }
      })

      const ensureRunner = Effect.fn("Git.ensureRunner")(function* (
        project: ProjectContext,
        state: RepoState,
      ) {
        if (yield* Effect.promise(() => exists(join(state.runnerPath, ".git")))) return
        yield* Effect.tryPromise({
          try: () => mkdir(dirname(state.runnerPath), { recursive: true }),
          catch: (cause) =>
            new RunboxError({ operation: "create runner directory", message: String(cause) }),
        })
        yield* runGit(project.repoRoot, [
          "worktree",
          "add",
          "--detach",
          state.runnerPath,
          project.commit,
        ])
      })

      const checkout = Effect.fn("Git.checkout")(function* (
        state: RepoState,
        source: SourceRef,
      ) {
        yield* runGit(state.runnerPath, ["reset", "--hard"])
        yield* runGit(state.runnerPath, ["clean", "-fd"])
        yield* runGit(state.runnerPath, ["checkout", "--detach", "--force", source.commit])
      })

      const updateSubmodules = Effect.fn("Git.updateSubmodules")(function* (state: RepoState) {
        yield* runGit(state.runnerPath, ["submodule", "update", "--init", "--recursive"])
      })

      const setupChanged = Effect.fn("Git.setupChanged")(function* (
        state: RepoState,
        fromCommit: string,
        toCommit: string,
      ) {
        const output = yield* runGit(state.runnerPath, [
          "diff",
          "--name-only",
          fromCommit,
          toCommit,
          "--",
          ":(glob)**/package.json",
          ":(glob)**/package-lock.json",
          ":(glob)**/pnpm-lock.yaml",
          ":(glob)**/yarn.lock",
          ":(glob)**/bun.lock",
          ":(glob)**/bun.lockb",
          ":(glob)**/.npmrc",
          ":(glob)**/.node-version",
          ":(glob)**/.tool-versions",
          ":(glob)**/pnpm-workspace.yaml",
          ":(glob)**/turbo.json",
          ":(glob)**/.env*.example",
          ":(glob).agents/runbox/**",
        ])
        return output.stdout.trim() !== ""
      })

      const setupFingerprint = Effect.fn("Git.setupFingerprint")(function* (
        state: RepoState,
        commit: string,
      ) {
        const output = yield* runGit(state.runnerPath, ["ls-tree", "-r", "--full-tree", commit])
        const exactNames = new Set([
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
        const setupEntries = output.stdout.split("\n").filter((line) => {
          const path = line.slice(line.indexOf("\t") + 1)
          const name = basename(path)
          return exactNames.has(name) || path.startsWith(".agents/runbox/") ||
            (name.startsWith(".env") && name.endsWith(".example"))
        }).join("\n")
        return createHash("sha256").update(setupEntries).digest("hex")
      })

      const validateEnvironmentSource = Effect.fn("Git.validateEnvironmentSource")(function* (
        project: ProjectContext,
        state: RepoState,
        path: string,
      ) {
        const physicalPath = yield* Effect.tryPromise({
          try: () => realpath(resolve(path)),
          catch: (cause) => new RunboxError({
            operation: "resolve environment source",
            message: String(cause),
            code: "ENVIRONMENT_SOURCE_NOT_FOUND",
            suggestion: "Run 'runbox init --environment-source <path>' with an existing worktree from this repository.",
          }),
        })
        const root = (yield* runGit(physicalPath, ["rev-parse", "--show-toplevel"])).stdout.trim()
        const physicalRoot = yield* Effect.tryPromise({
          try: () => realpath(root),
          catch: (cause) => new RunboxError({ operation: "resolve environment source root", message: String(cause) }),
        })
        const common = (yield* runGit(physicalRoot, ["rev-parse", "--git-common-dir"])).stdout.trim()
        const commonDir = resolve(isAbsolute(common) ? common : join(physicalRoot, common))
        if (commonDir !== project.commonDir) {
          return yield* new RunboxError({
            operation: "validate environment source",
            message: `${physicalRoot} belongs to a different Git repository`,
            code: "ENVIRONMENT_SOURCE_MISMATCH",
            suggestion: "Choose a worktree that shares this repository's Git common directory.",
          })
        }
        if (physicalRoot === resolve(state.runnerPath)) {
          return yield* new RunboxError({
            operation: "validate environment source",
            message: "the managed runner cannot be its own environment source",
            code: "ENVIRONMENT_SOURCE_UNSAFE",
            suggestion: "Choose the primary or another source worktree.",
          })
        }
        return physicalRoot
      })

      const environmentSource = Effect.fn("Git.environmentSource")(function* (
        project: ProjectContext,
        state: RepoState,
        override?: string,
      ) {
        if (override !== undefined) {
          return yield* validateEnvironmentSource(project, state, override)
        }
        if (state.environmentSourceRoot !== null) {
          return yield* validateEnvironmentSource(project, state, state.environmentSourceRoot)
        }
        const worktrees = yield* runGit(project.repoRoot, ["worktree", "list", "--porcelain"])
        const primary = worktrees.stdout.split("\n").find((line) => line.startsWith("worktree "))
          ?.slice("worktree ".length)
        if (primary === undefined || primary === "") {
          return yield* new RunboxError({
            operation: "discover environment source",
            message: "Git did not report a primary worktree",
            code: "ENVIRONMENT_SOURCE_REQUIRED",
            suggestion: "Run 'runbox init --environment-source <path>' with a worktree that contains the canonical .env files.",
          })
        }
        return yield* validateEnvironmentSource(project, state, primary)
      })

      const syncEnvironment = Effect.fn("Git.syncEnvironment")(function* (state: RepoState) {
        if (state.environmentSourceRoot === null) {
          return yield* new RunboxError({
            operation: "sync environment",
            message: "repository has no configured environment source",
            code: "ENVIRONMENT_SOURCE_REQUIRED",
            suggestion: "Run 'runbox init --environment-source <path>'.",
          })
        }
        const sourceRoot = state.environmentSourceRoot
        const ignored = yield* runGit(sourceRoot, [
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "-z",
          "--",
          ":(glob).env*",
          ":(glob)**/.env*",
        ])
        const excludedDirectories = new Set([
          ".claude",
          ".git",
          ".next",
          ".turbo",
          "build",
          "coverage",
          "dist",
          "node_modules",
        ])
        const files = ignored.stdout.split("\0").filter((relative) =>
          relative !== "" &&
          basename(relative).startsWith(".env") &&
          !relative.split("/").some((part) => excludedDirectories.has(part))
        )
        yield* Effect.tryPromise({
          try: async () => {
            for (const relative of files) {
              const source = join(sourceRoot, relative)
              const destination = join(state.runnerPath, relative)
              if (!(await exists(source))) continue
              await mkdir(dirname(destination), { recursive: true })
              await cp(source, destination)
            }
          },
          catch: (cause) =>
            new RunboxError({
              operation: "sync environment",
              message: String(cause),
              code: "ENVIRONMENT_SYNC_FAILED",
              suggestion: "Check the configured environment source and retry.",
            }),
        })
      })

      return Git.of({
        dirty,
        dirtyFingerprint,
        commit,
        requireClean,
        ensureRunner,
        checkout,
        updateSubmodules,
        setupChanged,
        setupFingerprint,
        environmentSource,
        syncEnvironment,
      })
    }),
  )
}
