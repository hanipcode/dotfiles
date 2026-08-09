import { describe, expect, it } from "vitest"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const cli = resolve("bin/runbox.tsx")
const fakeOpenCode = resolve("tests/fixtures/fake-opencode")

describe("preparation progress", () => {
  it("uses one in-place spinner instead of repeated heartbeat lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "runbox-progress-repo-"))
    const home = await mkdtemp(join(tmpdir(), "runbox-progress-home-"))
    await chmod(fakeOpenCode, 0o755)
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { quick: "node -e \"console.log('complete')\"" },
    }))
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
      ...process.env,
      RUNBOX_HOME: join(home, "runbox"),
      XDG_DATA_HOME: join(home, "legacy-data"),
      XDG_STATE_HOME: join(home, "legacy-state"),
      RUNBOX_OPENCODE_BIN: fakeOpenCode,
      RUNBOX_TEST_OPENCODE_DELAY: "1",
      RUNBOX_STARTUP_GRACE_MS: "0",
      RUNBOX_STABILIZATION_MS: "0",
      RUNBOX_TEST_CLI: cli,
    }
    const result = spawnSync("/usr/bin/expect", ["-c", [
      "set timeout 20",
      "spawn -noecho bun $env(RUNBOX_TEST_CLI) --no-tui quick",
      "expect eof",
    ].join("\n")], { cwd: root, env, encoding: "utf8", timeout: 30_000 })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("Starting quick")
    expect(result.stdout).toContain("\r\u001b[2K")
    expect(result.stdout).not.toContain("is still preparing the runner")
    expect(result.stdout).toContain(".:quick running")

    spawnSync("bun", [cli, "stop", "all", "--json"], { cwd: root, env, encoding: "utf8" })
    spawnSync("bun", [cli, "shutdown", "--json"], { cwd: root, env, encoding: "utf8" })
  }, 30_000)
})
