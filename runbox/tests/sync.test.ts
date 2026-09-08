import { describe, expect, it } from "vitest"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

const cli = resolve("bin/runbox.tsx")
const fakeOpenCode = resolve("tests/fixtures/bin/opencode")

const run = (
  cwd: string,
  env: Readonly<Record<string, string>>,
  ...args: ReadonlyArray<string>
) => spawnSync("bun", [cli, ...args], {
  cwd,
  env: { ...process.env, ...env },
  encoding: "utf8",
  timeout: 30_000,
})

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(50)
  }
  throw new Error("condition did not become true")
}

describe("source synchronization", () => {
  it("syncs dirty overlays and moves one watched source without restarting dev", async () => {
    const root = await mkdtemp(join(tmpdir(), "runbox-sync-repo-"))
    const physicalRoot = await realpath(root)
    const home = await mkdtemp(join(tmpdir(), "runbox-sync-home-"))
    await chmod(fakeOpenCode, 0o755)
    await writeFile(join(root, "package.json"), JSON.stringify({
      packageManager: "bun@1.2.23",
      scripts: {
        dev: "node -e \"setInterval(() => {}, 1000)\"",
      },
    }))
    await writeFile(join(root, "bun.lock"), "{}\n")
    await writeFile(join(root, ".gitignore"), ".env*\nnode_modules\n")
    await writeFile(join(root, ".env"), "SECRET=canonical\n")
    await writeFile(join(root, "app.txt"), "base\n")
    await writeFile(join(root, "remove.txt"), "remove\n")
    await mkdir(join(root, "tracked"))
    await writeFile(join(root, "tracked", "nested.txt"), "tracked\n")
    const git = (cwd: string, ...args: ReadonlyArray<string>) => {
      const result = spawnSync("git", [...args], { cwd, encoding: "utf8" })
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    git(root, "init")
    git(root, "config", "user.email", "runbox@example.test")
    git(root, "config", "user.name", "Runbox Test")
    git(root, "add", "-A")
    git(root, "commit", "-m", "fixture")
    const env = {
      RUNBOX_HOME: join(home, "runbox"),
      XDG_DATA_HOME: join(home, "legacy-data"),
      XDG_STATE_HOME: join(home, "legacy-state"),
      PATH: `${dirname(fakeOpenCode)}:${process.env.PATH ?? ""}`,
      RUNBOX_STARTUP_GRACE_MS: "0",
      RUNBOX_STABILIZATION_MS: "0",
    }

    await writeFile(join(root, "app.txt"), "dirty-a\n")
    await rm(join(root, "remove.txt"))
    await writeFile(join(root, "new-a.txt"), "new-a\n")
    const first = run(root, env, "sync", "--json")
    expect(first.status, `${first.stderr}\n${first.stdout}`).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({
      ok: true,
      command: "sync",
      data: { tracked: 2, untracked: 1 },
    })
    const repoId = (await readdir(join(home, "runbox", "state")))[0]
    const statePath = join(home, "runbox", "state", repoId ?? "", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf8")) as { runnerPath: string }
    expect(await readFile(join(state.runnerPath, "app.txt"), "utf8")).toBe("dirty-a\n")
    expect(await readFile(join(state.runnerPath, "new-a.txt"), "utf8")).toBe("new-a\n")
    await expect(readFile(join(state.runnerPath, "remove.txt"), "utf8")).rejects.toThrow()
    await mkdir(join(state.runnerPath, "node_modules"), { recursive: true })
    await writeFile(join(state.runnerPath, "node_modules", "cache.txt"), "cache\n")

    await writeFile(join(root, "app.txt"), "base\n")
    await rm(join(root, "new-a.txt"))
    const restored = run(root, env, "sync", "--json")
    expect(restored.status, restored.stderr).toBe(0)
    expect(await readFile(join(state.runnerPath, "app.txt"), "utf8")).toBe("base\n")
    await expect(readFile(join(state.runnerPath, "new-a.txt"), "utf8")).rejects.toThrow()
    expect(await readFile(join(state.runnerPath, "node_modules", "cache.txt"), "utf8")).toBe("cache\n")

    await writeFile(join(state.runnerPath, "conflict.txt"), "runner-owned\n")
    await writeFile(join(root, "conflict.txt"), "source-owned\n")
    const conflict = run(root, env, "sync", "--json")
    expect(conflict.status).toBe(1)
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      ok: false,
      error: { code: "SYNC_DESTINATION_CONFLICT", retryable: false },
    })
    const conflictRetry = run(root, env, "sync", "--json")
    expect(conflictRetry.status).toBe(1)
    expect(JSON.parse(conflictRetry.stdout)).toMatchObject({
      error: { code: "SYNC_DESTINATION_CONFLICT" },
    })
    expect(await readFile(join(state.runnerPath, "conflict.txt"), "utf8")).toBe("runner-owned\n")
    await rm(join(root, "conflict.txt"))
    await rm(join(state.runnerPath, "conflict.txt"))
    expect(run(root, env, "sync", "--json").status).toBe(0)

    const failedWatch = run(root, env, "missing-script", "-w", "--no-tui", "--json")
    expect(failedWatch.status).toBe(1)
    const afterFailedWatch = run(root, env, "status", "--json")
    expect(afterFailedWatch.status, afterFailedWatch.stderr).toBe(0)
    expect(JSON.parse(afterFailedWatch.stdout).data.sync.mode).toBe("off")

    await writeFile(join(root, "app.txt"), "watched-a\n")
    const watchedA = run(root, env, "dev", "-w", "--no-tui", "--json")
    expect(watchedA.status, `${watchedA.stderr}\n${watchedA.stdout}`).toBe(0)
    const watchedASnapshot = JSON.parse(watchedA.stdout).data as {
      state: { commands: Record<string, { pid: number; sourceWatch: boolean }> }
      sync: { mode: string; sourcePath: string }
    }
    const originalPid = watchedASnapshot.state.commands[".:dev"]?.pid
    expect(watchedASnapshot.state.commands[".:dev"]?.sourceWatch).toBe(true)
    expect(watchedASnapshot.sync).toMatchObject({ mode: "watch", sourcePath: physicalRoot })

    const beforeIgnoredEvent = JSON.parse(run(root, env, "status", "--json").stdout).data.sync.lastCompletedAt
    await mkdir(join(root, "node_modules", "generated"), { recursive: true })
    await writeFile(join(root, "node_modules", "generated", "cache.txt"), "ignored\n")
    await sleep(300)
    const afterIgnoredEvent = JSON.parse(run(root, env, "status", "--json").stdout).data.sync
    expect(afterIgnoredEvent.lastCompletedAt).toBe(beforeIgnoredEvent)
    expect(afterIgnoredEvent.pending).toBe(false)

    const initialPackageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>
    await writeFile(join(root, "package.json"), JSON.stringify({ ...initialPackageJson, private: true }))
    await waitFor(async () => {
      const synced = JSON.parse(await readFile(join(state.runnerPath, "package.json"), "utf8")) as Record<string, unknown>
      return synced.private === true
    })
    expect(JSON.parse(run(root, env, "status", "--json").stdout).data.sync.setupChanged).toBe(true)

    await writeFile(join(root, "app.txt"), "watched-a-2\n")
    await waitFor(async () => (await readFile(join(state.runnerPath, "app.txt"), "utf8")) === "watched-a-2\n")
    expect(JSON.parse(run(root, env, "status", "--json").stdout).data.sync.setupChanged).toBe(false)

    const branchB = join(home, "branch-b")
    git(root, "worktree", "add", "-b", "branch-b", branchB)
    const physicalBranchB = await realpath(branchB)
    await writeFile(join(branchB, "app.txt"), "watched-b\n")
    await writeFile(join(branchB, "new-b.txt"), "new-b\n")
    const watchedB = run(branchB, env, "dev", "-w", "--no-tui", "--json")
    expect(watchedB.status, `${watchedB.stderr}\n${watchedB.stdout}`).toBe(0)
    const watchedBSnapshot = JSON.parse(watchedB.stdout).data as {
      state: { source: { worktreePath: string }; commands: Record<string, { pid: number }> }
      sync: { mode: string; sourcePath: string }
    }
    expect(watchedBSnapshot.state.commands[".:dev"]?.pid).toBe(originalPid)
    expect(watchedBSnapshot.state.source.worktreePath).toBe(physicalBranchB)
    expect(watchedBSnapshot.sync).toMatchObject({ mode: "watch", sourcePath: physicalBranchB })
    expect(await readFile(join(state.runnerPath, "app.txt"), "utf8")).toBe("watched-b\n")
    expect(await readFile(join(state.runnerPath, "new-b.txt"), "utf8")).toBe("new-b\n")

    await writeFile(join(root, "app.txt"), "stale-a-event\n")
    await sleep(300)
    expect(await readFile(join(state.runnerPath, "app.txt"), "utf8")).toBe("watched-b\n")
    await writeFile(join(branchB, "app.txt"), "watched-b-2\n")
    await waitFor(async () => (await readFile(join(state.runnerPath, "app.txt"), "utf8")) === "watched-b-2\n")

    const packageJson = JSON.parse(await readFile(join(branchB, "package.json"), "utf8")) as Record<string, unknown>
    await writeFile(join(branchB, "package.json"), JSON.stringify({ ...packageJson, private: true }))
    await waitFor(async () => {
      const synced = JSON.parse(await readFile(join(state.runnerPath, "package.json"), "utf8")) as Record<string, unknown>
      return synced.private === true
    })
    const afterSetupChange = run(branchB, env, "status", "--json")
    expect(afterSetupChange.status, afterSetupChange.stderr).toBe(0)
    expect(JSON.parse(afterSetupChange.stdout).data).toMatchObject({
      state: { commands: { ".:dev": { pid: originalPid } } },
      sync: { setupChanged: true },
    })

    for (const worktree of [root, branchB, root, branchB]) {
      const moved = run(worktree, env, "dev", "-w", "--no-tui", "--json")
      expect(moved.status, `${moved.stderr}\n${moved.stdout}`).toBe(0)
      expect(JSON.parse(moved.stdout).data.state.commands[".:dev"].pid).toBe(originalPid)
    }

    const stopped = run(branchB, env, "stop", "dev", "--json")
    expect(stopped.status, stopped.stderr).toBe(0)
    await waitFor(async () => {
      const status = run(branchB, env, "status", "--json")
      return status.status === 0 && JSON.parse(status.stdout).data.sync.mode === "off"
    })
    expect(await readFile(join(state.runnerPath, "node_modules", "cache.txt"), "utf8")).toBe("cache\n")

    const journalPath = join(home, "runbox", "state", repoId ?? "", "sync.json")
    await writeFile(join(state.runnerPath, "pending-only.txt"), "runner-generated\n")
    await writeFile(journalPath, JSON.stringify({
      version: 1,
      applied: null,
      pending: {
        sourcePath: physicalBranchB,
        sourceCommit: git(branchB, "rev-parse", "HEAD"),
        revision: "interrupted",
        entries: {
          "pending-only.txt": {
            kind: "file",
            origin: "untracked",
            digest: "not-the-runner-content",
            mode: 420,
            target: null,
          },
        },
      },
    }))
    expect(run(branchB, env, "sync", "--json").status).toBe(0)
    expect(await readFile(join(state.runnerPath, "pending-only.txt"), "utf8")).toBe("runner-generated\n")

    const outside = join(home, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "protected.txt"), "protected\n")
    await rm(join(branchB, "tracked"), { recursive: true })
    await symlink(outside, join(branchB, "tracked"))
    const unsafeSource = run(branchB, env, "sync", "--json")
    expect(unsafeSource.status).toBe(1)
    expect(JSON.parse(unsafeSource.stdout)).toMatchObject({ error: { code: "SYNC_UNSAFE_PATH" } })
    expect(await readFile(join(outside, "protected.txt"), "utf8")).toBe("protected\n")
    await rm(join(branchB, "tracked"))
    await mkdir(join(branchB, "tracked"))
    await writeFile(join(branchB, "tracked", "nested.txt"), "tracked\n")

    await mkdir(join(branchB, "linked"))
    await writeFile(join(branchB, "linked", "protected.txt"), "source\n")
    await symlink(outside, join(state.runnerPath, "linked"))
    const unsafe = run(branchB, env, "sync", "--json")
    expect(unsafe.status).toBe(1)
    expect(JSON.parse(unsafe.stdout)).toMatchObject({ error: { code: "SYNC_UNSAFE_PATH" } })
    expect(await readFile(join(outside, "protected.txt"), "utf8")).toBe("protected\n")

    await rm(join(state.runnerPath, "linked"), { force: true })
    const runnerBackup = `${state.runnerPath}-backup`
    await rename(state.runnerPath, runnerBackup)
    await symlink(outside, state.runnerPath)
    const unsafeRoot = run(branchB, env, "sync", "--json")
    expect(unsafeRoot.status).toBe(1)
    expect(JSON.parse(unsafeRoot.stdout)).toMatchObject({ error: { code: "RUNBOX_ERROR" } })
    expect(await readFile(join(outside, "protected.txt"), "utf8")).toBe("protected\n")
    await rm(state.runnerPath)
    await rename(runnerBackup, state.runnerPath)

    await writeFile(journalPath, JSON.stringify({
      version: 1,
      applied: {
        sourcePath: physicalBranchB,
        sourceCommit: git(branchB, "rev-parse", "HEAD"),
        revision: "unsafe",
        entries: {
          "../../protected.txt": {
            kind: "delete",
            origin: "untracked",
            digest: "unsafe",
            mode: 0,
            target: null,
          },
        },
      },
      pending: null,
    }))
    const invalidJournal = run(branchB, env, "sync", "--json")
    expect(invalidJournal.status).toBe(1)
    expect(JSON.parse(invalidJournal.stdout)).toMatchObject({ error: { code: "SYNC_JOURNAL_INVALID" } })
    expect(await readFile(join(outside, "protected.txt"), "utf8")).toBe("protected\n")
    run(branchB, env, "stop", "all", "--json")
    run(branchB, env, "shutdown", "--json")
  }, 90_000)
})
