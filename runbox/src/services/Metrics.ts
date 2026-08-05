import { Context, Effect, Layer } from "effect"
import type { ProcessMetrics } from "../domain.ts"
import { RunboxError } from "../errors.ts"
import { Shell } from "./Shell.ts"

interface ProcessRow {
  readonly pid: number
  readonly parentPid: number
  readonly cpu: number
  readonly rssKb: number
  readonly uptimeSeconds: number
}

export const parseElapsed = (value: string): number => {
  const dayParts = value.trim().split("-")
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0
  const clock = (dayParts.at(-1) ?? "0").split(":").map(Number)
  const seconds = clock.at(-1) ?? 0
  const minutes = clock.at(-2) ?? 0
  const hours = clock.length >= 3 ? (clock.at(-3) ?? 0) : 0
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

export const aggregateMetrics = (
  rootPid: number,
  rows: ReadonlyArray<ProcessRow>,
): ProcessMetrics | null => {
  const root = rows.find((row) => row.pid === rootPid)
  if (root === undefined) return null
  const selected = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!selected.has(row.pid) && selected.has(row.parentPid)) {
        selected.add(row.pid)
        changed = true
      }
    }
  }
  const tree = rows.filter((row) => selected.has(row.pid))
  return {
    pid: rootPid,
    processCount: tree.length,
    cpuPercent: tree.reduce((sum, row) => sum + row.cpu, 0),
    memoryBytes: tree.reduce((sum, row) => sum + row.rssKb, 0) * 1024,
    uptimeSeconds: root.uptimeSeconds,
  }
}

export class Metrics extends Context.Tag("@runbox/Metrics")<
  Metrics,
  {
    readonly forPids: (
      pids: ReadonlyArray<number>,
    ) => Effect.Effect<Readonly<Record<string, ProcessMetrics>>, RunboxError>
  }
>() {
  static readonly layer = Layer.effect(
    Metrics,
    Effect.gen(function* () {
      const shell = yield* Shell
      const forPids = Effect.fn("Metrics.forPids")(function* (pids: ReadonlyArray<number>) {
        if (pids.length === 0) return {}
        const result = yield* shell.run(["ps", "-axo", "pid=,ppid=,%cpu=,rss=,etime="], {
          cwd: "/",
        }).pipe(
          Effect.mapError((error) =>
            new RunboxError({ operation: "read process metrics", message: error.stderr }),
          ),
        )
        const rows = result.stdout
          .split("\n")
          .map((line): ProcessRow | null => {
            const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
            if (match === null) return null
            return {
              pid: Number(match[1]),
              parentPid: Number(match[2]),
              cpu: Number(match[3]),
              rssKb: Number(match[4]),
              uptimeSeconds: parseElapsed(match[5] ?? "0"),
            }
          })
          .filter((row): row is ProcessRow => row !== null)
        const output: Record<string, ProcessMetrics> = {}
        for (const pid of pids) {
          const metrics = aggregateMetrics(pid, rows)
          if (metrics !== null) output[String(pid)] = metrics
        }
        return output
      })
      return Metrics.of({ forPids })
    }),
  )
}
