import { describe, expect, it } from "vitest"
import { makeCompactProgressReporter, reviewerToolActivity, reviewProgressLine } from "../src/review/progress.ts"
import { Effect } from "effect"

describe("review progress", () => {
  it("formats bounded terminal-safe milestones", () => {
    expect(reviewProgressLine({
      type: "stage_activity",
      role: "luna-1\u001b]52;c;bad\u0007",
      detail: "reading src/app.ts\nsecret",
    })).toBe("[luna-1] reading src/app.ts secret")
    expect(reviewProgressLine({
      type: "snapshot_ready",
      changedPathCount: 258,
      unitCount: 7,
    })).toBe("[review] 258 changed paths grouped into 7 Luna units")
  })

  it("throttles activity per reviewer without suppressing stage milestones", async () => {
    const lines: Array<string> = []
    let current = 0
    const report = makeCompactProgressReporter((line) => lines.push(line), () => current)

    await Effect.runPromise(report({ type: "stage_started", role: "luna-1" }))
    await Effect.runPromise(report({ type: "stage_activity", role: "luna-1", detail: "reading src/a.ts" }))
    current = 500
    await Effect.runPromise(report({ type: "stage_activity", role: "luna-1", detail: "reading src/b.ts" }))
    current = 2_000
    await Effect.runPromise(report({ type: "stage_activity", role: "luna-1", detail: "reading src/b.ts" }))
    await Effect.runPromise(report({
      type: "stage_finished",
      role: "luna-1",
      status: "succeeded",
      findingCount: 0,
    }))

    expect(lines).toEqual([
      "[luna-1] started",
      "[luna-1] reading src/a.ts",
      "[luna-1] reading src/b.ts",
      "[luna-1] succeeded, 0 findings",
    ])
  })

  it("turns allowlisted tools into safe activity without patterns, URLs, or temporary paths", () => {
    const runtime = "/tmp/agentic-review/repo/run"
    expect(reviewerToolActivity("read", {
      filePath: `${runtime}/worktree/packages/core/src/core.ts`,
    }, runtime)).toBe("reading packages/core/src/core.ts")
    expect(reviewerToolActivity("grep", {
      path: `${runtime}/context`,
      pattern: "API_TOKEN=secret",
    }, runtime)).toBe("searching review context")
    expect(reviewerToolActivity("webfetch", {
      url: "https://example.test/private?q=secret",
    }, runtime)).toBe("checking external documentation")
  })
})
