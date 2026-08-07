import { Schema } from "effect"

/** Model identifiers used by the initial reviewer and final adjudicator tiers. */
export const ReviewModels = Schema.Struct({
  reviewer: Schema.String,
  coordinator: Schema.String,
})
export interface ReviewModels extends Schema.Schema.Type<typeof ReviewModels> {}

/** A branch-derived issue reference and its required tracker. */
export const GoalReference = Schema.Struct({
  key: Schema.String,
  tracker: Schema.Literal("linear", "atlassian"),
})
export interface GoalReference extends Schema.Schema.Type<typeof GoalReference> {}

/** One source location supporting a review finding. */
export const FindingLocation = Schema.Struct({
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  symbol: Schema.NullOr(Schema.String),
})
export interface FindingLocation extends Schema.Schema.Type<typeof FindingLocation> {}

/** A specialist finding before Sol adjudicates it. */
export const RawFinding = Schema.Struct({
  category: Schema.Literal("security", "standards", "quality", "goals"),
  severity: Schema.Literal("critical", "warning", "suggestion"),
  title: Schema.String,
  impact: Schema.String,
  evidence: Schema.String,
  rule: Schema.NullOr(Schema.String),
  location: Schema.NullOr(FindingLocation),
})
export interface RawFinding extends Schema.Schema.Type<typeof RawFinding> {}

/** Structured result required from each Luna reviewer. */
export const SpecialistOutput = Schema.Struct({
  summary: Schema.String,
  findings: Schema.Array(RawFinding),
})
export interface SpecialistOutput extends Schema.Schema.Type<typeof SpecialistOutput> {}

/** A finding after Sol has validated, merged, and classified its lifecycle. */
export const CanonicalFinding = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  status: Schema.Literal("new", "open", "resolved", "superseded", "suppressed"),
  category: Schema.Literal("security", "standards", "quality", "goals"),
  severity: Schema.Literal("critical", "warning", "suggestion"),
  title: Schema.String,
  impact: Schema.String,
  evidence: Schema.String,
  rule: Schema.NullOr(Schema.String),
  location: Schema.NullOr(FindingLocation),
  sources: Schema.Array(Schema.String),
})
export interface CanonicalFinding extends Schema.Schema.Type<typeof CanonicalFinding> {}

/** Structured result required from each Sol stage. */
export const CoordinatorOutput = Schema.Struct({
  summary: Schema.String,
  findings: Schema.Array(CanonicalFinding),
})
export interface CoordinatorOutput extends Schema.Schema.Type<typeof CoordinatorOutput> {}

/** Immutable Git and filesystem input reviewed by every model session. */
export interface ReviewSnapshot {
  readonly repositoryRoot: string
  readonly repositoryId: string
  readonly branch: string
  readonly baseRef: string
  readonly baseTip: string
  readonly mergeBase: string
  readonly head: string
  readonly effectiveTreeId: string
  readonly runtimeDirectory: string
  readonly snapshotDirectory: string
  readonly patchPath: string
  readonly changedPaths: ReadonlyArray<string>
  readonly skippedPaths: ReadonlyArray<string>
  readonly historyPath: string
  readonly runDirectory: string
}

/** Prior completed result supplied to incremental reviewers. */
export const PriorReview = Schema.Struct({
  runId: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
  baseTip: Schema.String,
  mergeBase: Schema.String,
  head: Schema.String,
  effectiveTreeId: Schema.String,
  snapshotDirectory: Schema.String,
  promptVersion: Schema.String,
  standardsDigest: Schema.String,
  models: ReviewModels,
  summary: Schema.String,
  findings: Schema.Array(CanonicalFinding),
})
export interface PriorReview extends Schema.Schema.Type<typeof PriorReview> {}

/** Final persisted and rendered review result. */
export const ReviewResult = Schema.Struct({
  runId: Schema.String,
  repositoryRoot: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
  baseTip: Schema.String,
  mergeBase: Schema.String,
  head: Schema.String,
  effectiveTreeId: Schema.String,
  snapshotDirectory: Schema.String,
  promptVersion: Schema.String,
  standardsDigest: Schema.String,
  models: ReviewModels,
  mode: Schema.Literal("full", "incremental", "cache_hit"),
  complete: Schema.Boolean,
  summary: Schema.String,
  findings: Schema.Array(CanonicalFinding),
  historyPath: Schema.String,
})
export interface ReviewResult extends Schema.Schema.Type<typeof ReviewResult> {}

/** Input accepted by the adversarial review operation. */
export interface ReviewRequest {
  readonly cwd: string
  readonly baseRef?: string
  readonly models: ReviewModels
}

/** One isolated application-level model role. */
export interface ReviewerTask {
  readonly role: string
  readonly model: string
  readonly system: string
  readonly prompt: string
  readonly allowTracker: boolean
}

/** Raw successful response from one OpenCode session. */
export interface ReviewerResponse {
  readonly role: string
  readonly sessionId: string
  readonly text: string
}
