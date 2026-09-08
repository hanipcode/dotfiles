import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"

const cli = resolve("bin/runbox.tsx")
const fakeOpenCode = resolve("tests/fixtures/bin/opencode")
const fakeGh = resolve("tests/fixtures/fake-gh")

const run = (cwd: string, env: Readonly<Record<string, string>>, ...args: ReadonlyArray<string>) =>
  spawnSync("bun", [cli, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 20_000 })

describe("nested package CLI", () => {
  it.effect("starts a command when the package is below the repository root", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-nested-repo-")))
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-nested-home-")))
      const packageDir = join(root, "apps", "web")
      yield* Effect.promise(() => chmod(fakeOpenCode, 0o755))
      yield* Effect.promise(() => chmod(fakeGh, 0o755))
      yield* Effect.promise(() => writeFile(join(root, "bun.lock"), "{}\n"))
      yield* Effect.promise(() => mkdir(packageDir, { recursive: true }))
      yield* Effect.promise(() => writeFile(join(packageDir, "package.json"), JSON.stringify({
        packageManager: "bun@1.2.23",
        scripts: { quick: "node -e \"console.log('complete')\"" },
      })))

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
        PATH: `${dirname(fakeOpenCode)}:${process.env.PATH ?? ""}`,
        RUNBOX_GH_BIN: fakeGh,
        RUNBOX_STACK_JSON: "",
      }
      const started = run(packageDir, env, "--no-tui", "--json", "quick")
      expect(started.status, `${started.stdout}\n${started.stderr}`).toBe(0)
      expect(JSON.parse(started.stdout).data.state.commands["apps/web:quick"]?.status).toBe("completed")

      const shutdown = run(packageDir, env, "shutdown", "--json")
      expect(shutdown.status, `${shutdown.stdout}\n${shutdown.stderr}`).toBe(0)
    }),
    30_000,
  )
})
