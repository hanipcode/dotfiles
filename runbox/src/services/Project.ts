import { Context, Effect, Layer } from "effect"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { access, readFile, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import type { PackageInfo, ProjectContext } from "../domain.ts"
import { RunboxError, ScriptNotFound } from "../errors.ts"
import { Shell } from "./Shell.ts"

const exists = (path: string) =>
  Effect.tryPromise({
    try: () => access(path).then(() => true, () => false),
    catch: () => new RunboxError({ operation: "access", message: path }),
  })

const hashPath = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16)

const nearestPackageJson = Effect.fn("Project.nearestPackageJson")(function* (
  cwd: string,
  repoRoot: string,
) {
  let current = resolve(cwd)
  while (current === repoRoot || current.startsWith(`${repoRoot}/`)) {
    const candidate = join(current, "package.json")
    if (yield* exists(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return yield* new RunboxError({
    operation: "discover package",
    message: `no package.json found between ${cwd} and ${repoRoot}`,
  })
})

const parsePackageManager = (value: unknown): PackageInfo["manager"] | null => {
  if (typeof value !== "string") return null
  const name = value.split("@")[0]
  return name === "bun" || name === "pnpm" || name === "yarn" || name === "npm"
    ? name
    : null
}

export class Project extends Context.Tag("@runbox/Project")<
  Project,
  {
    readonly discover: (cwd: string) => Effect.Effect<ProjectContext, RunboxError>
    readonly packageInfo: (
      project: ProjectContext,
    ) => Effect.Effect<PackageInfo, RunboxError>
    readonly requireScript: (
      project: ProjectContext,
      script: string,
    ) => Effect.Effect<PackageInfo, RunboxError | ScriptNotFound>
    readonly requireScriptAt: (
      project: ProjectContext,
      commit: string,
      script: string,
    ) => Effect.Effect<void, RunboxError | ScriptNotFound>
    readonly command: (
      info: PackageInfo,
      script: string,
      args: ReadonlyArray<string>,
    ) => ReadonlyArray<string>
  }
>() {
  static readonly layer = Layer.effect(
    Project,
    Effect.gen(function* () {
      const shell = yield* Shell

      const discover = Effect.fn("Project.discover")(function* (cwd: string) {
        const physicalCwd = yield* Effect.tryPromise({
          try: () => realpath(cwd),
          catch: (cause) =>
            new RunboxError({ operation: "resolve working directory", message: String(cause) }),
        })
        const rootResult = yield* shell.run(["git", "rev-parse", "--show-toplevel"], {
          cwd: physicalCwd,
        }).pipe(
          Effect.mapError((error) =>
            new RunboxError({ operation: "discover git repository", message: error.stderr }),
          ),
        )
        const repoRoot = rootResult.stdout.trim()
        const commonResult = yield* shell.run(["git", "rev-parse", "--git-common-dir"], {
          cwd: physicalCwd,
        }).pipe(
          Effect.mapError((error) =>
            new RunboxError({ operation: "discover git common directory", message: error.stderr }),
          ),
        )
        const rawCommon = commonResult.stdout.trim()
        const commonDir = resolve(isAbsolute(rawCommon) ? rawCommon : join(physicalCwd, rawCommon))
        const branchResult = yield* shell.run(["git", "branch", "--show-current"], {
          cwd: physicalCwd,
          allowFailure: true,
        }).pipe(
          Effect.mapError((error) =>
            new RunboxError({ operation: "resolve branch", message: error.stderr }),
          ),
        )
        const commitResult = yield* shell.run(["git", "rev-parse", "HEAD"], { cwd: physicalCwd }).pipe(
          Effect.mapError((error) =>
            new RunboxError({ operation: "resolve HEAD", message: error.stderr }),
          ),
        )
        const packageJsonPath = yield* nearestPackageJson(physicalCwd, repoRoot)
        const packageDir = dirname(packageJsonPath)
        return {
          repoId: hashPath(commonDir),
          repoRoot,
          commonDir,
          packageDir,
          packagePath: relative(repoRoot, packageDir),
          packageJsonPath,
          branch: branchResult.stdout.trim() || null,
          commit: commitResult.stdout.trim(),
        }
      })

      const packageInfo = Effect.fn("Project.packageInfo")(function* (
        project: ProjectContext,
      ) {
        const raw = yield* Effect.tryPromise({
          try: () => readFile(project.packageJsonPath, "utf8"),
          catch: (cause) =>
            new RunboxError({ operation: "read package.json", message: String(cause) }),
        })
        const json = yield* Effect.try({
          try: () => JSON.parse(raw) as Record<string, unknown>,
          catch: (cause) =>
            new RunboxError({ operation: "parse package.json", message: String(cause) }),
        })
        const scriptsValue = json.scripts
        const scripts: Record<string, string> = {}
        if (typeof scriptsValue === "object" && scriptsValue !== null) {
          for (const [name, value] of Object.entries(scriptsValue)) {
            if (typeof value === "string") scripts[name] = value
          }
        }

        let manager = parsePackageManager(json.packageManager)
        let current = project.packageDir
        while (manager === null && (current === project.repoRoot || current.startsWith(`${project.repoRoot}/`))) {
          const manifest = join(current, "package.json")
          if (manifest !== project.packageJsonPath && (yield* exists(manifest))) {
            const parentPackage = yield* Effect.tryPromise({
              try: () => readFile(manifest, "utf8").then((value) => JSON.parse(value) as Record<string, unknown>),
              catch: (cause) =>
                new RunboxError({ operation: "read ancestor package.json", message: String(cause) }),
            })
            manager = parsePackageManager(parentPackage.packageManager)
            if (manager !== null) break
          }
          for (const [filename, candidate] of [
            ["bun.lock", "bun"],
            ["bun.lockb", "bun"],
            ["pnpm-lock.yaml", "pnpm"],
            ["yarn.lock", "yarn"],
            ["package-lock.json", "npm"],
          ] as const) {
            if (yield* exists(join(current, filename))) {
              manager = candidate
              break
            }
          }
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }

        return { path: project.packageJsonPath, scripts, manager: manager ?? "npm" }
      })

      const requireScriptAt = Effect.fn("Project.requireScriptAt")(function* (
        project: ProjectContext,
        commit: string,
        script: string,
      ) {
        const manifest = project.packagePath === "" ? "package.json" : `${project.packagePath}/package.json`
        const result = yield* shell.run(["git", "show", `${commit}:${manifest}`], { cwd: project.repoRoot }).pipe(
          Effect.mapError((error) => new RunboxError({
            operation: "read package script at source",
            message: error.stderr,
            details: `${commit}:${manifest}`,
          })),
        )
        const json = yield* Effect.try({
          try: () => JSON.parse(result.stdout) as { readonly scripts?: unknown },
          catch: (cause) => new RunboxError({ operation: "parse package script at source", message: String(cause), details: manifest }),
        })
        const scripts = typeof json.scripts === "object" && json.scripts !== null
          ? json.scripts as Record<string, unknown>
          : {}
        if (typeof scripts[script] !== "string") return yield* new ScriptNotFound({ script, packagePath: project.packagePath })
      })

      const requireScript = Effect.fn("Project.requireScript")(function* (
        project: ProjectContext,
        script: string,
      ) {
        const info = yield* packageInfo(project)
        if (!(script in info.scripts)) {
          return yield* new ScriptNotFound({ script, packagePath: project.packageJsonPath })
        }
        return info
      })

      const command = (
        info: PackageInfo,
        script: string,
        args: ReadonlyArray<string>,
      ): ReadonlyArray<string> => {
        switch (info.manager) {
          case "bun":
            return ["bun", "run", script, ...(args.length > 0 ? ["--", ...args] : [])]
          case "pnpm":
            return ["pnpm", "run", script, ...(args.length > 0 ? ["--", ...args] : [])]
          case "yarn":
            return ["yarn", "run", script, ...args]
          case "npm":
            return ["npm", "run", script, ...(args.length > 0 ? ["--", ...args] : [])]
        }
      }

      return Project.of({ discover, packageInfo, requireScript, requireScriptAt, command })
    }),
  )
}
