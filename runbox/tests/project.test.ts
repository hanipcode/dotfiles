import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { Project } from "../src/services/Project.ts"
import { CoreLayer } from "../src/layers.ts"

const git = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = spawnSync("git", [...args], { cwd })
  if (result.status !== 0) throw new Error(result.stderr.toString())
}

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "runbox-project-"))
  git(root, "init")
  git(root, "config", "user.email", "runbox@example.test")
  git(root, "config", "user.name", "Runbox Test")
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10", scripts: { root: "echo root" } }))
  await mkdir(join(root, "apps", "web"), { recursive: true })
  await writeFile(join(root, "apps", "web", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }))
  git(root, "add", "-A")
  git(root, "commit", "-m", "fixture")
  return root
}

describe("Project", () => {
  it.effect("discovers the nearest package and repository-wide package manager", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(fixture)
      const projectService = yield* Project
      const rootProject = yield* projectService.discover(root)
      const project = yield* projectService.discover(join(root, "apps", "web"))
      const info = yield* projectService.packageInfo(project)

      expect(project.repoRoot).toBe(yield* Effect.promise(() => realpath(root)))
      expect(project.repoId).toBe(rootProject.repoId)
      expect(project.commonDir).toBe(rootProject.commonDir)
      expect(project.packagePath).toBe("apps/web")
      expect(project.branch).toMatch(/^(main|master)$/)
      expect(info.manager).toBe("pnpm")
      expect(info.scripts).toEqual({ dev: "vite" })
      yield* projectService.requireScriptAt(project, project.commit, "dev")
      const missingAtSource = yield* projectService.requireScriptAt(project, project.commit, "missing").pipe(Effect.flip)
      expect(missingAtSource._tag).toBe("ScriptNotFound")
    }).pipe(Effect.provide(CoreLayer)),
  )

  it.effect("rejects scripts absent from package.json", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(fixture)
      const projectService = yield* Project
      const project = yield* projectService.discover(root)
      const error = yield* Effect.flip(projectService.requireScript(project, "missing"))
      expect(error._tag).toBe("ScriptNotFound")
    }).pipe(Effect.provide(CoreLayer)),
  )
})
