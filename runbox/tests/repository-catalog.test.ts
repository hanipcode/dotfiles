import { describe, expect, it } from "vitest"
import { CommandRecord, isRepositoryPreparation } from "../src/domain.ts"
import { parseWorktreeList } from "../src/services/RepositoryCatalog.ts"

describe("RepositoryCatalog", () => {
  it("parses worktree provenance and administrative states", () => {
    const values = parseWorktreeList([
      "worktree /repos/main",
      "HEAD 1234567890abcdef",
      "branch refs/heads/main",
      "",
      "worktree /repos/feature",
      "HEAD abcdef1234567890",
      "branch refs/heads/feature/test",
      "locked owned by another tool",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n"))
    expect(values).toEqual([
      {
        path: "/repos/main",
        head: "1234567890abcdef",
        branch: "main",
        locked: null,
        prunable: null,
      },
      {
        path: "/repos/feature",
        head: "abcdef1234567890",
        branch: "feature/test",
        locked: "owned by another tool",
        prunable: "gitdir file points to non-existent location",
      },
    ])
  })

  it("identifies repository preparation separately from command preparation", () => {
    const preparing = CommandRecord.make({
      id: ".:dev",
      packagePath: "",
      script: "dev",
      args: [],
      status: "preparing",
      pid: null,
      startedAt: null,
      exitCode: null,
      message: "preparing repository with Luna",
      logFile: "/logs/dev.log",
      processToken: "token",
    })
    expect(isRepositoryPreparation(preparing)).toBe(true)
    expect(isRepositoryPreparation(CommandRecord.make({ ...preparing, message: "preparing command" }))).toBe(false)
  })
})
