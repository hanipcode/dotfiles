import { Schema } from "effect"
import { createHash } from "node:crypto"

export const CommandStatus = Schema.Literal(
  "preparing",
  "starting",
  "running",
  "stopping",
  "completed",
  "failed",
  "stale",
)
export type CommandStatus = typeof CommandStatus.Type

export const StackBranch = Schema.Struct({
  name: Schema.String,
  head: Schema.String,
  base: Schema.String,
  isMerged: Schema.Boolean,
  isQueued: Schema.Boolean,
  needsRebase: Schema.Boolean,
  worktreePath: Schema.NullOr(Schema.String),
})
export type StackBranch = typeof StackBranch.Type

export const StackProvenance = Schema.Struct({
  trunk: Schema.String,
  currentBranch: Schema.String,
  topBranch: Schema.String,
  fingerprint: Schema.String,
  branches: Schema.Array(StackBranch),
})
export type StackProvenance = typeof StackProvenance.Type

export const SourceRef = Schema.Struct({
  kind: Schema.Literal("worktree", "stack"),
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  commit: Schema.String,
  stack: Schema.NullOr(StackProvenance),
})
export type SourceRef = typeof SourceRef.Type

export const LegacySourceRef = Schema.Struct({
  worktreePath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  commit: Schema.String,
})

export const ProcessMetrics = Schema.Struct({
  pid: Schema.Number,
  processCount: Schema.Number,
  cpuPercent: Schema.Number,
  memoryBytes: Schema.Number,
  uptimeSeconds: Schema.Number,
})
export type ProcessMetrics = typeof ProcessMetrics.Type

export const CommandRecord = Schema.Struct({
  id: Schema.String,
  packagePath: Schema.String,
  script: Schema.String,
  args: Schema.Array(Schema.String),
  status: CommandStatus,
  pid: Schema.NullOr(Schema.Number),
  startedAt: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String),
  logFile: Schema.String,
  processToken: Schema.NullOr(Schema.String).pipe(
    Schema.optionalWith({ default: () => null }),
  ),
})
export type CommandRecord = typeof CommandRecord.Type

export const RepoState = Schema.Struct({
  version: Schema.Literal(2),
  repoId: Schema.String,
  repoRoot: Schema.String,
  commonDir: Schema.String,
  runnerPath: Schema.String,
  environmentSourceRoot: Schema.NullOr(Schema.String).pipe(
    Schema.optionalWith({ default: () => null }),
  ),
  source: Schema.NullOr(SourceRef),
  preparedCommits: Schema.Array(Schema.String),
  preparedCommands: Schema.Array(Schema.String).pipe(
    Schema.optionalWith({ default: () => [] }),
  ),
  commands: Schema.Record({ key: Schema.String, value: CommandRecord }),
})
export type RepoState = typeof RepoState.Type

export const stateRevision = (state: RepoState): string =>
  createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 16)

export const repositoryRoot = (state: RepoState): string =>
  state.environmentSourceRoot ?? state.repoRoot

export const LegacyRepoState = Schema.Struct({
  version: Schema.Literal(1),
  repoId: Schema.String,
  repoRoot: Schema.String,
  commonDir: Schema.String,
  runnerPath: Schema.String,
  source: Schema.NullOr(LegacySourceRef),
  preparedCommits: Schema.Array(Schema.String),
  commands: Schema.Record({ key: Schema.String, value: CommandRecord }),
})
export type LegacyRepoState = typeof LegacyRepoState.Type

export interface ProjectContext {
  readonly repoId: string
  readonly repoRoot: string
  readonly commonDir: string
  readonly packageDir: string
  readonly packagePath: string
  readonly packageJsonPath: string
  readonly branch: string | null
  readonly commit: string
}

export interface PackageInfo {
  readonly path: string
  readonly scripts: Readonly<Record<string, string>>
  readonly manager: "bun" | "pnpm" | "yarn" | "npm"
}

export const RepoSnapshot = Schema.Struct({
  state: RepoState,
  scripts: Schema.Array(Schema.String),
  packagePath: Schema.String,
  logs: Schema.Record({ key: Schema.String, value: Schema.String }),
  metrics: Schema.Record({ key: Schema.String, value: ProcessMetrics }),
})
export type RepoSnapshot = typeof RepoSnapshot.Type

export type DaemonRequest =
  | { readonly type: "ping" }
  | { readonly type: "status"; readonly packagePath: string }
  | {
      readonly type: "start"
      readonly packagePath: string
      readonly script: string
      readonly args: ReadonlyArray<string>
      readonly source: SourceRef
    }
  | { readonly type: "setup"; readonly packagePath: string; readonly source: SourceRef }
  | { readonly type: "stop"; readonly packagePath: string; readonly script: string | "all"; readonly expectedRevision?: string | undefined }
  | { readonly type: "restart"; readonly packagePath: string; readonly script: string; readonly expectedRevision?: string | undefined }
  | { readonly type: "configure"; readonly environmentSourceRoot: string }
  | { readonly type: "switch"; readonly source: SourceRef; readonly expectedRevision?: string | undefined }
  | {
      readonly type: "activate"
      readonly packagePath: string
      readonly script: string
      readonly args: ReadonlyArray<string>
      readonly source: SourceRef
      readonly expectedRevision?: string | undefined
    }
  | { readonly type: "shutdown" }

export const DaemonRequestSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal("ping") }),
  Schema.Struct({ type: Schema.Literal("status"), packagePath: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("start"),
    packagePath: Schema.String,
    script: Schema.String,
    args: Schema.Array(Schema.String),
    source: SourceRef,
  }),
  Schema.Struct({ type: Schema.Literal("setup"), packagePath: Schema.String, source: SourceRef }),
  Schema.Struct({ type: Schema.Literal("stop"), packagePath: Schema.String, script: Schema.String, expectedRevision: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("restart"), packagePath: Schema.String, script: Schema.String, expectedRevision: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("configure"), environmentSourceRoot: Schema.String }),
  Schema.Struct({ type: Schema.Literal("switch"), source: SourceRef, expectedRevision: Schema.optional(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("activate"),
    packagePath: Schema.String,
    script: Schema.String,
    args: Schema.Array(Schema.String),
    source: SourceRef,
    expectedRevision: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("shutdown") }),
)

const ErrorInfoSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  operation: Schema.String,
  suggestion: Schema.String,
  retryable: Schema.Boolean,
  details: Schema.NullOr(Schema.String),
})

export const DaemonResponseSchema = Schema.Union(
  Schema.Struct({
    ok: Schema.Literal(true),
    snapshot: Schema.optional(RepoSnapshot),
    message: Schema.optional(Schema.String),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: ErrorInfoSchema }),
)
export type DaemonResponse = typeof DaemonResponseSchema.Type

export const commandId = (packagePath: string, script: string): string =>
  `${packagePath === "" ? "." : packagePath}:${script}`

export const sameSource = (left: SourceRef, right: SourceRef): boolean =>
  left.kind === right.kind &&
  left.worktreePath === right.worktreePath &&
  left.branch === right.branch &&
  left.commit === right.commit &&
  left.stack?.fingerprint === right.stack?.fingerprint
