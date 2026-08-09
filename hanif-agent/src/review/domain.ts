import { Effect, Schema } from "effect"

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

/** Finding categories that Sol adjudicates after Luna's local review. */
export const AdjudicatedFindingCategory = Schema.Literal("security", "standards", "quality", "goals")
export const DirectFindingCategory = Schema.Literal("documentation", "repository-standards")
export const FindingCategory = Schema.Union(AdjudicatedFindingCategory, DirectFindingCategory)
export type FindingCategory = Schema.Schema.Type<typeof FindingCategory>
export type DirectFindingCategory = Schema.Schema.Type<typeof DirectFindingCategory>

/** One Luna finding with lifecycle data for prior-review reconciliation. */
export const LunaFinding = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  status: Schema.Literal("new", "open", "resolved", "superseded", "suppressed"),
  category: FindingCategory,
  severity: Schema.Literal("critical", "warning", "suggestion"),
  title: Schema.String,
  impact: Schema.String,
  evidence: Schema.String,
  rule: Schema.NullOr(Schema.String),
  location: Schema.NullOr(FindingLocation),
})
export interface LunaFinding extends Schema.Schema.Type<typeof LunaFinding> {}

/** A changed seam that requires repository-wide reasoning from Sol. */
export const ReviewSeam = Schema.Struct({
  category: AdjudicatedFindingCategory,
  summary: Schema.String,
  paths: Schema.Array(Schema.String),
})
export interface ReviewSeam extends Schema.Schema.Type<typeof ReviewSeam> {}

/** Structured result required from each semantic Luna review unit. */
export const LunaOutput = Schema.Struct({
  summary: Schema.String,
  reviewedPaths: Schema.Array(Schema.String),
  seamNotes: Schema.Array(ReviewSeam),
  findings: Schema.Array(LunaFinding),
})
export interface LunaOutput extends Schema.Schema.Type<typeof LunaOutput> {}

/** A final finding with a stable lifecycle, produced by Sol or a Luna-final reviewer. */
const canonicalFindingFields = {
  id: Schema.NullOr(Schema.String),
  status: Schema.Literal("new", "open", "resolved", "superseded", "suppressed"),
  severity: Schema.Literal("critical", "warning", "suggestion"),
  title: Schema.String,
  impact: Schema.String,
  evidence: Schema.String,
  rule: Schema.NullOr(Schema.String),
  location: Schema.NullOr(FindingLocation),
  sources: Schema.Array(Schema.String),
}

export const CanonicalFinding = Schema.Struct({
  ...canonicalFindingFields,
  category: FindingCategory,
})
export interface CanonicalFinding extends Schema.Schema.Type<typeof CanonicalFinding> {}

const AdjudicatedCanonicalFinding = Schema.Struct({
  ...canonicalFindingFields,
  category: AdjudicatedFindingCategory,
})

/** Structured result required from each Sol stage. */
export const CoordinatorOutput = Schema.Struct({
  summary: Schema.String,
  findings: Schema.Array(AdjudicatedCanonicalFinding),
})
export interface CoordinatorOutput extends Schema.Schema.Type<typeof CoordinatorOutput> {}

/** One bounded, semantically grouped patch assigned to a Luna reviewer. */
export interface ReviewUnit {
  readonly id: string
  readonly label: string
  readonly paths: ReadonlyArray<string>
  readonly patchPath: string
  readonly patchLines: number
  readonly patchBytes: number
}

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
  readonly reviewUnitManifestPath: string
  readonly reviewUnits: ReadonlyArray<ReviewUnit>
  readonly repositoryGuidanceManifestPath: string
  readonly changedPaths: ReadonlyArray<string>
  readonly skippedPaths: ReadonlyArray<string>
  readonly historyPath: string
  readonly runDirectory: string
}

/** Prior completed result supplied to later reviewers. */
export const PriorReview = Schema.Struct({
  runId: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
  baseTip: Schema.String,
  mergeBase: Schema.String,
  head: Schema.String,
  effectiveTreeId: Schema.String,
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
  promptVersion: Schema.String,
  standardsDigest: Schema.String,
  models: ReviewModels,
  mode: Schema.Literal("full", "incremental", "cache_hit"),
  complete: Schema.Boolean,
  costUsd: Schema.Number.pipe(Schema.optionalWith({ default: () => 0 })),
  cachedInputPercent: Schema.NullOr(Schema.Number).pipe(Schema.optionalWith({ default: () => null })),
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
  readonly onProgress?: ReviewProgressReporter
}

/** Safe progress events emitted by one review run. */
export type ReviewProgressEvent =
  | { readonly type: "snapshot_started" }
  | { readonly type: "snapshot_ready"; readonly changedPathCount: number; readonly unitCount: number }
  | { readonly type: "cache_hit" }
  | { readonly type: "stage_started"; readonly role: string }
  | { readonly type: "stage_activity"; readonly role: string; readonly detail: string }
  | {
      readonly type: "stage_finished"
      readonly role: string
      readonly status: "succeeded" | "failed"
      readonly findingCount: number
    }
  | { readonly type: "review_finished"; readonly complete: boolean }

/** Per-run observer for terminal or API progress presentation. */
export type ReviewProgressReporter = (event: ReviewProgressEvent) => Effect.Effect<void>

/** One isolated application-level model role. */
export interface ReviewerTask {
  readonly role: string
  readonly model: string
  readonly system: string
  readonly prompt: string
  readonly allowTracker: boolean
}

/** One Luna task and the semantic unit it must cover completely. */
export interface LunaReviewerTask {
  readonly unit: ReviewUnit
  readonly task: ReviewerTask
}

/** Raw successful response from one OpenCode session. */
export interface ReviewerResponse {
  readonly role: string
  readonly sessionId: string
  readonly text: string
}
