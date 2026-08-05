import { describe, expect, it } from "@effect/vitest"
import { aggregateMetrics, parseElapsed } from "../src/services/Metrics.ts"

describe("process metrics", () => {
  it("parses macOS ps elapsed times", () => {
    expect(parseElapsed("01:02")).toBe(62)
    expect(parseElapsed("02:03:04")).toBe(7_384)
    expect(parseElapsed("1-02:03:04")).toBe(93_784)
  })

  it("aggregates the complete descendant process tree", () => {
    const result = aggregateMetrics(10, [
      { pid: 10, parentPid: 1, cpu: 1.5, rssKb: 100, uptimeSeconds: 20 },
      { pid: 11, parentPid: 10, cpu: 2.5, rssKb: 200, uptimeSeconds: 10 },
      { pid: 12, parentPid: 11, cpu: 3, rssKb: 300, uptimeSeconds: 5 },
      { pid: 20, parentPid: 1, cpu: 99, rssKb: 999, uptimeSeconds: 50 },
    ])

    expect(result).toEqual({
      pid: 10,
      processCount: 3,
      cpuPercent: 7,
      memoryBytes: 600 * 1024,
      uptimeSeconds: 20,
    })
  })
})
