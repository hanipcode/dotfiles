import { Context, Effect, Either, Layer, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { access } from "node:fs/promises"
import { ReviewerOutputError, type ReviewError } from "../errors.ts"
import {
  CanonicalFinding,
  CoordinatorOutput,
  ReviewResult,
  SpecialistOutput,
  type PriorReview,
  type ReviewerResponse,
  type ReviewerTask,
  type ReviewRequest,
} from "./domain.ts"
import { captureReviewSnapshot, isAncestor, writeIncrementalPatch } from "./git-snapshot.ts"
import { appendReviewRecord, loadPriorReview } from "./history.ts"
import { OpenCodeRuntime, type RunningOpenCode } from "./opencode-runtime.ts"
import {
  codingStandardsDigest,
  deduplicationTask,
  gapReviewTask,
  goalReferenceFromBranch,
  PROMPT_VERSION,
  specialistTasks,
} from "./prompts.ts"

interface ReviewInterface {
  readonly run: (request: ReviewRequest) => Effect.Effect<ReviewResult, ReviewError>
}

/** Runs one complete adversarial review and persists its reusable result. */
export class Review extends Context.Tag("@hanif-agent/Review")<Review, ReviewInterface>() {
  static readonly layerWithoutDependencies = Layer.effect(
    Review,
    Effect.gen(function* () {
      const openCode = yield* OpenCodeRuntime

      const runReview = Effect.fn("Review.run")(function* (request: ReviewRequest) {
        const runId = randomUUID()
        const snapshot = yield* captureReviewSnapshot(request.cwd, request.baseRef, runId)
        const goal = yield* goalReferenceFromBranch(snapshot.branch)
        const standardsDigest = yield* codingStandardsDigest(snapshot.runtimeDirectory)
        const prior = yield* loadPriorReview(snapshot.historyPath)

        yield* appendReviewRecord(snapshot.historyPath, {
          type: "run_started",
          at: new Date().toISOString(),
          runId,
          branch: snapshot.branch,
          head: snapshot.head,
          effectiveTreeId: snapshot.effectiveTreeId,
        })

        const compatible = yield* compatiblePrior(snapshot, prior, standardsDigest, request.models)
        if (compatible !== null && compatible.effectiveTreeId === snapshot.effectiveTreeId && goal === null) {
          const result = ReviewResult.make({
            runId,
            repositoryRoot: snapshot.repositoryRoot,
            branch: snapshot.branch,
            baseRef: snapshot.baseRef,
            baseTip: snapshot.baseTip,
            mergeBase: snapshot.mergeBase,
            head: snapshot.head,
            effectiveTreeId: snapshot.effectiveTreeId,
            snapshotDirectory: snapshot.snapshotDirectory,
            promptVersion: PROMPT_VERSION,
            standardsDigest,
            models: request.models,
            mode: "cache_hit",
            complete: true,
            summary: compatible.summary,
            findings: [...compatible.findings],
            historyPath: snapshot.historyPath,
          })
          yield* finish(snapshot.historyPath, result)
          return result
        }

        if (snapshot.changedPaths.length === 0 && prior === null) {
          const result = ReviewResult.make({
            runId,
            repositoryRoot: snapshot.repositoryRoot,
            branch: snapshot.branch,
            baseRef: snapshot.baseRef,
            baseTip: snapshot.baseTip,
            mergeBase: snapshot.mergeBase,
            head: snapshot.head,
            effectiveTreeId: snapshot.effectiveTreeId,
            snapshotDirectory: snapshot.snapshotDirectory,
            promptVersion: PROMPT_VERSION,
            standardsDigest,
            models: request.models,
            mode: "full",
            complete: true,
            summary: "No reviewable changes were found.",
            findings: [],
            historyPath: snapshot.historyPath,
          })
          yield* finish(snapshot.historyPath, result)
          return result
        }

        const mode = compatible === null ? "full" as const : "incremental" as const
        const reviewPatch = compatible === null
          ? snapshot.patchPath
          : yield* writeIncrementalPatch(compatible.snapshotDirectory, snapshot)
        const priorFindings = compatible?.findings ?? []

        return yield* Effect.scoped(Effect.gen(function* () {
          const runtime = yield* openCode.start({ directory: snapshot.runtimeDirectory, goal })
          const tasks = specialistTasks({
            snapshot,
            patchPath: reviewPatch,
            priorFindings,
            reviewerModel: request.models.reviewer,
            goal,
          })
          const specialistResults = yield* Effect.forEach(tasks, (task) =>
            runSpecialist(runtime, task).pipe(
              Effect.either,
              Effect.tap((result) => appendStage(snapshot.historyPath, runId, task, result)),
            ), { concurrency: "unbounded" })

          const successful = specialistResults.flatMap((result, index) => {
            if (Either.isLeft(result)) return []
            const task = tasks[index]
            return task === undefined ? [] : [{ role: task.role, output: result.right.output }]
          })

          const dedupeTask = deduplicationTask({
            snapshot,
            coordinatorModel: request.models.coordinator,
            specialistOutputs: successful,
            priorFindings,
          })
          const deduplicated = yield* runCoordinator(runtime, dedupeTask)
          yield* appendReviewRecord(snapshot.historyPath, {
            type: "stage_finished",
            at: new Date().toISOString(),
            runId,
            role: dedupeTask.role,
            status: "succeeded",
            output: deduplicated.output,
          })

          const gapTask = gapReviewTask({
            snapshot,
            coordinatorModel: request.models.coordinator,
            deduplicated: deduplicated.output,
            priorFindings,
          })
          const final = yield* runCoordinator(runtime, gapTask)
          yield* appendReviewRecord(snapshot.historyPath, {
            type: "stage_finished",
            at: new Date().toISOString(),
            runId,
            role: gapTask.role,
            status: "succeeded",
            output: final.output,
          })

          const findings = reconcilePrior(final.output.findings, priorFindings).map(withFindingId)
          const result = ReviewResult.make({
            runId,
            repositoryRoot: snapshot.repositoryRoot,
            branch: snapshot.branch,
            baseRef: snapshot.baseRef,
            baseTip: snapshot.baseTip,
            mergeBase: snapshot.mergeBase,
            head: snapshot.head,
            effectiveTreeId: snapshot.effectiveTreeId,
            snapshotDirectory: snapshot.snapshotDirectory,
            promptVersion: PROMPT_VERSION,
            standardsDigest,
            models: request.models,
            mode,
            complete: specialistResults.every(Either.isRight),
            summary: final.output.summary,
            findings,
            historyPath: snapshot.historyPath,
          })
          yield* finish(snapshot.historyPath, result)
          return result
        })).pipe(
          Effect.tapError((error) => appendReviewRecord(snapshot.historyPath, {
            type: "run_failed",
            at: new Date().toISOString(),
            runId,
            error: error._tag,
          }).pipe(Effect.ignore)),
        )
      })

      return Review.of({ run: runReview })
    }),
  )

  static readonly layer = Review.layerWithoutDependencies.pipe(Layer.provide(OpenCodeRuntime.layer))
}

const compatiblePrior = Effect.fn("Review.compatiblePrior")(function* (
  snapshot: Parameters<typeof writeIncrementalPatch>[1],
  prior: PriorReview | null,
  standardsDigest: string,
  models: ReviewRequest["models"],
) {
  if (prior === null || prior.branch !== snapshot.branch || prior.baseRef !== snapshot.baseRef ||
    prior.baseTip !== snapshot.baseTip || prior.mergeBase !== snapshot.mergeBase ||
    prior.promptVersion !== PROMPT_VERSION || prior.standardsDigest !== standardsDigest ||
    prior.models.reviewer !== models.reviewer || prior.models.coordinator !== models.coordinator) return null
  const snapshotExists = yield* Effect.promise(() => access(prior.snapshotDirectory).then(() => true, () => false))
  if (!snapshotExists) return null
  return (yield* isAncestor(snapshot.repositoryRoot, prior.head, snapshot.head)) ? prior : null
})

const extractJson = (role: string, output: string): Effect.Effect<unknown, ReviewerOutputError> => Effect.try({
  try: () => {
    const trimmed = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start === -1 || end < start) throw new Error("response contains no JSON object")
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown
  },
  catch: (cause) => new ReviewerOutputError({
    role,
    message: `reviewer returned invalid JSON: ${String(cause)}`,
    output: output.slice(0, 4_000),
  }),
})

