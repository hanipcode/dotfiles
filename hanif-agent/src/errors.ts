import { Schema } from "effect"

/** A Git operation could not produce a trustworthy review input. */
export class GitReviewError extends Schema.TaggedError<GitReviewError>()(
  "GitReviewError",
  {
    operation: Schema.String,
    message: Schema.String,
    details: Schema.NullOr(Schema.String),
  },
) {}

/** The source tree changed while its immutable review snapshot was being captured. */
export class UnstableSnapshotError extends Schema.TaggedError<UnstableSnapshotError>()(
  "UnstableSnapshotError",
  {
    root: Schema.String,
    attempts: Schema.Number,
  },
) {}

/** Review history could not be safely read or appended. */
export class ReviewHistoryError extends Schema.TaggedError<ReviewHistoryError>()(
  "ReviewHistoryError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

/** OpenCode or a model failed while executing a reviewer role. */
export class ReviewerExecutionError extends Schema.TaggedError<ReviewerExecutionError>()(
  "ReviewerExecutionError",
  {
    role: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
    sessionId: Schema.NullOr(Schema.String),
  },
) {}

/** A reviewer returned text that did not satisfy its structured contract. */
export class ReviewerOutputError extends Schema.TaggedError<ReviewerOutputError>()(
  "ReviewerOutputError",
  {
    role: Schema.String,
    message: Schema.String,
    output: Schema.String,
  },
) {}

/** The branch name does not identify one unambiguous goal ticket. */
export class GoalReferenceError extends Schema.TaggedError<GoalReferenceError>()(
  "GoalReferenceError",
  {
    branch: Schema.String,
    references: Schema.Array(Schema.String),
  },
) {}

/** macOS could not accept a completed review through `pbcopy`. */
export class ClipboardError extends Schema.TaggedError<ClipboardError>()(
  "ClipboardError",
  {
    message: Schema.String,
  },
) {}

/** Typed failures exposed by the adversarial review operation. */
export type ReviewError =
  | GitReviewError
  | UnstableSnapshotError
  | ReviewHistoryError
  | ReviewerExecutionError
  | ReviewerOutputError
  | GoalReferenceError

/** Render an expected failure at the CLI boundary without exposing credentials. */
export function reviewErrorMessage(error: unknown): string {
  if (error instanceof GitReviewError) return `${error.operation}: ${error.message}`
  if (error instanceof UnstableSnapshotError) {
    return `capture review snapshot: source tree changed during ${error.attempts} capture attempts`
  }
  if (error instanceof ReviewHistoryError) return `${error.operation}: ${error.message} (${error.path})`
  if (error instanceof ReviewerExecutionError) return `${error.role}: ${error.message}`
  if (error instanceof ReviewerOutputError) return `${error.role}: ${error.message}`
  if (error instanceof GoalReferenceError) {
    return `resolve goal ticket: branch '${error.branch}' contains ambiguous references: ${error.references.join(", ")}`
  }
  if (error instanceof ClipboardError) return `copy review to clipboard: ${error.message}`
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message)
  return String(error)
}
