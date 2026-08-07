import { Effect } from "effect"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { GitReviewError, UnstableSnapshotError } from "../errors.ts"
import type { ReviewSnapshot } from "./domain.ts"

interface CommandResult {
  readonly stdout: Buffer
  readonly stderr: string
  readonly exitCode: number
}

const run = async (
  cwd: string,
  command: ReadonlyArray<string>,
  allowFailure = false,
): Promise<CommandResult> => {
  const [executable, ...args] = command
  if (executable === undefined) throw new Error("cannot run an empty command")
  const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
  const stdoutChunks: Array<Buffer> = []
  const stderrChunks: Array<Buffer> = []
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolveExit(code ?? -1))
  })
  const stdout = Buffer.concat(stdoutChunks)
  const stderr = Buffer.concat(stderrChunks).toString("utf8")
  if (exitCode !== 0 && !allowFailure) {
    throw new GitReviewError({
      operation: command.join(" "),
      message: stderr.trim() || `command exited with ${exitCode}`,
      details: cwd,
    })
  }
  return { stdout, stderr, exitCode }
}

const text = async (cwd: string, command: ReadonlyArray<string>, allowFailure = false): Promise<string> =>
  (await run(cwd, command, allowFailure)).stdout.toString("utf8").trim()

const nulPaths = (value: Buffer): ReadonlyArray<string> =>
  value.toString("utf8").split("\0").filter((path) => path.length > 0).sort()

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex")

const slug = (value: string): string => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return (normalized || "detached").slice(0, 48)
}

const isRepositoryControl = (path: string): boolean => {
  const name = basename(path).toLowerCase()
  return name === "agents.md" || name === "claude.md" || name === "opencode.json" || name === "opencode.jsonc" ||
    path === ".opencode" || path.startsWith(`.opencode${sep}`) || path === ".claude" || path.startsWith(`.claude${sep}`) ||
    path === ".agents" || path.startsWith(`.agents${sep}`)
}

const snapshotPath = (snapshotDirectory: string, path: string): string =>
  isRepositoryControl(path)
    ? join(snapshotDirectory, ".hanif-agent", "untrusted-repository-control", `${path}.txt`)
    : join(snapshotDirectory, path)

const isNoise = (path: string): boolean => {
  const lower = path.toLowerCase()
  if (lower.includes("migration")) return false
  const name = basename(lower)
  return name === "bun.lock" || name === "package-lock.json" || name === "yarn.lock" ||
    name === "pnpm-lock.yaml" || name === "cargo.lock" || name === "go.sum" ||
    lower.endsWith(".min.js") || lower.endsWith(".min.css") || lower.endsWith(".bundle.js") || lower.endsWith(".map")
}