const runSpecialist = Effect.fn("Review.runSpecialist")(function* (
  runtime: RunningOpenCode,
  task: ReviewerTask,
) {
  const response = yield* runWithOutputRetry(runtime, task, SpecialistOutput)
  return { response: response.response, output: response.decoded }
})

const runCoordinator = Effect.fn("Review.runCoordinator")(function* (
  runtime: RunningOpenCode,
  task: ReviewerTask,
) {
  const response = yield* runWithOutputRetry(runtime, task, CoordinatorOutput)
  return { response: response.response, output: response.decoded }
})

const runWithOutputRetry = <A, I>(
  runtime: RunningOpenCode,
  task: ReviewerTask,
  schema: Schema.Schema<A, I>,
): Effect.Effect<{ readonly response: ReviewerResponse; readonly decoded: A }, ReviewError> => {
  const attempt = Effect.gen(function* () {
    const response = yield* runtime.run(task)
    const json = yield* extractJson(task.role, response.text)
    const decoded = yield* Schema.decodeUnknown(schema)(json).pipe(
      Effect.mapError((cause) => new ReviewerOutputError({
        role: task.role,
        message: `reviewer JSON does not match its contract: ${String(cause)}`,
        output: response.text.slice(0, 4_000),
      })),
    )
    return { response, decoded }
  })
  return attempt.pipe(Effect.retry({ times: 1, while: (error) => error instanceof ReviewerOutputError }))
}

