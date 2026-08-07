import { Context, Data, Effect, Either, Layer, Schema } from "effect"

export class GhStackError extends Data.TaggedError("GhStackError")<{
  readonly code:
    | "git_failed"
    | "gh_stack_failed"
    | "invalid_state"
    | "not_in_stack"
    | "ambiguous_stack"
  readonly reason: string
}> {}

const PullRequestSchema = Schema.Struct({
  number: Schema.Number,
  url: Schema.optional(Schema.String),
  merged: Schema.optional(Schema.Boolean),
})

const BranchSchema = Schema.Struct({
  branch: Schema.String,
  head: Schema.optional(Schema.String),
  base: Schema.optional(Schema.String),
  pullRequest: Schema.optional(PullRequestSchema),
})

const StackSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  number: Schema.optional(Schema.Number),
  trunk: BranchSchema,
  branches: Schema.Array(BranchSchema),
})

const StackFileSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  stacks: Schema.Array(StackSchema),
})

type StackFile = Schema.Schema.Type<typeof StackFileSchema>

export interface GhStackPullRequest {
  readonly number: number
  readonly url: string | null
  readonly merged: boolean
}

export interface GhStackBranch {
  readonly branch: string
  readonly pullRequest: GhStackPullRequest | null
}

export interface GhStack {
  readonly id: string | null
  readonly number: number | null
  readonly trunk: string
  readonly branches: ReadonlyArray<GhStackBranch>
}

export interface GhStackCatalog {
  readonly currentBranch: string
  /** One stack for a stacked branch; possibly several when currentBranch is a shared trunk. */
  readonly stacks: ReadonlyArray<GhStack>
  readonly localBranches: ReadonlySet<string>
}

export interface GhStackClient {
  readonly load: (input: {
    readonly projectDir: string
    readonly repoRoot: string
    readonly checkoutPaths: ReadonlyArray<string>
  }) => Effect.Effect<GhStackCatalog, GhStackError>
  readonly checkoutBranch: (
    projectDir: string,
    branch: string,
  ) => Effect.Effect<void, GhStackError>
}

export const GhStackClient = Context.GenericTag<GhStackClient>("@heherdr/GhStackClient")

export const decodeStackFile = (input: unknown): StackFile =>
  Schema.decodeUnknownSync(StackFileSchema)(input)

const normalizeBranch = (branch: StackFile["stacks"][number]["branches"][number]): GhStackBranch => ({
  branch: branch.branch,
  pullRequest:
    branch.pullRequest === undefined
      ? null
      : {
          number: branch.pullRequest.number,
          url: branch.pullRequest.url ?? null,
          merged: branch.pullRequest.merged ?? false,
        },
})

export const normalizeStacks = (files: ReadonlyArray<StackFile>): ReadonlyArray<GhStack> => {
  const unique = new Map<string, GhStack>()

  for (const file of files) {
    for (const stack of file.stacks) {
      const normalized: GhStack = {
        id: stack.id ?? null,
        number: stack.number ?? null,
        trunk: stack.trunk.branch,
        branches: stack.branches.map(normalizeBranch),
      }
      const key =
        normalized.id === null || normalized.id === ""
          ? JSON.stringify([normalized.trunk, normalized.branches.map((branch) => branch.branch)])
          : `id:${normalized.id}`
      if (!unique.has(key)) unique.set(key, normalized)
    }
  }

  return [...unique.values()]
}

export const stacksForBranch = (
  stacks: ReadonlyArray<GhStack>,
  branch: string,
): ReadonlyArray<GhStack> =>
  stacks.filter(
    (stack) =>
      stack.trunk === branch ||
      stack.branches.some((candidate) => candidate.branch === branch),
  )