const resolveDefaultBase = async (root: string): Promise<string> => {
  const symbolic = await text(root, ["git", "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], true)
  const candidates = [symbolic, "origin/main", "main", "origin/master", "master"].filter((value) => value.length > 0)
  for (const candidate of candidates) {
    const result = await run(root, ["git", "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], true)
    if (result.exitCode === 0) return candidate
  }
  throw new GitReviewError({
    operation: "resolve default review base",
    message: "no origin default branch, main, or master reference exists; pass --base",
    details: root,
  })
}

const sourcePaths = async (root: string): Promise<ReadonlyArray<string>> =>
  nulPaths((await run(root, ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"])).stdout)

const digestSource = async (root: string, paths: ReadonlyArray<string>): Promise<string> => {
  const digest = createHash("sha256")
  for (const path of paths) {
    const absolute = join(root, path)
    const state = await lstat(absolute).catch((cause: NodeJS.ErrnoException) => cause.code === "ENOENT" ? null : Promise.reject(cause))
    if (state === null) {
      digest.update(`deleted\0${path}\0`)
      continue
    }
    if (state.isSymbolicLink()) {
      digest.update(`symlink\0${path}\0${await readlink(absolute)}\0`)
      continue
    }
    if (!state.isFile()) continue
    digest.update(`file\0${path}\0${state.mode}\0`)
    digest.update(await readFile(absolute))
    digest.update("\0")
  }
  return digest.digest("hex")
}

const copySource = async (
  root: string,
  snapshotDirectory: string,
  paths: ReadonlyArray<string>,
): Promise<string> => {
  const digest = createHash("sha256")
  for (const path of paths) {
    const source = join(root, path)
    const destination = snapshotPath(snapshotDirectory, path)
    const state = await lstat(source).catch((cause: NodeJS.ErrnoException) => cause.code === "ENOENT" ? null : Promise.reject(cause))
    if (state === null) {
      digest.update(`deleted\0${path}\0`)
      continue
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    if (state.isSymbolicLink()) {
      const target = await readlink(source)
      await writeFile(`${destination}.symlink.txt`, `Symlink omitted from inert snapshot: ${path} -> ${target}\n`, { mode: 0o600 })
      digest.update(`symlink\0${path}\0${target}\0`)
      continue
    }
    if (!state.isFile()) continue
    const content = await readFile(source)
    await writeFile(destination, content, { mode: state.mode & 0o777 })
    digest.update(`file\0${path}\0${state.mode}\0`)
    digest.update(content)
    digest.update("\0")
  }
  return digest.digest("hex")
}

const untrackedPatch = async (root: string, path: string): Promise<string> => {
  const result = await run(root, ["git", "diff", "--no-index", "--no-ext-diff", "--", "/dev/null", path], true)
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new GitReviewError({
      operation: `create patch for ${path}`,
      message: result.stderr.trim() || `git diff exited with ${result.exitCode}`,
      details: root,
    })
  }
  return result.stdout.toString("utf8")
}

const buildPatch = async (
  root: string,
  mergeBase: string,
): Promise<{ readonly patch: string; readonly changedPaths: ReadonlyArray<string>; readonly skippedPaths: ReadonlyArray<string> }> => {
  const tracked = nulPaths((await run(root, ["git", "diff", "--name-only", "-z", mergeBase, "--"])).stdout)
  const untracked = nulPaths((await run(root, ["git", "ls-files", "-z", "--others", "--exclude-standard"])).stdout)
  const allPaths = [...new Set([...tracked, ...untracked])].sort()
  const changedPaths = allPaths.filter((path) => !isNoise(path))
  const skippedPaths = allPaths.filter(isNoise)
  const untrackedSet = new Set(untracked)
  const patches: Array<string> = []
  for (const path of changedPaths) {
    patches.push(untrackedSet.has(path)
      ? await untrackedPatch(root, path)
      : (await run(root, ["git", "diff", "--find-renames", mergeBase, "--", path])).stdout.toString("utf8"))
  }
  return { patch: patches.join("\n"), changedPaths, skippedPaths }
}

const captureOnce = async (
  cwd: string,
  requestedBase: string | undefined,
  runId: string,
): Promise<ReviewSnapshot | null> => {
  const root = resolve(await text(cwd, ["git", "rev-parse", "--show-toplevel"]))
  const branchValue = await text(root, ["git", "branch", "--show-current"])
  const head = await text(root, ["git", "rev-parse", "HEAD"])
  const branch = branchValue || `detached-${head.slice(0, 12)}`
  const baseRef = requestedBase ?? await resolveDefaultBase(root)
  const baseTip = await text(root, ["git", "rev-parse", `${baseRef}^{commit}`])
  const mergeBase = await text(root, ["git", "merge-base", baseTip, head])
  const remote = await text(root, ["git", "remote", "get-url", "origin"], true)
  const repositoryIdentity = `${remote || root}\0${root}`
  const repositoryId = hash(repositoryIdentity).slice(0, 16)
  const streamDirectory = join("/tmp/agentic-review", `${slug(basename(root))}-${repositoryId}`, `${slug(branch)}-${hash(branch).slice(0, 12)}`)
  const runDirectory = join(streamDirectory, "runs", runId)
  const directory = join(runDirectory, "worktree")
  await mkdir(directory, { recursive: true, mode: 0o700 })

  const beforePaths = await sourcePaths(root)
  const effectiveTreeId = await copySource(root, directory, beforePaths)
  const afterPaths = await sourcePaths(root)
  const afterTreeId = await digestSource(root, afterPaths)
  if (beforePaths.join("\0") !== afterPaths.join("\0") || effectiveTreeId !== afterTreeId) {
    await rm(runDirectory, { recursive: true, force: true })
    return null
  }

  const { patch, changedPaths, skippedPaths } = await buildPatch(root, mergeBase)
  const contextDirectory = join(runDirectory, "context")
  await mkdir(contextDirectory, { recursive: true, mode: 0o700 })
  const patchPath = join(contextDirectory, "changes.patch")
  await writeFile(patchPath, patch, { mode: 0o600 })
  await writeFile(join(contextDirectory, "review-context.json"), JSON.stringify({
    repositoryRoot: root,
    branch,
    baseRef,
    baseTip,
    mergeBase,
    head,
    effectiveTreeId,
    changedPaths,
    skippedPaths,
    repositoryControlFiles: beforePaths.filter(isRepositoryControl),
  }, null, 2), { mode: 0o600 })

  const finalPaths = await sourcePaths(root)
  const finalTreeId = await digestSource(root, finalPaths)
  const finalHead = await text(root, ["git", "rev-parse", "HEAD"])
  const finalBranchValue = await text(root, ["git", "branch", "--show-current"])
  const finalBranch = finalBranchValue || `detached-${finalHead.slice(0, 12)}`
  const finalBaseTip = await text(root, ["git", "rev-parse", `${baseRef}^{commit}`])
  if (afterPaths.join("\0") !== finalPaths.join("\0") || effectiveTreeId !== finalTreeId ||
    head !== finalHead || branch !== finalBranch || baseTip !== finalBaseTip) {
    await rm(runDirectory, { recursive: true, force: true })
    return null
  }

  return {
    repositoryRoot: root,
    repositoryId,
    branch,
    baseRef,
    baseTip,
    mergeBase,
    head,
    effectiveTreeId,
    runtimeDirectory: runDirectory,
    snapshotDirectory: directory,
    patchPath,
    changedPaths,
    skippedPaths,
    historyPath: join(streamDirectory, "review.jsonl"),
    runDirectory,
  }
}

/** Capture a stable, inert copy of the current branch and effective worktree. */
export function captureReviewSnapshot(
  cwd: string,
  baseRef: string | undefined,
  runId: string,
): Effect.Effect<ReviewSnapshot, GitReviewError | UnstableSnapshotError> {
  return Effect.tryPromise({
    try: async () => {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const snapshot = await captureOnce(cwd, baseRef, runId)
        if (snapshot !== null) return snapshot
      }
      throw new UnstableSnapshotError({ root: cwd, attempts: 2 })
    },
    catch: (cause) => {
      if (cause instanceof GitReviewError || cause instanceof UnstableSnapshotError) return cause
      return new GitReviewError({
        operation: "capture review snapshot",
        message: String(cause),
        details: relative(cwd, resolve(cwd)) || cwd,
      })
    },
  })
}

/** Check whether one reviewed commit remains an ancestor of the current commit. */
export function isAncestor(root: string, ancestor: string, descendant: string): Effect.Effect<boolean, GitReviewError> {
  return Effect.tryPromise({
    try: async () => (await run(root, ["git", "merge-base", "--is-ancestor", ancestor, descendant], true)).exitCode === 0,
    catch: (cause) => cause instanceof GitReviewError ? cause : new GitReviewError({
      operation: "check review ancestry",
      message: String(cause),
      details: root,
    }),
  })
}

/** Build the effective-tree delta used by incremental specialist reviewers. */
export function writeIncrementalPatch(
  previousDirectory: string,
  snapshot: ReviewSnapshot,
): Effect.Effect<string, GitReviewError> {
  return Effect.tryPromise({
    try: async () => {
      const result = await run(snapshot.repositoryRoot, [
        "git", "diff", "--no-index", "--no-ext-diff", "--", previousDirectory, snapshot.snapshotDirectory,
      ], true)
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new GitReviewError({
          operation: "create incremental review patch",
          message: result.stderr.trim() || `git diff exited with ${result.exitCode}`,
          details: snapshot.snapshotDirectory,
        })
      }
      const path = join(snapshot.runtimeDirectory, "context", "incremental.patch")
      await writeFile(path, result.stdout, { mode: 0o600 })
      return path
    },
    catch: (cause) => cause instanceof GitReviewError ? cause : new GitReviewError({
      operation: "create incremental review patch",
      message: String(cause),
      details: snapshot.snapshotDirectory,
    }),
  })
}
