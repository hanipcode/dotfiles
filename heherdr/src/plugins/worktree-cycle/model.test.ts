import { describe, expect, test } from "bun:test"
import { cycleWorkspaceId } from "./model.ts"

const openWorkspaceIds = new Set(["main", "one", "two"])
const sessionWorkspaceIds = ["unrelated", "one", "main", "two", "other"]

describe("cycleWorkspaceId", () => {
  test("cycles forward within the current worktree group", () => {
    expect(cycleWorkspaceId("main", "main", openWorkspaceIds, sessionWorkspaceIds, "next")).toBe(
      "one",
    )
    expect(cycleWorkspaceId("two", "main", openWorkspaceIds, sessionWorkspaceIds, "next")).toBe(
      "main",
    )
  })

  test("cycles backward within the current worktree group", () => {
    expect(
      cycleWorkspaceId("main", "main", openWorkspaceIds, sessionWorkspaceIds, "previous"),
    ).toBe("two")
    expect(
      cycleWorkspaceId("one", "main", openWorkspaceIds, sessionWorkspaceIds, "previous"),
    ).toBe("main")
  })

  test("does nothing without another open group member", () => {
    expect(
      cycleWorkspaceId("main", "main", new Set(["main"]), sessionWorkspaceIds, "next"),
    ).toBeUndefined()
  })
})
