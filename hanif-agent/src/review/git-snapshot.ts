import { Effect } from "effect"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { GitReviewError, UnstableSnapshotError } from "../errors.ts"
import type { ReviewSnapshot, ReviewUnit } from "./domain.ts"
import { planReviewUnits, type ReviewPatchFile } from "./review-units.ts"

interface CommandResult {
  readonly stdout: Buffer
  readonly stderr: string
  readonly exitCode: number
}

const run = async (cwd: string, command: ReadonlyArray<string>, allowFailure = false): Promise<CommandResult> => {
  const [executable, ...args] = command
  if (executable === undefined) throw new Error("cannot run an empty command")
  const child = spawn(executable, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  })
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
  value
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0)
    .sort()

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex")

const slug = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return (normalized || "detached").slice(0, 48)
}

const isRepositoryControl = (path: string): boolean => {
  const name = basename(path).toLowerCase()
  return (
    name === "agents.md" ||
    name === "claude.md" ||
    name === "opencode.json" ||
    name === "opencode.jsonc" ||
    path === ".opencode" ||
    path.startsWith(`.opencode${sep}`) ||
    path === ".claude" ||
    path.startsWith(`.claude${sep}`) ||
    path === ".agents" ||
    path.startsWith(`.agents${sep}`)
  )
}

const snapshotPath = (snapshotDirectory: string, path: string): string =>
  isRepositoryControl(path)
    ? join(snapshotDirectory, ".hanif-agent", "untrusted-repository-control", `${path}.txt`)
    : join(snapshotDirectory, path)

const isNoise = (path: string): boolean => {
  const lower = path.toLowerCase()
  if (lower.includes("migration")) return false
  const name = basename(lower)
  return (
    name === "bun.lock" ||
    name === "package-lock.json" ||
    name === "yarn.lock" ||
    name === "pnpm-lock.yaml" ||
    name === "cargo.lock" ||
    name === "go.sum" ||
    lower.endsWith(".min.js") ||
    lower.endsWith(".min.css") ||
    lower.endsWith(".bundle.js") ||
    lower.endsWith(".map")
  )
}

const isRepositoryGuidance = (path: string): boolean => {
  const lower = path.toLowerCase()
  return lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".rst") || lower.endsWith(".adoc")
}

const copyRepositoryGuidance = async (root: string, revision: string, contextDirectory: string): Promise<string> => {
  const paths = nulPaths((await run(root, ["git", "ls-tree", "-r", "-z", "--name-only", revision])).stdout).filter(
    isRepositoryGuidance,
  )
  const guidanceDirectory = join(contextDirectory, "repository-guidance")
  const files: Array<{ readonly path: string; readonly snapshotPath: string }> = []
  for (const path of paths) {
    const destination = join(guidanceDirectory, `${path}.txt`)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(destination, (await run(root, ["git", "show", `${revision}:${path}`])).stdout, { mode: 0o600 })
    files.push({ path, snapshotPath: destination })
  }
  const manifestPath = join(contextDirectory, "repository-guidance.json")
  await writeFile(manifestPath, JSON.stringify({ revision, files }, null, 2), {
    mode: 0o600,
  })
  return manifestPath
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

interface RevisionSourceEntry {
  readonly mode: string
  readonly object: string
  readonly path: string
}

const revisionSourceEntries = async (root: string, revision: string): Promise<ReadonlyArray<RevisionSourceEntry>> => {
  const entries: Array<RevisionSourceEntry> = []
  for (const entry of (await run(root, ["git", "ls-tree", "-r", "-z", revision])).stdout.toString("utf8").split("\0")) {
    if (entry.length === 0) continue
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry)
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) {
      throw new GitReviewError({
        operation: `read source tree for ${revision}`,
        message: "git ls-tree returned an unsupported entry",
        details: entry,
      })
    }
    if (match[2] === "blob") entries.push({ mode: match[1], object: match[3], path: match[4] })
  }
  return entries
}