const appendStage = (
  historyPath: string,
  runId: string,
  task: ReviewerTask,
  result: Either.Either<{ readonly response: ReviewerResponse; readonly output: SpecialistOutput }, ReviewError>,
): Effect.Effect<void, ReviewError> => appendReviewRecord(historyPath, Either.match(result, {
  onLeft: (error) => ({
    type: "stage_finished",
    at: new Date().toISOString(),
    runId,
    role: task.role,
    status: "failed",
    error: error._tag,
  }),
  onRight: ({ response, output }) => ({
    type: "stage_finished",
    at: new Date().toISOString(),
    runId,
    role: task.role,
    sessionId: response.sessionId,
    status: "succeeded",
    output,
  }),
}))

const finish = (historyPath: string, result: ReviewResult): Effect.Effect<void, ReviewError> =>
  appendReviewRecord(historyPath, {
    type: "run_finished",
    at: new Date().toISOString(),
    result,
  })

const reconcilePrior = (
  current: ReadonlyArray<CanonicalFinding>,
  prior: ReadonlyArray<CanonicalFinding>,
): ReadonlyArray<CanonicalFinding> => {
  const currentIds = new Set(current.flatMap((finding) => finding.id === null ? [] : [finding.id]))
  const omittedOpenFindings = prior.filter((finding) =>
    finding.id !== null && (finding.status === "new" || finding.status === "open") && !currentIds.has(finding.id)
  ).map((finding) => CanonicalFinding.make({ ...finding, status: "open" }))
  return [...current, ...omittedOpenFindings]
}

const withFindingId = (finding: CanonicalFinding): CanonicalFinding => {
  if (finding.id !== null) return finding
  const location = finding.location === null ? "" : `${finding.location.path}:${finding.location.symbol ?? ""}`
  const key = [finding.category, finding.rule ?? "", location, finding.title.toLowerCase().replace(/\W+/g, " ").trim()].join("\0")
  return CanonicalFinding.make({ ...finding, id: createHash("sha256").update(key).digest("hex").slice(0, 20) })
}
