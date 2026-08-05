import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const cli = resolve("bin/runbox.tsx")
const fakeOpenCode = resolve("tests/fixtures/fake-opencode")
const fakeGh = resolve("tests/fixtures/fake-gh")

const run = (cwd: string, env: Readonly<Record<string, string>>, ...args: ReadonlyArray<string>) =>
  spawnSync("bun", [cli, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 15_000 })

describe("launch lifecycle", () => {
  it.live("repairs a command that fails after the startup grace period", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-lifecycle-repo-")))
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-lifecycle-home-")))
      yield* Effect.promise(() => chmod(fakeOpenCode, 0o755))
      yield* Effect.promise(() => chmod(fakeGh, 0o755))
      yield* Effect.promise(() => writeFile(join(root, "package.json"), JSON.stringify({
        packageManager: "bun@1.2.23",
        scripts: {
          delayed: "node -e \"const fs=require('node:fs');const p='.runbox-delayed';setTimeout(()=>{if(!fs.existsSync(p)){fs.writeFileSync(p,'1');process.exit(9)}console.log('repaired');setInterval(()=>{},1000)},400)\"",
        },
      })))
      yield* Effect.promise(() => writeFile(join(root, "bun.lock"), "{}\n"))
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
        RUNBOX_OPENCODE_BIN: fakeOpenCode,
        RUNBOX_GH_BIN: fakeGh,
        RUNBOX_STACK_JSON: "",
        RUNBOX_STARTUP_GRACE_MS: "100",
        RUNBOX_STABILIZATION_MS: "1500",
      }

      const launched = run(root, env, "--no-tui", "delayed")
      expect(launched.status, `${launched.stdout}\n${launched.stderr}`).toBe(0)
      expect(launched.stdout).toContain("delayed running")
      yield* Effect.sleep("1200 millis")

      const status = run(root, env, "status", "--json")
      expect(status.status, `${status.stdout}\n${status.stderr}`).toBe(0)
      expect(JSON.parse(status.stdout).data.state.commands[".:delayed"]?.status).toBe("running")
      const logs = run(root, env, "logs", "delayed", "--json")
      const output = JSON.parse(logs.stdout).data.log as string
      expect(output.match(/\[runbox\]/g)?.length).toBeGreaterThanOrEqual(2)
      expect(output).toContain("repaired")

      const stopped = run(root, env, "stop", "all", "--json")
      expect(stopped.status, `${stopped.stdout}\n${stopped.stderr}`).toBe(0)
    }),
    30_000,
  )
})
