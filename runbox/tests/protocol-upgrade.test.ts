import { describe, expect, it } from "vitest"
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { spawn, spawnSync } from "node:child_process"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

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
  timeout: 20_000,
})

const runAsync = (
  cwd: string,
  env: Readonly<Record<string, string>>,
  ...args: ReadonlyArray<string>
) => new Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>((resolveRun) => {
  const child = spawn("bun", [cli, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
  child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
  child.once("close", (status) => resolveRun({ status, stdout, stderr }))
})

describe("daemon protocol upgrades", () => {
  it("restarts a pre-configure daemon and retries the command", async () => {
    const root = await mkdtemp(join(tmpdir(), "runbox-upgrade-repo-"))
    const home = await mkdtemp(join(tmpdir(), "runbox-upgrade-home-"))
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
      RUNBOX_HOME: join(home, "runbox"),
      XDG_DATA_HOME: join(home, "legacy-data"),
      XDG_STATE_HOME: join(home, "legacy-state"),
      PATH: `${dirname(fakeOpenCode)}:${process.env.PATH ?? ""}`,
      RUNBOX_STARTUP_GRACE_MS: "0",
      RUNBOX_STABILIZATION_MS: "0",
    }

    const initialized = run(root, env, "--no-tui", "quick")
    expect(initialized.status, initialized.stderr).toBe(0)
    const stopped = run(root, env, "stop", "all", "--json")
    expect(stopped.status, stopped.stderr).toBe(0)
    const runtimeRoot = `/tmp/runbox-${process.getuid?.() ?? 0}`
    const repoIds = await readdir(join(home, "runbox", "state"))
    const socketPath = join(runtimeRoot, `${repoIds[0]}.sock`)
    await rm(socketPath, { force: true })

    const connections: Array<Socket> = []
    const server = createServer((socket) => {
      connections.push(socket)
      let input = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => {
        input += chunk
        if (!input.includes("\n")) return
        const request = JSON.parse(input.slice(0, input.indexOf("\n"))) as { readonly type: string }
        if (request.type === "configure") {
          socket.end(`${JSON.stringify({
            ok: false,
            error: {
              code: "INVALID_REQUEST",
              message: "Expected old request schema, actual configure",
              operation: "decode daemon request",
              suggestion: "Upgrade the runbox client and retry the command.",
              retryable: false,
              details: null,
            },
          })}\n`)
          return
        }
        socket.end(`${JSON.stringify({ ok: true, message: "old daemon" })}\n`)
        if (request.type === "shutdown") server.close()
      })
    })
    await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen))

    const result = await runAsync(root, env, "--no-tui", "quick")

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
    expect(result.stdout).toContain(".:quick")
    run(root, env, "stop", "all", "--json")
    run(root, env, "shutdown", "--json")
    for (const connection of connections) connection.destroy()
    server.close()
  }, 30_000)
})
