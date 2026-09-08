import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { RepoSnapshot } from "../src/domain.ts"

const exec = promisify(execFile)
const cli = resolve("bin/runbox.tsx")

describe("startup reliability through the CLI", () => {
  it("waits for readiness, preserves timeout errors, and restores a failed source switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "runbox-startup-"))
    const home = await mkdtemp(join(tmpdir(), "runbox-startup-home-"))
    const env = {
      ...process.env,
      RUNBOX_HOME: join(home, "runbox"),
      XDG_DATA_HOME: join(home, "legacy-data"), XDG_STATE_HOME: join(home, "legacy-state"),
      PATH: `${resolve("tests/fixtures/bin")}:${process.env.PATH ?? ""}`,
      RUNBOX_STARTUP_GRACE_MS: "0", RUNBOX_STABILIZATION_MS: "0",
    }
    const run = async (...args: Array<string>) => {
      try {
        const result = await exec("bun", [cli, ...args], { cwd: root, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
        return { ok: true, stdout: result.stdout }
      } catch (failure) {
        if (typeof failure === "object" && failure !== null && "stdout" in failure && typeof failure.stdout === "string") return { ok: false, stdout: failure.stdout }
        throw failure
      }
    }
    const git = (...args: Array<string>) => exec("git", args, { cwd: root })
    const packageJson = {
      packageManager: "bun@1.2.23",
      scripts: { dev: "node app.mjs", timeout: "node -e 'setInterval(() => {}, 1000)'" },
      runbox: { readiness: {
        dev: { type: "log", text: "APP_READY", timeoutMs: 5000 },
        timeout: { type: "log", text: "NEVER_READY", timeoutMs: 200 },
      } },
    }
    const snapshot = (stdout: string) => Schema.decodeUnknownSync(Schema.Struct({ data: RepoSnapshot }))(JSON.parse(stdout)).data
    try {
      await writeFile(join(root, "package.json"), JSON.stringify(packageJson))
      await writeFile(join(root, ".gitignore"), "node_modules\n.env*\n")
      await writeFile(join(root, "app.mjs"), "import { existsSync } from 'node:fs'; if (existsSync('node_modules/force-fail')) process.exit(14); setTimeout(() => console.log('APP_READY'), 500); setInterval(() => {}, 1000)\n")
      await git("init"); await git("config", "user.email", "test@example.test"); await git("config", "user.name", "Test")
      await git("add", "-A"); await git("commit", "-m", "working source")
      const original = (await git("rev-parse", "HEAD")).stdout.trim()
      const started = await run("dev", "--wait-ready", "--no-tui", "--json")
      expect(started.ok, started.stdout).toBe(true)
      expect(snapshot(started.stdout).state.commands[".:dev"]).toMatchObject({ status: "running", readiness: "ready" })

      const timeout = await run("timeout", "--wait-ready", "--no-tui", "--json")
      expect(timeout.ok).toBe(false)
      expect(JSON.parse(timeout.stdout)).toMatchObject({ error: { code: "READINESS_TIMEOUT", retryable: true, suggestion: expect.stringContaining("readiness") } })
      const failedState = snapshot((await run("status", "--json")).stdout).state
      expect(failedState.commands[".:timeout"]).toMatchObject({ status: "failed", pid: null, failure: { code: "READINESS_TIMEOUT" } })

      await writeFile(join(root, "app.mjs"), "process.exit(13)\n")
      await git("add", "-A"); await git("commit", "-m", "broken source")
      const switched = await run("switch", "--no-tui", "--json")
      expect(switched.ok, switched.stdout).toBe(false)
      expect(JSON.parse(switched.stdout)).toMatchObject({ error: { code: "READINESS_COMMAND_EXITED" } })
      const restored = snapshot((await run("status", "--json")).stdout).state
      expect(restored.source?.commit).toBe(original)
      expect(restored.commands[".:dev"]).toMatchObject({ status: "running", readiness: "ready" })
      expect(await readFile(join(restored.runnerPath, "app.mjs"), "utf8")).toContain("APP_READY")
      expect(await readFile(join(root, "app.mjs"), "utf8")).toBe("process.exit(13)\n")

      await writeFile(join(root, "app.mjs"), "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('node_modules', { recursive: true }); writeFileSync('node_modules/force-fail', 'broken ignored state'); process.exit(13)\n")
      await git("add", "-A"); await git("commit", "-m", "break ignored runtime state")
      const unrecoverable = await run("switch", "--no-tui", "--json")
      expect(unrecoverable.ok).toBe(false)
      expect(JSON.parse(unrecoverable.stdout)).toMatchObject({ error: {
        code: "SWITCH_ROLLBACK_FAILED", retryable: false,
        details: expect.stringContaining('"rollbackError"'),
      } })
      const stopped = snapshot((await run("status", "--json")).stdout).state
      expect(Object.values(stopped.commands).every((command) => command.pid === null)).toBe(true)

    } finally {
      await run("stop", "all", "--json")
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  }, 60_000)
})
