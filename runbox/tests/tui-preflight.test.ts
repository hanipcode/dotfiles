import { describe, expect, it } from "vitest"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { spawn, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const cli = resolve("bin/runbox.tsx")
const fakeOpenCode = resolve("tests/fixtures/fake-opencode")

const run = (
  cwd: string,
  env: Readonly<Record<string, string>>,
  ...args: ReadonlyArray<string>
) => spawnSync("bun", [cli, ...args], {
  cwd,
  env: { ...process.env, ...env },
  encoding: "utf8",
  timeout: 20_000,
})

describe("TUI activation", () => {
  it("switches to the invoking worktree while showing the dashboard", async () => {
    const root = await mkdtemp(join(tmpdir(), "runbox-tui-repo-"))
    const home = await mkdtemp(join(tmpdir(), "runbox-tui-home-"))
    const feature = join(home, "feature")
    await chmod(fakeOpenCode, 0o755)
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: {
        quick: "node -e \"console.log('complete')\"",
        dev: "node -e \"setInterval(() => {}, 1000)\"",
      },
    }))
    const git = (cwd: string, ...args: ReadonlyArray<string>) => {
      const result = spawnSync("git", [...args], { cwd, encoding: "utf8" })
      if (result.status !== 0) throw new Error(result.stderr)
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
      RUNBOX_OPENCODE_BIN: fakeOpenCode,
      RUNBOX_STARTUP_GRACE_MS: "0",
      RUNBOX_STABILIZATION_MS: "0",
      RUNBOX_TEST_CLI: cli,
    }
    const initialized = run(root, env, "--no-tui", "quick")
    expect(initialized.status, initialized.stderr).toBe(0)
    git(root, "worktree", "add", "-b", "feature", feature)

    const interactive = (...args: ReadonlyArray<string>) => new Promise<{
      readonly status: number | null
      readonly stdout: string
      readonly stderr: string
    }>((resolveRun) => {
      const child = spawn("/usr/bin/expect", ["-c", [
        "set timeout 10",
        `spawn -noecho bun $env(RUNBOX_TEST_CLI) ${args.join(" ")}`,
        "expect {",
        "  *logs* {}",
        "  timeout {}",
        "}",
        "after 500",
        "catch {send -- q}",
        "expect eof",
      ].join("\n")], {
        cwd: feature,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
      child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
      const quit = setTimeout(() => child.stdin.write("q"), 1_000)
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000)
      child.once("close", (exitCode) => {
        clearTimeout(quit)
        clearTimeout(timeout)
        resolveRun({ status: exitCode, stdout, stderr })
      })
    })
    const waitForStatus = async (predicate: (stdout: string) => boolean) => {
      let latest = run(feature, env, "status", "--json")
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (latest.status === 0 && predicate(latest.stdout)) return latest
        await new Promise((resolveRun) => setTimeout(resolveRun, 200))
        latest = run(feature, env, "status", "--json")
      }
      return latest
    }
    const result = await interactive("dev")
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).not.toBeNull()
    expect(output).not.toContain("RUNNER_SOURCE_MISMATCH")
    expect(output).toContain(" logs")
    const status = await waitForStatus((stdout) => JSON.parse(stdout).data.state.source?.branch === "feature")
    expect(status.status, status.stderr).toBe(0)
    expect(JSON.parse(status.stdout).data.state.source).toMatchObject({
      kind: "worktree",
      branch: "feature",
    })
    run(feature, env, "stop", "all", "--json")
    run(feature, env, "shutdown", "--json")

    await writeFile(join(feature, "watched.txt"), "watched\n")
    const watched = await interactive("dev", "-w")
    const watchedOutput = `${watched.stdout}\n${watched.stderr}`
    expect(watched.status).not.toBeNull()
    expect(watchedOutput).toContain(" logs")
    const watchedStatus = await waitForStatus((stdout) => JSON.parse(stdout).data.state.commands[".:dev"]?.sourceWatch === true)
    expect(watchedStatus.status, watchedStatus.stderr).toBe(0)
    expect(JSON.parse(watchedStatus.stdout).data.state.commands[".:dev"]?.sourceWatch).toBe(true)
    run(feature, env, "stop", "all", "--json")
    run(feature, env, "shutdown", "--json")
  }, 60_000)
})
