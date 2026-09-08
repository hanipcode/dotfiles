import { describe, expect, it } from "vitest"
import { ReviewResult } from "../src/review/domain.ts"
import { reviewMarkdown } from "../src/review/presentation.ts"

describe("review presentation", () => {
  it("formats active findings as safe Markdown", () => {
    const markdown = reviewMarkdown(
      ReviewResult.make({
        runId: "run-1",
        repositoryRoot: "/repo",
        branch: "feature/test",
        baseRef: "main",
        baseTip: "base",
        mergeBase: "merge",
        head: "head",
        effectiveTreeId: "tree",
        promptVersion: "1",
        standardsDigest: "standards",
        models: {
          reviewer: "openai/gpt-5.6-luna#high",
          coordinator: "openai/gpt-5.6-sol#high",
        },
        mode: "full",
        complete: true,
        costUsd: 0.123456,
        cachedInputPercent: 78.24,
        summary: "One issue\u001b]52;c;bad\u0007",
        findings: [
          {
            id: "finding-1",
            status: "new",
            category: "quality",
            severity: "warning",
            title: "Incorrect fallback",
            impact: "Requests fail.",
            evidence: "The fallback returns null.",
            rule: null,
            location: { path: "src/app.ts", line: 12, symbol: "load" },
            sources: ["quality"],
          },
        ],
        historyPath: "/tmp/review.jsonl",
      }),
    )

    expect(markdown).toContain("# Adversarial Review")
    expect(markdown).toContain("## WARNING: Incorrect fallback")
    expect(markdown).toContain("Location: `src/app.ts:12`")
    expect(markdown).toContain("**Cost:** $0.1235")
    expect(markdown).toContain("**Cached input:** 78.2%")
    expect(markdown).not.toContain("\u001b")
    expect(markdown).not.toContain("\u0007")
  })

  it("formats unavailable cache usage", () => {
    const result = ReviewResult.make({
      runId: "run-2",
      repositoryRoot: "/repo",
      branch: "feature/test",
      baseRef: "main",
      baseTip: "base",
      mergeBase: "merge",
      head: "head",
      effectiveTreeId: "tree",
      promptVersion: "1",
      standardsDigest: "standards",
      models: { reviewer: "reviewer", coordinator: "coordinator" },
      mode: "cache_hit",
      complete: true,
      summary: "Cached result",
      findings: [],
      historyPath: "/tmp/review.jsonl",
    })

    expect(reviewMarkdown(result)).toContain("**Cached input:** n/a")
  })
})
