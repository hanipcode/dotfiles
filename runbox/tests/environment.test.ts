import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commandEnvironment } from "../src/services/Supervisor.ts"

describe("command environment", () => {
  it("loads package env files without overriding the shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "runbox-env-"))
    await writeFile(join(root, "package.json"), "{}\n")
    await writeFile(join(root, ".env"), "FROM_ENV=base\nSHARED=env\n")
    await writeFile(join(root, ".env.local"), "FROM_LOCAL=local\nSHARED=local\n")

    const env = await commandEnvironment(root, root, { SHARED: "shell", FROM_SHELL: "shell" })

    expect(env).toMatchObject({
      FROM_ENV: "base",
      FROM_LOCAL: "local",
      FROM_SHELL: "shell",
      SHARED: "shell",
    })
  })

  it("loads env files through the ancestor package chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "runbox-env-monorepo-"))
    const app = join(root, "apps", "web")
    const packageDir = join(app, "admin")
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(root, "package.json"), "{}\n")
    await writeFile(join(app, "package.json"), "{}\n")
    await writeFile(join(packageDir, "package.json"), "{}\n")
    await writeFile(join(root, ".env"), "ROOT=root\nSHARED=root\n")
    await writeFile(join(root, ".env.local"), "ROOT_LOCAL=root-local\nSHARED=root-local\n")
    await writeFile(join(app, ".env"), "APP=app\nSHARED=app\n")
    await writeFile(join(packageDir, ".env"), "LEAF=leaf\nSHARED=leaf\n")
    await writeFile(join(packageDir, ".env.local"), "LEAF_LOCAL=leaf-local\nSHARED=leaf-local\n")

    const env = await commandEnvironment(root, packageDir, { SHARED: "shell" })

    expect(env).toMatchObject({
      ROOT: "root",
      ROOT_LOCAL: "root-local",
      APP: "app",
      LEAF: "leaf",
      LEAF_LOCAL: "leaf-local",
      SHARED: "shell",
    })
  })

  it("skips ancestor directories without package.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "runbox-env-skip-"))
    const packageDir = join(root, "groups", "admin")
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(root, "package.json"), "{}\n")
    await writeFile(join(packageDir, "package.json"), "{}\n")
    await writeFile(join(root, "groups", ".env"), "SKIPPED=yes\n")
    await writeFile(join(packageDir, ".env"), "LEAF=yes\n")

    const env = await commandEnvironment(root, packageDir, {})

    expect(env.LEAF).toBe("yes")
    expect(env.SKIPPED).toBeUndefined()
  })
})
