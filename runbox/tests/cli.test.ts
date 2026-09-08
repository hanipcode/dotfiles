import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"

const cli = resolve("bin/runbox.tsx")
const fakeOpenCode = resolve("tests/fixtures/bin/opencode")
const fakeGh = resolve("tests/fixtures/fake-gh")

const run = (
  cwd: string,
  env: Readonly<Record<string, string>>,
  ...args: ReadonlyArray<string>
) => spawnSync("bun", [cli, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 20_000 })

describe("runbox CLI", () => {
  it.effect("starts, reports, and stops a background command", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-cli-repo-")))
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-cli-home-")))
      yield* Effect.promise(() => chmod(fakeOpenCode, 0o755))
      yield* Effect.promise(() => chmod(fakeGh, 0o755))
      yield* Effect.promise(() => writeFile(join(root, "package.json"), JSON.stringify({
        packageManager: "bun@1.2.23",
        scripts: {
          dev: "node -e \"console.log('ready'); setInterval(() => {}, 1000)\"",
          quick: "node -e \"console.log('complete')\"",
        },
      })))
      yield* Effect.promise(() => writeFile(join(root, "bun.lock"), "{}\n"))
      yield* Effect.promise(() => writeFile(join(root, ".gitignore"), ".env*\n"))
      yield* Effect.promise(() => writeFile(join(root, ".env"), "SECRET=canonical\n"))
      const git = (...args: ReadonlyArray<string>) => {
        const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8" })
        if (result.status !== 0) throw new Error(result.stderr)
      }
      git("init")
      git("config", "user.email", "runbox@example.test")
      git("config", "user.name", "Runbox Test")
      git("add", "-A")
      git("commit", "-m", "fixture")
      const env = {
        RUNBOX_HOME: join(home, "runbox"),
        XDG_DATA_HOME: join(home, "legacy-data"),
        XDG_STATE_HOME: join(home, "legacy-state"),
        PATH: `${dirname(fakeOpenCode)}:${process.env.PATH ?? ""}`,
        RUNBOX_TEST_OPENCODE_COUNT_FILE: join(home, "opencode-count"),
        RUNBOX_TEST_OPENCODE_DIRECTORY_FILE: join(home, "opencode-directory"),
        RUNBOX_GH_BIN: fakeGh,
        RUNBOX_STACK_JSON: "",
      }

      const missing = run(root, env, "--json", "--no-tui", "missing")
      expect(missing.status).toBe(1)
      expect(JSON.parse(missing.stdout)).toMatchObject({
        ok: false,
        error: { code: "SCRIPT_NOT_FOUND", suggestion: expect.any(String) },
      })

      const commands = run(root, env, "commands", "--json")
      expect(commands.status, commands.stderr).toBe(0)
      expect(JSON.parse(commands.stdout).data.commands.map((command: { name: string }) => command.name))
        .toEqual(["dev", "quick"])

      const quick = run(root, env, "--no-tui", "quick")
      expect(quick.status, quick.stderr).toBe(0)
      expect(quick.stdout).toContain("quick completed")

      const start = run(root, env, "--no-tui", "dev")
      expect(start.status, start.stderr).toBe(0)
      expect(start.stdout).toContain("dev running")

      const status = run(root, env, "status", "--json")
      expect(status.status, status.stderr).toBe(0)
      const snapshot = JSON.parse(status.stdout) as { data: { state: { commands: Record<string, { status: string }> } } }
      expect(snapshot.data.state.commands[".:dev"]?.status).toBe("running")

      const projectName = basename(root)
      const listed = run(home, env, "projects", "--json")
      expect(listed.status, listed.stderr).toBe(0)
      const listedProjects = JSON.parse(listed.stdout).data.projects as Array<{
        environmentSourceRoot: string
        runnerPath: string
      }>
      expect(listedProjects).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: projectName, runningCommands: [expect.objectContaining({ script: "dev" })] }),
      ]))
      expect(listedProjects[0]?.environmentSourceRoot).toBe(yield* Effect.promise(() => realpath(root)))

      const global = run(home, env, "--json")
      expect(global.status, global.stderr).toBe(0)
      expect(JSON.parse(global.stdout)).toMatchObject({
        ok: true,
        command: "projects",
        data: {
          selected: null,
          repositories: [expect.objectContaining({ name: projectName, daemon: "online" })],
        },
      })

      const logs = run(home, env, "logs", projectName, "dev", "--json")
      expect(logs.status, logs.stderr).toBe(0)
      expect(JSON.parse(logs.stdout).data).toMatchObject({
        project: { name: projectName },
        command: { script: "dev", status: "running" },
      })
      expect(JSON.parse(logs.stdout).data.log).toContain("ready")
      const oneLine = run(home, env, "logs", projectName, "dev", "--lines", "1", "--json")
      expect(oneLine.status, oneLine.stderr).toBe(0)
      expect(JSON.parse(oneLine.stdout).data).toMatchObject({ lineLimit: 1, log: "ready" })

      const restarted = run(home, env, "restart", projectName, "dev", "--json")
      expect(restarted.status, restarted.stderr).toBe(0)
      expect(JSON.parse(restarted.stdout).data.state.commands[".:dev"].status).toBe("running")

      const doctor = run(root, env, "doctor", "--json")
      expect(doctor.status, doctor.stderr).toBe(0)
      expect(JSON.parse(doctor.stdout).data).toMatchObject({
        healthy: true,
        checks: expect.arrayContaining([expect.objectContaining({ name: "opencode", status: "ok" })]),
      })

      const invalidArguments = run(root, env, "logs", "--json")
      expect(invalidArguments.status).toBe(1)
      expect(JSON.parse(invalidArguments.stdout)).toMatchObject({
        ok: false,
        error: { code: "INVALID_ARGUMENT" },
      })

      const feature = join(home, "feature")
      git("worktree", "add", "-b", "feature", feature)
      yield* Effect.promise(() => writeFile(join(root, ".env"), "SECRET=refreshed\n"))
      yield* Effect.promise(() => writeFile(join(feature, ".env"), "SECRET=feature\n"))
      yield* Effect.promise(() => writeFile(join(feature, "feature.txt"), "feature\n"))
      const featureGit = (...args: ReadonlyArray<string>) => {
        const result = spawnSync("git", [...args], { cwd: feature, encoding: "utf8" })
        if (result.status !== 0) throw new Error(result.stderr)
      }
      featureGit("add", "feature.txt")
      featureGit("commit", "-m", "feature")

      const switched = run(feature, env, "--no-tui", "--json", "dev")
      expect(switched.status, `${switched.stderr}\n${switched.stdout}`).toBe(0)
      const switchedStatus = run(feature, env, "status", "--json")
      const switchedSnapshot = JSON.parse(switchedStatus.stdout) as {
        data: { state: { source: { branch: string }; commands: Record<string, { status: string }> } }
      }
      expect(switchedSnapshot.data.state.source.branch).toBe("feature")
      expect(switchedSnapshot.data.state.commands[".:dev"]?.status).toBe("running")
      expect((yield* Effect.promise(() => readFile(join(home, "opencode-count"), "utf8"))).trim().split("\n"))
        .toHaveLength(1)
      expect((yield* Effect.promise(() => readFile(join(home, "opencode-directory"), "utf8"))).trim())
        .toBe(listedProjects[0]?.runnerPath)
      expect(yield* Effect.promise(() => readFile(join(listedProjects[0]?.runnerPath ?? "", ".env"), "utf8")))
        .toBe("SECRET=refreshed\n")

      const history = run(home, env, "logs", projectName, "history", "--json")
      expect(history.status, history.stderr).toBe(0)
      expect(JSON.parse(history.stdout).data.log).toContain('"phase":"succeeded"')

      yield* Effect.promise(() => writeFile(join(feature, "dirty.txt"), "committed by runbox\n"))
      const committedSwitch = run(
        feature,
        env,
        "switch",
        "--no-tui",
        "--json",
        "--commit-message",
        "test: commit dirty worktree",
      )
      expect(committedSwitch.status, committedSwitch.stderr).toBe(0)
      expect(spawnSync("git", ["status", "--porcelain"], { cwd: feature, encoding: "utf8" }).stdout).toBe("")
      expect(spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: feature, encoding: "utf8" }).stdout.trim())
        .toBe("test: commit dirty worktree")

      const top = join(home, "top")
      featureGit("worktree", "add", "-b", "top", top)
      yield* Effect.promise(() => writeFile(join(top, "top.txt"), "top\n"))
      const topGit = (...args: ReadonlyArray<string>) => {
        const result = spawnSync("git", [...args], { cwd: top, encoding: "utf8" })
        if (result.status !== 0) throw new Error(result.stderr)
      }
      topGit("add", "top.txt")
      topGit("commit", "-m", "top")
      const featureHead = spawnSync("git", ["rev-parse", "feature"], { cwd: feature, encoding: "utf8" }).stdout.trim()
      const topHead = spawnSync("git", ["rev-parse", "top"], { cwd: feature, encoding: "utf8" }).stdout.trim()
      const stackEnv = {
        ...env,
        RUNBOX_STACK_JSON: JSON.stringify({
          trunk: "main",
          currentBranch: "feature",
          branches: [
            {
              name: "feature",
              head: featureHead,
              base: "base",
              isCurrent: true,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
            },
            {
              name: "top",
              head: topHead,
              base: featureHead,
              isCurrent: false,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
            },
          ],
        }),
      }
      const stackStart = run(feature, stackEnv, "stack", "--no-tui", "--json", "dev")
      expect(stackStart.status, stackStart.stderr).toBe(0)
      const stackSnapshot = JSON.parse(stackStart.stdout) as {
        data: { state: { source: { kind: string; branch: string; stack: { topBranch: string } } } }
      }
      expect(stackSnapshot.data.state.source.kind).toBe("stack")
      expect(stackSnapshot.data.state.source.branch).toBe("top")
      expect(stackSnapshot.data.state.source.stack.topBranch).toBe("top")

      const directFromTop = run(top, stackEnv, "--json", "--no-tui", "dev")
      expect(directFromTop.status, directFromTop.stderr).toBe(0)
      const directSnapshot = JSON.parse(directFromTop.stdout) as {
        data: { state: { source: { kind: string; branch: string } } }
      }
      expect(directSnapshot.data.state.source).toMatchObject({ kind: "worktree", branch: "top" })

      const stop = run(feature, stackEnv, "stop", "all", "--json")
      expect(stop.status, stop.stderr).toBe(0)
      expect(stop.stdout).toContain('"status": "completed"')
      const shutdown = run(feature, stackEnv, "shutdown", "--json")
      expect(shutdown.status, shutdown.stderr).toBe(0)

      const statePath = join(home, "runbox", "state")
      const repoIds = yield* Effect.promise(async () => {
        await mkdir(dirname(statePath), { recursive: true })
        return await import("node:fs/promises").then(({ readdir }) => readdir(statePath))
      })
      const state = yield* Effect.promise(() => readFile(join(statePath, repoIds[0] ?? "", "state.json"), "utf8"))
      expect(state).toContain('"preparedCommits"')
      expect(state).toContain('"environmentSourceRoot"')
    }),
    60_000,
  )
})
