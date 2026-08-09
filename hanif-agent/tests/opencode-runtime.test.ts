import { describe, expect, it } from "vitest"
import { normalizeReviewerExecutionError, toolAccess } from "../src/review/opencode-runtime.ts"

describe("reviewer tool access", () => {
  it("allows source and web tools while denying unrelated tools", () => {
    expect(toolAccess([
      "read",
      "glob",
      "grep",
      "list",
      "webfetch",
      "websearch",
      "chrome-devtools_new_page",
      "bash",
    ], null, false)).toEqual({
      read: true,
      glob: true,
      grep: true,
      list: true,
      webfetch: true,
      websearch: true,
      "chrome-devtools_new_page": false,
      bash: false,
    })
  })

  it("keeps tracker access conditional on the goal reviewer", () => {
    expect(toolAccess(["linear_get_issue", "linear_list_comments"], null, true)).toEqual({
      linear_get_issue: false,
      linear_list_comments: false,
    })
    expect(toolAccess(["linear_get_issue", "linear_list_comments"], { key: "FUN-216", tracker: "linear" }, true)).toEqual({
      linear_get_issue: true,
      linear_list_comments: true,
    })
  })

  it("normalizes provider errors with missing schema fields", () => {
    const error = normalizeReviewerExecutionError(
      "security",
      "run reviewer session",
      "session-1",
      { name: "BadRequest" },
    )
    expect(error).toMatchObject({
      _tag: "ReviewerExecutionError",
      role: "security",
      operation: "run reviewer session",
      message: "[object Object]",
      retryable: true,
      sessionId: "session-1",
    })
  })
})
