import type { GhStack, GhStackCatalog } from "@heherdr/framework/gh-stack/Client.ts"
import type { WorktreeInfo, WorktreeList } from "@heherdr/framework/herdr/Client.ts"

export interface StackBranchRow {
  readonly branch: string
  readonly isTrunk: boolean
  readonly isCurrent: boolean
  readonly isMerged: boolean
  readonly pullRequestNumber: number | null
  readonly worktree: WorktreeInfo | null
  readonly localBranchExists: boolean
  readonly canCreateWorktree: boolean
}

export interface StackOption {
  readonly key: string
  readonly label: string
  readonly rows: ReadonlyArray<StackBranchRow>
}

export interface StackNavigatorData {
  readonly repoRoot: string
  readonly repoName: string
  readonly currentWorktreePath: string
  readonly currentBranch: string
  readonly stacks: ReadonlyArray<StackOption>
}

export const stackTipRow = (stack: StackOption): StackBranchRow | undefined =>
  stack.rows.find((row) => !row.isTrunk && !row.isMerged) ??
  stack.rows.find((row) => row.isTrunk)

const stackKey = (stack: GhStack): string =>
  stack.id ?? JSON.stringify([stack.trunk, stack.branches.map((branch) => branch.branch)])

const stackLabel = (stack: GhStack): string => {
  const name = stack.number === null ? "stack" : `stack #${stack.number}`
  const top = stack.branches.at(-1)?.branch ?? stack.trunk
  return `${name}  ${stack.trunk} → ${top}`
}

const rowFor = (
  input: {
    readonly branch: string
    readonly isTrunk: boolean
    readonly isMerged: boolean
    readonly pullRequestNumber: number | null
  },
  catalog: GhStackCatalog,
  worktreeByBranch: ReadonlyMap<string, WorktreeInfo>,
): StackBranchRow => {
  const worktree = worktreeByBranch.get(input.branch) ?? null
  const localBranchExists = catalog.localBranches.has(input.branch)
  return {
    ...input,
    isCurrent: input.branch === catalog.currentBranch,
    worktree,
    localBranchExists,
    canCreateWorktree: worktree === null && localBranchExists && !input.isMerged,
  }
}

export const buildStackNavigatorData = (
  catalog: GhStackCatalog,
  worktrees: WorktreeList,
): StackNavigatorData => {
  const worktreeByBranch = new Map(
    worktrees.worktrees.flatMap((worktree) =>
      worktree.branch === null ? [] : [[worktree.branch, worktree] as const],
    ),
  )

  return {
    repoRoot: worktrees.source.repo_root,
    repoName: worktrees.source.repo_name,
    currentWorktreePath: worktrees.source.source_checkout_path,
    currentBranch: catalog.currentBranch,
    stacks: catalog.stacks.map((stack) => ({
      key: stackKey(stack),
      label: stackLabel(stack),
      rows: [
        ...stack.branches
          .map((branch) =>
            rowFor(
              {
                branch: branch.branch,
                isTrunk: false,
                isMerged: branch.pullRequest?.merged ?? false,
                pullRequestNumber: branch.pullRequest?.number ?? null,
              },
              catalog,
              worktreeByBranch,
            ),
          )
          .reverse(),
        rowFor(
          {
            branch: stack.trunk,
            isTrunk: true,
            isMerged: false,
            pullRequestNumber: null,
          },
          catalog,
          worktreeByBranch,
        ),
      ],
    })),
  }
}
