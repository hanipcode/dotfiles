import { describe, expect, it } from "bun:test"
import type { GhStackCatalog } from "@heherdr/framework/gh-stack/Client.ts"
import type { WorktreeList } from "@heherdr/framework/herdr/Client.ts"
import { buildStackNavigatorData, stackTipRow } from "./model.ts"

const catalog: GhStackCatalog = {
  currentBranch: "api",
  localBranches: new Set(["main", "auth", "api", "merged"]),
  stacks: [
    {
      id: "stack",
      number: 7,
      trunk: "main",
      branches: [
        { branch: "auth", pullRequest: null },
        { branch: "api", pullRequest: { number: 2, url: null, merged: false } },
        { branch: "merged", pullRequest: { number: 3, url: null, merged: true } },
      ],
    },
  ],
}

const worktrees: WorktreeList = {
  source: {
    repo_key: "repo",
    repo_name: "example",
    repo_root: "/repo",
    source_checkout_path: "/repo",
    source_workspace_id: "ws-main",
  },
  worktrees: [
    {
      branch: "main",
      path: "/repo",
      label: "example",
      is_bare: false,
      is_detached: false,
      is_linked_worktree: false,
      is_prunable: false,
      open_workspace_id: "ws-main",
    },
    {
      branch: "api",
      path: "/worktrees/api",
      label: "example",
      is_bare: false,
      is_detached: false,
      is_linked_worktree: true,
      is_prunable: false,
    },
  ],
}

describe("stack navigator model", () => {
  it("orders the stack top-first with trunk last and correlates worktrees", () => {
    const data = buildStackNavigatorData(catalog, worktrees)

    expect(data.stacks[0]?.label).toBe("stack #7  main → merged")
    expect(data.currentWorktreePath).toBe("/repo")
    expect(data.stacks[0]?.rows.map((row) => row.branch)).toEqual([
      "merged",
      "api",
      "auth",
      "main",
    ])
    expect(data.stacks[0]?.rows.find((row) => row.branch === "api")).toMatchObject({
      isCurrent: true,
      worktree: { path: "/worktrees/api" },
    })
  })

  it("only offers creation for active local branches without worktrees", () => {
    const rows = buildStackNavigatorData(catalog, worktrees).stacks[0]?.rows ?? []

    expect(rows.find((row) => row.branch === "auth")?.canCreateWorktree).toBe(true)
    expect(rows.find((row) => row.branch === "merged")?.canCreateWorktree).toBe(false)
    expect(rows.find((row) => row.branch === "api")?.canCreateWorktree).toBe(false)
  })

  it("selects the highest unmerged branch as the stack tip", () => {
    const stack = buildStackNavigatorData(catalog, worktrees).stacks[0]

    expect(stack === undefined ? undefined : stackTipRow(stack)?.branch).toBe("api")
  })
})
