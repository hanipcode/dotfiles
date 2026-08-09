import type { CommandRecord, ProcessMetrics, RepoState, SourceRef } from "../domain.ts"

export interface ProblemView {
  readonly code: string
  readonly message: string
  readonly path: string | null
}

export interface RepositorySummary {
  readonly repoId: string
  readonly name: string
  readonly key: string
  readonly repositoryRoot: string
  readonly storage: "current" | "legacy"
  readonly runnerPath: string
  readonly environmentSourceRoot: string | null
  readonly activeSource: SourceRef | null
  readonly daemon: "online" | "offline" | "unreachable" | "upgrade-required"
  readonly commandCount: number
  readonly activeCommandCount: number
  readonly stateRevision: string
  readonly problem: ProblemView | null
}

export interface WorktreeView {
  readonly path: string
  readonly branch: string | null
  readonly head: string
  readonly locked: string | null
  readonly prunable: string | null
  readonly isActiveSource: boolean
  readonly isEnvironmentSource: boolean
}

export interface ScriptView {
  readonly name: string
  readonly command: string
  readonly prepared: boolean
  readonly tracked: CommandRecord | null
}

export interface PackageView {
  readonly path: string
  readonly name: string | null
  readonly manager: "bun" | "pnpm" | "yarn" | "npm"
  readonly scripts: ReadonlyArray<ScriptView>
}

export interface PreparationHealth {
  readonly setup: "ready" | "pending" | "failed" | "unknown"
  readonly preparedCommandCount: number
  readonly activeInstructionCount: number
  readonly lastPhase: string | null
  readonly lastAt: number | null
  readonly problem: ProblemView | null
}

export interface RepositoryDetail {
  readonly state: RepoState
  readonly worktrees: ReadonlyArray<WorktreeView>
  readonly selectedWorktreePath: string | null
  readonly packages: ReadonlyArray<PackageView>
  readonly selectedCommand: CommandRecord | null
  readonly selectedLog: string
  readonly selectedMetrics: ProcessMetrics | null
  readonly preparation: PreparationHealth
  readonly problems: ReadonlyArray<ProblemView>
}

export interface GlobalView {
  readonly generatedAt: number
  readonly repositories: ReadonlyArray<RepositorySummary>
  readonly selected: RepositoryDetail | null
}

export interface InspectionQuery {
  readonly repositoryId?: string
  readonly worktreePath?: string
  readonly commandId?: string
}

export type OperatorIntent =
  | {
      readonly type: "run"
      readonly repoId: string
      readonly worktreePath: string
      readonly expectedHead: string
      readonly packagePath: string
      readonly script: string
      readonly args: ReadonlyArray<string>
      readonly watch?: boolean
    }
  | {
      readonly type: "switch"
      readonly repoId: string
      readonly worktreePath: string
      readonly expectedHead: string
      readonly packagePath: string
    }
  | {
      readonly type: "stop" | "restart"
      readonly repoId: string
      readonly commandId: string
    }

export interface ActionPlan {
  readonly id: string
  readonly stateRevision: string
  readonly intent: OperatorIntent
  readonly title: string
  readonly effects: ReadonlyArray<string>
  readonly requiresConfirmation: boolean
  readonly dirtySummary: string | null
  readonly dirtyFingerprint: string | null
}

export interface CommitRequest {
  readonly plan: ActionPlan
  readonly mode: "manual" | "luna"
  readonly message?: string
}

export interface ActionReceipt {
  readonly message: string
  readonly view: GlobalView
}
