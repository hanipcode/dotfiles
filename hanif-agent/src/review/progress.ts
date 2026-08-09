import { basename, relative, sep } from "node:path"
import { Effect } from "effect"
import type { ReviewProgressEvent, ReviewProgressReporter } from "./domain.ts"
import { reviewText } from "./presentation.ts"

const activityIntervalMs = 1_500

const safeRole = (role: string): string => reviewText(role, true).slice(0, 80)

/** Format one safe review progress event for terminal stderr. */
export function reviewProgressLine(event: ReviewProgressEvent): string {
  switch (event.type) {
    case "snapshot_started":
      return "[review] capturing immutable snapshot"
    case "snapshot_ready":
      return `[review] ${event.changedPathCount} changed paths grouped into ${event.unitCount} Luna ${event.unitCount === 1 ? "unit" : "units"}`
    case "cache_hit":
      return "[review] reused unchanged completed review"
    case "stage_started":
      return `[${safeRole(event.role)}] started`
    case "stage_activity":
      return `[${safeRole(event.role)}] ${reviewText(event.detail, true).slice(0, 160)}`
    case "stage_finished":
      return `[${safeRole(event.role)}] ${event.status}, ${event.findingCount} ${event.findingCount === 1 ? "finding" : "findings"}`
    case "review_finished":
      return `[review] ${event.complete ? "complete" : "incomplete"}`
  }
}

/** Build an append-only reporter that throttles repeated tool activity per reviewer. */
export function makeCompactProgressReporter(
  write: (line: string) => void,
  now: () => number = Date.now,
): ReviewProgressReporter {
  const lastActivity = new Map<string, { readonly at: number; readonly detail: string }>()
  return (event) => Effect.sync(() => {
    if (event.type === "stage_activity") {
      const current = now()
      const previous = lastActivity.get(event.role)
      if (previous?.detail === event.detail || (previous !== undefined && current - previous.at < activityIntervalMs)) return
      lastActivity.set(event.role, { at: current, detail: event.detail })
    }
    write(reviewProgressLine(event))
  })
}

const inputString = (input: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = input[key]
  return typeof value === "string" ? value : null
}

const safeTarget = (path: string, runtimeDirectory: string): string => {
  const withinRuntime = relative(runtimeDirectory, path)
  if (withinRuntime === "" || withinRuntime.startsWith(`..${sep}`) || withinRuntime === "..") {
    return basename(path) || "review context"
  }
  const normalized = withinRuntime.split(sep).join("/")
  if (normalized.startsWith("worktree/")) return normalized.slice("worktree/".length)
  if (normalized.startsWith("context/review-units/")) return "assigned unit patch"
  if (normalized === "context/changes.patch") return "complete review patch"
  if (normalized === "context" || normalized.startsWith("context/")) return "review context"
  return normalized
}

/** Convert an allowlisted OpenCode tool invocation into a bounded, non-sensitive activity description. */
export function reviewerToolActivity(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  runtimeDirectory: string,
): string | null {
  const lower = tool.toLowerCase()
  if (lower === "webfetch" || lower === "websearch") return "checking external documentation"
  if (lower.includes("linear") || lower.includes("atlassian") || lower.includes("jira")) {
    return "checking goal ticket"
  }
  const path = inputString(input, "filePath") ?? inputString(input, "path")
  if (lower === "read" && path !== null) return `reading ${safeTarget(path, runtimeDirectory)}`
  if (lower === "grep" && path !== null) return `searching ${safeTarget(path, runtimeDirectory)}`
  if ((lower === "glob" || lower === "list") && path !== null) return `mapping ${safeTarget(path, runtimeDirectory)}`
  return null
}
