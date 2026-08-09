import { describe, expect, it } from "vitest"
import { chmod, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
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
  timeout: 30_000,
})

describe("runbox forward", () => {
  it("runs exact argv synchronously with structured failures and retained output", async () => {
    const root = await mkdtemp(join(tmpdir(), "runbox-forward-repo-"))
    const home = await mkdtemp(join(tmpdir(), "runbox-forward-home-"))
    await chmod(fakeOpenCode, 0o755)
    await writeFile(join(root, "package.json"), JSON.stringify({
      packageManager: "bun@1.2.23",
      scripts: {},
    }))
    await writeFile(join(root, "bun.lock"), "{}\n")
    await writeFile(join(root, ".gitignore"), ".env*\n")
    await writeFile(join(root, ".env"), "FORWARD_SECRET=loaded\n")
    await writeFile(join(root, "probe.mjs"), [
      "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), secret: process.env.FORWARD_SECRET }))",
      "console.error('probe stderr')",
      "",
    ].join("\n"))
    const git = (...args: ReadonlyArray<string>) => {
      const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8" })
      if (result.status !== 0) throw new Error(result.stderr)
    }
    git("init")
    git("config", "user.email", "runbox@example.test")
    git("config", "user.name", "Runbox Test")
    git("add", "-A")
    git("commit", "-m", "fixture")
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim()
    const env = {
      RUNBOX_HOME: join(home, "runbox"),
      XDG_DATA_HOME: join(home, "legacy-data"),
      XDG_STATE_HOME: join(home, "legacy-state"),
      RUNBOX_OPENCODE_BIN: fakeOpenCode,
      RUNBOX_STARTUP_GRACE_MS: "0",
      RUNBOX_STABILIZATION_MS: "0",
    }

    const forwarded = run(
      root,
      env,
      "forward",
      "--no-tui",
      "--json",
      "--",
      "node",
      "probe.mjs",
      "a b",
      "$HOME",
      "*",
      "",
    )
    expect(forwarded.status, `${forwarded.stderr}\n${forwarded.stdout}`).toBe(0)
    const success = JSON.parse(forwarded.stdout) as {
      ok: boolean
      command: string
      data: {
        started: boolean
        argv: ReadonlyArray<string>
        cwd: string
        sourceCommit: string
        exitCode: number
        stdout: string
        stderr: string
        logFile: string
      }
    }
    expect(success).toMatchObject({ ok: true, command: "forward" })
    expect(success.data).toMatchObject({ started: true })
    expect(success.data.argv).toEqual(["node", "probe.mjs", "a b", "$HOME", "*", ""])
    expect(success.data.sourceCommit).toBe(commit)
    expect(success.data.exitCode).toBe(0)
    expect(success.data.stderr).toContain("probe stderr")
    expect(JSON.parse(success.data.stdout.trim())).toMatchObject({
      argv: ["a b", "$HOME", "*", ""],
      secret: "loaded",
    })
    expect(JSON.parse(success.data.stdout.trim()).cwd).toBe(await realpath(success.data.cwd))

    const raw = run(root, env, "forward", "--no-tui", "node", "probe.mjs", "raw")
    expect(raw.status, raw.stderr).toBe(0)
    expect(JSON.parse(raw.stdout.trim())).toMatchObject({ argv: ["raw"], secret: "loaded" })
    expect(raw.stderr).toContain("probe stderr")

    const repoId = (await readdir(join(home, "runbox", "state")))[0]
    const state = JSON.parse(await readFile(join(home, "runbox", "state", repoId ?? "", "state.json"), "utf8")) as {
      commands: Record<string, unknown>
    }
    expect(state.commands).toEqual({})

    const retained = run(root, env, "logs", "forward", "--json")
    expect(retained.status, retained.stderr).toBe(0)
    expect(JSON.parse(retained.stdout).data.log).toContain(success.data.argv[0])
    expect(JSON.parse(retained.stdout).data.log).toContain("probe stderr")

    const failed = run(
      root,
      env,
      "forward",
      "--no-tui",
      "--json",
      "--",
      "node",
      "-e",
      "console.error('expected failure'); process.exit(17)",
    )
    expect(failed.status).toBe(17)
    expect(JSON.parse(failed.stdout)).toMatchObject({
      ok: false,
      command: "forward",
      data: { exitCode: 17, stderr: expect.stringContaining("expected failure") },
      error: { code: "FORWARDED_COMMAND_FAILED", retryable: false },
    })

    const missing = run(root, env, "forward", "--no-tui", "--json", "missing-runbox-executable")
    expect(missing.status).toBe(1)
    expect(JSON.parse(missing.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "FORWARD_EXECUTABLE_NOT_FOUND",
        retryable: false,
        details: expect.stringContaining('"started":false'),
      },
    })

    run(root, env, "stop", "all", "--json")
    run(root, env, "shutdown", "--json")
  }, 60_000)
})
