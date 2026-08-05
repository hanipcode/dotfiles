import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { RepoState } from "../src/domain.ts"
import { Git } from "../src/services/Git.ts"
import { Project } from "../src/services/Project.ts"
import { CoreLayer } from "../src/layers.ts"

const command = (cwd: string, ...args: ReadonlyArray<string>) => {
  const [executable, ...rest] = args
  if (executable === undefined) throw new Error("empty command")
  const result = spawnSync(executable, rest, { cwd })
  if (result.status !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

describe("Git managed runner", () => {
  it.effect("switches commits while preserving ignored environment", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-git-")))
      command(root, "git", "init")
      command(root, "git", "config", "user.email", "runbox@example.test")
      command(root, "git", "config", "user.name", "Runbox Test")
      yield* Effect.promise(() => writeFile(join(root, ".gitignore"), ".env*\nnode_modules/\n"))
      yield* Effect.promise(() => writeFile(join(root, "package.json"), JSON.stringify({ scripts: { dev: "echo ok" } })))
      yield* Effect.promise(() => writeFile(join(root, "value.txt"), "one\n"))
      yield* Effect.promise(() => writeFile(join(root, ".env"), "SECRET=local\n"))
      yield* Effect.promise(() => mkdir(join(root, "packages", "service"), { recursive: true }))
      yield* Effect.promise(() => writeFile(
        join(root, "packages", "service", ".env.staging"),
        "TOKEN=nested\n",
      ))
      command(root, "git", "add", "-A")
      command(root, "git", "commit", "-m", "one")

      const feature = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-feature-")))
      command(root, "git", "worktree", "add", "-b", "feature", feature)
      const projectService = yield* Project
      const gitService = yield* Git
      const project = yield* projectService.discover(feature)
      const runnerPath = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-runner-parent-"))).pipe(
        Effect.map((parent) => join(parent, "worktree")),
      )
      const state = RepoState.make({
        version: 2,
        repoId: project.repoId,
        repoRoot: project.repoRoot,
        commonDir: project.commonDir,
        runnerPath,
        environmentSourceRoot: null,
        source: null,
        preparedCommits: [],
        commands: {},
      })
      const environmentSourceRoot = yield* gitService.environmentSource(project, state)
      const configuredState = { ...state, environmentSourceRoot }
      expect(environmentSourceRoot).toBe(yield* Effect.promise(() => realpath(root)))
      expect(yield* gitService.environmentSource(project, state, feature))
        .toBe(yield* Effect.promise(() => realpath(feature)))
      yield* gitService.ensureRunner(project, configuredState)
      yield* gitService.syncEnvironment(configuredState)

      yield* Effect.promise(() => writeFile(join(root, "value.txt"), "two\n"))
      command(root, "git", "add", "value.txt")
      command(root, "git", "commit", "-m", "two")
      const next = yield* projectService.discover(root)
      yield* gitService.checkout(configuredState, {
        kind: "worktree",
        worktreePath: root,
        branch: next.branch,
        commit: next.commit,
        stack: null,
      })

      expect(yield* Effect.promise(() => readFile(join(runnerPath, "value.txt"), "utf8"))).toBe("two\n")
      expect(yield* Effect.promise(() => readFile(join(runnerPath, ".env"), "utf8"))).toBe("SECRET=local\n")
      expect(yield* Effect.promise(() =>
        readFile(join(runnerPath, "packages", "service", ".env.staging"), "utf8")
      )).toBe("TOKEN=nested\n")
      yield* Effect.promise(() => writeFile(join(root, ".env"), "SECRET=refreshed\n"))
      yield* Effect.promise(() => writeFile(join(runnerPath, ".env.generated"), "GENERATED=runner\n"))
      yield* gitService.syncEnvironment(configuredState)
      expect(yield* Effect.promise(() => readFile(join(runnerPath, ".env"), "utf8"))).toBe("SECRET=refreshed\n")
      expect(yield* Effect.promise(() => readFile(join(runnerPath, ".env.generated"), "utf8")))
        .toBe("GENERATED=runner\n")
      expect(yield* Effect.promise(() => access(join(root, ".git")))).toBeUndefined()
    }).pipe(Effect.provide(CoreLayer)),
  )

  it.effect("fingerprints only tracked setup inputs", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-fingerprint-")))
      command(root, "git", "init")
      command(root, "git", "config", "user.email", "runbox@example.test")
      command(root, "git", "config", "user.name", "Runbox Test")
      yield* Effect.promise(() => writeFile(join(root, "package.json"), "{}\n"))
      yield* Effect.promise(() => writeFile(join(root, "source.ts"), "one\n"))
      command(root, "git", "add", "-A")
      command(root, "git", "commit", "-m", "initial")
      const projectService = yield* Project
      const gitService = yield* Git
      const project = yield* projectService.discover(root)
      const runnerPath = join(yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-fingerprint-runner-"))), "worktree")
      const state = RepoState.make({
        version: 2,
        repoId: project.repoId,
        repoRoot: project.repoRoot,
        commonDir: project.commonDir,
        runnerPath,
        environmentSourceRoot: root,
        source: null,
        preparedCommits: [],
        commands: {},
      })
      yield* gitService.ensureRunner(project, state)
      const first = yield* gitService.setupFingerprint(state, project.commit)

      yield* Effect.promise(() => writeFile(join(root, "source.ts"), "two\n"))
      command(root, "git", "add", "source.ts")
      command(root, "git", "commit", "-m", "source")
      const sourceCommit = command(root, "git", "rev-parse", "HEAD")
      expect(yield* gitService.setupFingerprint(state, sourceCommit)).toBe(first)

      yield* Effect.promise(() => writeFile(join(root, "package.json"), "{\"private\":true}\n"))
      command(root, "git", "add", "package.json")
      command(root, "git", "commit", "-m", "setup")
      const setupCommit = command(root, "git", "rev-parse", "HEAD")
      expect(yield* gitService.setupFingerprint(state, setupCommit)).not.toBe(first)
    }).pipe(Effect.provide(CoreLayer)),
  )

  it.effect("fingerprints tracked and untracked worktree content", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-dirty-fingerprint-")))
      command(root, "git", "init")
      command(root, "git", "config", "user.email", "runbox@example.test")
      command(root, "git", "config", "user.name", "Runbox Test")
      yield* Effect.promise(() => writeFile(join(root, "package.json"), "{}\n"))
      yield* Effect.promise(() => writeFile(join(root, "tracked.txt"), "one\n"))
      command(root, "git", "add", "-A")
      command(root, "git", "commit", "-m", "initial")
      const projectService = yield* Project
      const gitService = yield* Git
      const project = yield* projectService.discover(root)

      const clean = yield* gitService.dirtyFingerprint(project)
      yield* Effect.promise(() => writeFile(join(root, "tracked.txt"), "two\n"))
      const tracked = yield* gitService.dirtyFingerprint(project)
      yield* Effect.promise(() => writeFile(join(root, "tracked.txt"), "three\n"))
      const trackedAgain = yield* gitService.dirtyFingerprint(project)
      yield* Effect.promise(() => writeFile(join(root, "untracked.txt"), "new\n"))
      const untracked = yield* gitService.dirtyFingerprint(project)

      expect(tracked).not.toBe(clean)
      expect(trackedAgain).not.toBe(tracked)
      expect(untracked).not.toBe(trackedAgain)
    }).pipe(Effect.provide(CoreLayer)),
  )
})
