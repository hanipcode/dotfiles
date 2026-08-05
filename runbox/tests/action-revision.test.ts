import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { RepoState } from "../src/domain.ts"
import { request } from "../src/ipc.ts"

const cli = resolve("bin/runbox.tsx")
const fakeOpenCode = resolve("tests/fixtures/fake-opencode")

describe("global action revisions", () => {
  it("rejects a stale revision inside the daemon mutation queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "runbox-revision-repo-"))
    const home = await mkdtemp(join(tmpdir(), "runbox-revision-home-"))
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
      RUNBOX_STARTUP_GRACE_MS: "0",
      RUNBOX_STABILIZATION_MS: "0",
    }
    const initialized = spawnSync("bun", [cli, "--no-tui", "quick"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 20_000,
    })
    expect(initialized.status, initialized.stderr).toBe(0)
    const repoId = (await readdir(join(home, "runbox", "state")))[0]
    expect(repoId).toBeDefined()
    const state = JSON.parse(await readFile(join(home, "runbox", "state", repoId!, "state.json"), "utf8")) as RepoState
    expect(state.source).not.toBeNull()
    const socket = `/tmp/runbox-${process.getuid?.() ?? 0}/${repoId}.sock`
    const response = await Effect.runPromise(request(socket, {
      type: "switch",
      source: state.source!,
      expectedRevision: "stale-revision",
    }))
    expect(response).toMatchObject({
      ok: false,
      error: { code: "ACTION_PLAN_STALE" },
    })

    spawnSync("bun", [cli, "stop", "all", "--json"], { cwd: root, env, encoding: "utf8", timeout: 20_000 })
  }, 30_000)
})
