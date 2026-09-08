import { Schema } from "effect"
import { ReviewerExecutionError, ReviewerOutputError, reviewErrorMessage } from "../errors.ts"
import { reviewText } from "./presentation.ts"

/** Persisted diagnostics deliberately omit raw output, prompts, stacks, and causes. */
export const ReviewDiagnostic = Schema.Struct({
  kind: Schema.String,
  message: Schema.String,
  operation: Schema.String,
  retryable: Schema.Boolean,
  sessionId: Schema.NullOr(Schema.String),
})
export type ReviewDiagnostic = typeof ReviewDiagnostic.Type

/** Redact common credential representations before any diagnostic leaves the adapter. */
export function redactReviewText(value: string): string {
  return reviewText(value)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/\b([\w-]*(?:secret|token|password|api[_-]?key|authorization)[\w-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
}

/** Project expected errors onto bounded, allowlisted diagnostics at output boundaries. */
export function reviewDiagnostic(error: unknown): ReviewDiagnostic {
  if (Schema.is(ReviewerExecutionError)(error)) {
    return ReviewDiagnostic.make({
      kind: error.kind,
      operation: redactReviewText(error.operation).slice(0, 160),
      message: redactReviewText(error.message).slice(0, 2_000),
      retryable: error.retryable,
      sessionId: error.sessionId === null ? null : redactReviewText(error.sessionId).slice(0, 160),
    })
  }
  if (Schema.is(ReviewerOutputError)(error)) {
    return ReviewDiagnostic.make({ kind: "output", operation: "validate reviewer output",
      message: redactReviewText(error.message).slice(0, 2_000), retryable: true, sessionId: null })
  }
  return ReviewDiagnostic.make({ kind: "execution", operation: "run review",
    message: redactReviewText(reviewErrorMessage(error)).slice(0, 2_000), retryable: false, sessionId: null })
}