const digestSource = async (root: string, paths: ReadonlyArray<string>): Promise<string> => {
  const digest = createHash("sha256")
  for (const path of paths) {
    const absolute = join(root, path)
    const state = await lstat(absolute).catch((cause: NodeJS.ErrnoException) =>
      cause.code === "ENOENT" ? null : Promise.reject(cause),
    )
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

const copySource = async (root: string, snapshotDirectory: string, paths: ReadonlyArray<string>): Promise<string> => {
  const digest = createHash("sha256")
  for (const path of paths) {
    const source = join(root, path)
    const destination = snapshotPath(snapshotDirectory, path)
    const state = await lstat(source).catch((cause: NodeJS.ErrnoException) =>
      cause.code === "ENOENT" ? null : Promise.reject(cause),
    )
    if (state === null) {
      digest.update(`deleted\0${path}\0`)
      continue
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    if (state.isSymbolicLink()) {
      const target = await readlink(source)
      await writeFile(`${destination}.symlink.txt`, `Symlink omitted from inert snapshot: ${path} -> ${target}\n`, {
        mode: 0o600,
      })
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

const copyRevisionSource = async (
  root: string,
  revision: string,
  snapshotDirectory: string,
): Promise<{ readonly effectiveTreeId: string; readonly paths: ReadonlyArray<string> }> => {
  const entries = await revisionSourceEntries(root, revision)
  for (const entry of entries) {
    const destination = snapshotPath(snapshotDirectory, entry.path)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const content = (await run(root, ["git", "cat-file", "blob", entry.object])).stdout
    if (entry.mode === "120000") {
      await writeFile(
        `${destination}.symlink.txt`,
        `Symlink omitted from inert snapshot: ${entry.path} -> ${content.toString("utf8")}\n`,
        { mode: 0o600 },
      )
      continue
    }
    await writeFile(destination, content, { mode: entry.mode === "100755" ? 0o700 : 0o600 })
  }
  return {
    effectiveTreeId: await text(root, ["git", "rev-parse", `${revision}^{tree}`]),
    paths: entries.map((entry) => entry.path),
  }
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
  targetRef?: string,
): Promise<{
  readonly patch: string
  readonly files: ReadonlyArray<ReviewPatchFile>
  readonly changedPaths: ReadonlyArray<string>
  readonly skippedPaths: ReadonlyArray<string>
}> => {
  const targetArguments = targetRef === undefined ? [] : [targetRef]
  const tracked = nulPaths(
    (await run(root, ["git", "diff", "--name-only", "-z", mergeBase, ...targetArguments, "--"])).stdout,
  )
  const untracked = targetRef === undefined
    ? nulPaths((await run(root, ["git", "ls-files", "-z", "--others", "--exclude-standard"])).stdout)
    : []
  const allPaths = [...new Set([...tracked, ...untracked])].sort()
  const changedPaths = allPaths.filter((path) => !isNoise(path))
  const skippedPaths = allPaths.filter(isNoise)
  const untrackedSet = new Set(untracked)
  const files: Array<ReviewPatchFile> = []
  for (const path of changedPaths) {
    files.push({
      path,
      patch: untrackedSet.has(path)
        ? await untrackedPatch(root, path)
        : (await run(root, ["git", "diff", "--find-renames", mergeBase, ...targetArguments, "--", path])).stdout.toString("utf8"),
    })
  }
  return { patch: files.map((file) => file.patch).join("\n"), files, changedPaths, skippedPaths }
}

const writeReviewUnits = async (
  contextDirectory: string,
  files: ReadonlyArray<ReviewPatchFile>,
): Promise<{ readonly manifestPath: string; readonly units: ReadonlyArray<ReviewUnit> }> => {
  const directory = join(contextDirectory, "review-units")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const units: Array<ReviewUnit> = []
  for (const plan of planReviewUnits(files)) {
    const patchPath = join(directory, `${plan.id}.patch`)
    await writeFile(patchPath, plan.patch, { mode: 0o600 })
    units.push({
      id: plan.id,
      label: plan.label,
      paths: plan.paths,
      patchPath,
      patchLines: plan.patchLines,
      patchBytes: plan.patchBytes,
    })
  }
  const manifestPath = join(contextDirectory, "review-units.json")
  await writeFile(manifestPath, JSON.stringify({ units }, null, 2), { mode: 0o600 })
  return { manifestPath, units }
}

const writeCallDiff = async (
  root: string,
  mergeBase: string,
  changedPaths: ReadonlyArray<string>,
  contextDirectory: string,
  targetRef?: string,
): Promise<string> => {
  const outputPath = join(contextDirectory, "call-diff.json")
  try {
    const { runDiff } = await import("calldiff/dist/run.js")
    const result = runDiff({
      cwd: root,
      from: mergeBase,
      ...(targetRef === undefined ? {} : { to: targetRef }),
      paths: [...changedPaths],
      maxDepth: 8,
      color: false,
    })
    await writeFile(outputPath, JSON.stringify({ status: "available", result }, null, 2), { mode: 0o600 })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await writeFile(outputPath, JSON.stringify({ status: "unavailable", message }, null, 2), { mode: 0o600 })
  }
  return outputPath
}

const captureOnce = async (
  cwd: string,
  requestedBase: string | undefined,
  runId: string,
  targetRef: string | undefined,
): Promise<ReviewSnapshot | null> => {
  const root = resolve(await text(cwd, ["git", "rev-parse", "--show-toplevel"]))
  const branchValue = await text(root, ["git", "branch", "--show-current"])
  const checkoutHead = await text(root, ["git", "rev-parse", "HEAD"])
  const head = targetRef === undefined
    ? checkoutHead
    : await text(root, ["git", "rev-parse", `${targetRef}^{commit}`])
  const branch = branchValue || `detached-${checkoutHead.slice(0, 12)}`
  const baseRef = requestedBase ?? (await resolveDefaultBase(root))
  const baseTip = await text(root, ["git", "rev-parse", `${baseRef}^{commit}`])
  const mergeBase = await text(root, ["git", "merge-base", baseTip, head])
  const remote = await text(root, ["git", "remote", "get-url", "origin"], true)
  const repositoryIdentity = `${remote || root}\0${root}`
  const repositoryId = hash(repositoryIdentity).slice(0, 16)
  const streamDirectory = join(
    await realpath("/tmp"),
    "agentic-review",
    `${slug(basename(root))}-${repositoryId}`,
    `${slug(branch)}-${hash(branch).slice(0, 12)}`,
  )
  const runDirectory = join(streamDirectory, "runs", runId)
  const directory = join(runDirectory, "worktree")
  await mkdir(directory, { recursive: true, mode: 0o700 })

  const beforePaths = targetRef === undefined ? await sourcePaths(root) : []
  const revisionSource = targetRef === undefined ? null : await copyRevisionSource(root, head, directory)
  const effectiveTreeId = revisionSource === null
    ? await copySource(root, directory, beforePaths)
    : revisionSource.effectiveTreeId
  const snapshotPaths = revisionSource?.paths ?? beforePaths
  const afterPaths = targetRef === undefined ? await sourcePaths(root) : snapshotPaths
  const afterTreeId = targetRef === undefined ? await digestSource(root, afterPaths) : effectiveTreeId
  if (
    targetRef === undefined &&
    (beforePaths.join("\0") !== afterPaths.join("\0") || effectiveTreeId !== afterTreeId)
  ) {
    await rm(runDirectory, { recursive: true, force: true })
    return null
  }

  const targetCommit = targetRef === undefined ? undefined : head
  const { patch, files, changedPaths, skippedPaths } = await buildPatch(root, mergeBase, targetCommit)
  const contextDirectory = join(runDirectory, "context")
  await mkdir(contextDirectory, { recursive: true, mode: 0o700 })
  const patchPath = join(contextDirectory, "changes.patch")
  await writeFile(patchPath, patch, { mode: 0o600 })
  const callDiffPath = await writeCallDiff(root, mergeBase, changedPaths, contextDirectory, targetCommit)
  const reviewUnits = await writeReviewUnits(contextDirectory, files)
  const repositoryGuidanceManifestPath = await copyRepositoryGuidance(root, baseTip, contextDirectory)
  await writeFile(
    join(contextDirectory, "review-context.json"),
    JSON.stringify(
      {
        repositoryRoot: root,
        branch,
        baseRef,
        baseTip,
        mergeBase,
        head,
        effectiveTreeId,
        changedPaths,
        skippedPaths,
        callDiffPath,
        reviewUnits: reviewUnits.units,
        reviewUnitManifestPath: reviewUnits.manifestPath,
        repositoryControlFiles: snapshotPaths.filter(isRepositoryControl),
        repositoryGuidanceManifestPath,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )

  const finalPaths = targetRef === undefined ? await sourcePaths(root) : snapshotPaths
  const finalTreeId = targetRef === undefined
    ? await digestSource(root, finalPaths)
    : await text(root, ["git", "rev-parse", `${targetRef}^{tree}`])
  const finalHead = await text(root, ["git", "rev-parse", "HEAD"])
  const finalTarget = targetRef === undefined
    ? finalHead
    : await text(root, ["git", "rev-parse", `${targetRef}^{commit}`])
  const finalBranchValue = await text(root, ["git", "branch", "--show-current"])
  const finalBranch = finalBranchValue || `detached-${finalHead.slice(0, 12)}`
  const finalBaseTip = await text(root, ["git", "rev-parse", `${baseRef}^{commit}`])
  if (
    afterPaths.join("\0") !== finalPaths.join("\0") ||
    effectiveTreeId !== finalTreeId ||
    checkoutHead !== finalHead ||
    head !== finalTarget ||
    branch !== finalBranch ||
    baseTip !== finalBaseTip
  ) {
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
    callDiffPath,
    reviewUnitManifestPath: reviewUnits.manifestPath,
    reviewUnits: reviewUnits.units,
    repositoryGuidanceManifestPath,
    changedPaths,
    skippedPaths,
    historyPath: join(streamDirectory, "review.jsonl"),
    runDirectory,
  }
}

/** Capture a stable, inert copy of an effective worktree or committed target revision. */
export function captureReviewSnapshot(
  cwd: string,
  baseRef: string | undefined,
  runId: string,
  targetRef?: string,
): Effect.Effect<ReviewSnapshot, GitReviewError | UnstableSnapshotError> {
  return Effect.tryPromise({
    try: async () => {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const snapshot = await captureOnce(cwd, baseRef, runId, targetRef)
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

/** Remove source and context retained only for the lifetime of one review run. */
export function removeReviewSnapshot(snapshot: ReviewSnapshot): Effect.Effect<void, GitReviewError> {
  return Effect.tryPromise({
    try: () => rm(snapshot.runDirectory, { recursive: true, force: true }),
    catch: (cause) =>
      new GitReviewError({
        operation: "remove review snapshot",
        message: String(cause),
        details: snapshot.runDirectory,
      }),
  })
}

/** Check whether one reviewed commit remains an ancestor of the current commit. */
export function isAncestor(root: string, ancestor: string, descendant: string): Effect.Effect<boolean, GitReviewError> {
  return Effect.tryPromise({
    try: async () =>
      (await run(root, ["git", "merge-base", "--is-ancestor", ancestor, descendant], true)).exitCode === 0,
    catch: (cause) =>
      cause instanceof GitReviewError
        ? cause
        : new GitReviewError({
            operation: "check review ancestry",
            message: String(cause),
            details: root,
          }),
  })
}