interface GitOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const git = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, GhStackError> =>
  Effect.flatMap(
    Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(["git", "-C", cwd, ...args], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return { stdout, stderr, exitCode } satisfies GitOutput
      },
      catch: (cause) =>
        new GhStackError({ code: "git_failed", reason: `failed to spawn git: ${String(cause)}` }),
    }),
    (result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim())
        : Effect.fail(
            new GhStackError({
              code: "git_failed",
              reason:
                result.stderr.trim() || result.stdout.trim() || `git exited ${result.exitCode}`,
            }),
          ),
  )

const checkoutBranch = (cwd: string, branch: string): Effect.Effect<void, GhStackError> =>
  Effect.flatMap(
    Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(["gh", "stack", "checkout", branch], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return { stdout, stderr, exitCode } satisfies GitOutput
      },
      catch: (cause) =>
        new GhStackError({
          code: "gh_stack_failed",
          reason: `failed to spawn gh stack: ${String(cause)}`,
        }),
    }),
    (result) =>
      result.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new GhStackError({
              code: "gh_stack_failed",
              reason:
                result.stderr.trim() || result.stdout.trim() || `gh stack exited ${result.exitCode}`,
            }),
          ),
  )

const readStackFile = (path: string): Effect.Effect<StackFile | null, GhStackError> =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(path)
      if (!(await file.exists())) return null
      return decodeStackFile(JSON.parse(await file.text()) as unknown)
    },
    catch: (cause) =>
      new GhStackError({
        code: "invalid_state",
        reason: `failed to read ${path}: ${String(cause)}`,
      }),
  })

const make = (): GhStackClient => ({
  load: ({ projectDir, repoRoot, checkoutPaths }) =>
    Effect.gen(function* () {
      const currentBranch = yield* git(projectDir, ["branch", "--show-current"])
      if (currentBranch === "") {
        return yield* new GhStackError({
          code: "not_in_stack",
          reason: "the current workspace has a detached HEAD",
        })
      }

      const localBranchOutput = yield* git(repoRoot, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
      ])
      const localBranches = new Set(localBranchOutput.split("\n").filter((branch) => branch !== ""))

      const gitDirs = new Set<string>()
      let firstGitError: GhStackError | null = null
      const repoCommonDir = yield* git(repoRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
      for (const checkout of new Set([projectDir, repoRoot, ...checkoutPaths])) {
        const common = yield* Effect.either(
          git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        )
        if (Either.isLeft(common)) {
          firstGitError ??= common.left
          continue
        }
        if (common.right !== repoCommonDir) continue

        const gitDir = yield* Effect.either(git(checkout, ["rev-parse", "--absolute-git-dir"]))
        if (Either.isRight(gitDir)) gitDirs.add(gitDir.right)
        else firstGitError ??= gitDir.left
      }

      if (gitDirs.size === 0) {
        return yield* (firstGitError ??
          new GhStackError({ code: "git_failed", reason: "no Git directory found" }))
      }

      const files: Array<StackFile> = []
      let firstStateError: GhStackError | null = null
      for (const gitDir of gitDirs) {
        const result = yield* Effect.either(readStackFile(`${gitDir}/gh-stack`))
        if (Either.isRight(result)) {
          if (result.right !== null) files.push(result.right)
        } else {
          firstStateError ??= result.left
        }
      }

      const stacks = normalizeStacks(files)
      if (stacks.length === 0 && firstStateError !== null) return yield* firstStateError

      const matches = stacksForBranch(stacks, currentBranch)
      if (matches.length === 0) {
        return yield* new GhStackError({
          code: "not_in_stack",
          reason: `branch ${JSON.stringify(currentBranch)} is not part of a local gh-stack`,
        })
      }
      if (
        matches.length > 1 &&
        matches.some((stack) => stack.branches.some((branch) => branch.branch === currentBranch))
      ) {
        return yield* new GhStackError({
          code: "ambiguous_stack",
          reason: `branch ${JSON.stringify(currentBranch)} belongs to multiple stacks`,
        })
      }

      return { currentBranch, stacks: matches, localBranches }
    }),
  checkoutBranch,
})

export const layer = Layer.sync(GhStackClient, make)
