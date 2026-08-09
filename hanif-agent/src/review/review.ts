import { Context, Effect, Either, Layer, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { ReviewerOutputError, type ReviewError } from "../errors.ts"
import {
  CanonicalFinding,
  CoordinatorOutput,
  LunaOutput,
  ReviewResult,
  type DirectFindingCategory,
  type LunaReviewerTask,
  type ReviewProgressReporter,
  type PriorReview,
  type ReviewerResponse,
  type ReviewerTask,
  type ReviewRequest,
  type ReviewSnapshot,
} from "./domain.ts"
import { captureReviewSnapshot, isAncestor, removeReviewSnapshot } from "./git-snapshot.ts"
import { appendReviewRecord, loadPriorReview } from "./history.ts"
import { OpenCodeRuntime, type RunningOpenCode } from "./opencode-runtime.ts"
import {
  detectEffectAtomUsage,
  goalReferenceFromBranch,
  holisticReviewTask,
  lunaReviewTasks,
  PROMPT_VERSION,
  trustedSkillsDigest,
} from "./prompts.ts"

interface ReviewInterface {
  readonly run: (request: ReviewRequest) => Effect.Effect<ReviewResult, ReviewError>
}

const lunaConcurrency = 4

/** Runs one complete adversarial review and persists its reusable result. */
export class Review extends Context.Tag("@hanif-agent/Review")<Review, ReviewInterface>() {
  static readonly layerWithoutDependencies = Layer.effect(
    Review,
    Effect.gen(function* () {
      const openCode = yield* OpenCodeRuntime

      const runReview = Effect.fn("Review.run")(function* (request: ReviewRequest) {
        const runId = randomUUID()
        const report = request.onProgress ?? silentProgress
        yield* report({ type: "snapshot_started" })
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const snapshot = yield* captureReviewSnapshot(request.cwd, request.baseRef, runId)
            yield* Effect.addFinalizer(() => removeReviewSnapshot(snapshot).pipe(Effect.ignore))
            yield* report({
              type: "snapshot_ready",
              changedPathCount: snapshot.changedPaths.length,
              unitCount: snapshot.reviewUnits.length,
            })
            const goal = yield* goalReferenceFromBranch(snapshot.branch)
            const usesEffectAtom = yield* detectEffectAtomUsage(snapshot.snapshotDirectory)
            const standardsDigest = yield* trustedSkillsDigest(snapshot.runtimeDirectory, usesEffectAtom)
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
                promptVersion: PROMPT_VERSION,
                standardsDigest,
                models: request.models,
                mode: "cache_hit",
                complete: true,
                costUsd: 0,
                cachedInputPercent: null,
                summary: compatible.summary,
                findings: [...compatible.findings],
                historyPath: snapshot.historyPath,
              })
              yield* finish(snapshot.historyPath, result)
              yield* report({ type: "cache_hit" })
              yield* report({ type: "review_finished", complete: true })
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
                promptVersion: PROMPT_VERSION,
                standardsDigest,
                models: request.models,
                mode: "full",
                complete: true,
                costUsd: 0,
                cachedInputPercent: null,
                summary: "No reviewable changes were found.",
                findings: [],
                historyPath: snapshot.historyPath,
              })
              yield* finish(snapshot.historyPath, result)
              yield* report({ type: "review_finished", complete: true })
              return result
            }

            const mode = "full" as const
            const priorFindings = compatible?.findings ?? []
            const adjudicatedPrior = priorFindings.filter((finding) => !isDirectFinding(finding))

            return yield* Effect.scoped(
              Effect.gen(function* () {
                const runtime = yield* openCode.start({
                  directory: snapshot.runtimeDirectory,
                  goal,
                  onProgress: report,
                })
                const tasks = lunaReviewTasks({
                  snapshot,
                  priorFindings,
                  reviewerModel: request.models.reviewer,
                  usesEffectAtom,
                })
                const lunaResults = yield* Effect.forEach(
                  tasks,
                  (luna) => runLunaStage(runtime, luna, snapshot.historyPath, runId, report),
                  { concurrency: lunaConcurrency },
                )

                const successful = lunaResults.flatMap((result, index) => {
                  if (Either.isLeft(result)) return []
                  const luna = tasks[index]
                  return luna === undefined ? [] : [{ role: luna.task.role, output: result.right.output }]
                })

                const solTask = holisticReviewTask({
                  snapshot,
                  coordinatorModel: request.models.coordinator,
                  lunaOutputs: successful.map(({ role, output }) => ({
                    role,
                    reviewedPaths: output.reviewedPaths,
                    seamNotes: output.seamNotes,
                    findings: output.findings.filter((finding) => !isDirectCategory(finding.category)),
                  })),
                  failedUnits: lunaResults.flatMap((result, index) =>
                    Either.isLeft(result) && tasks[index] !== undefined ? [tasks[index].unit] : []
                  ),
                  priorFindings: adjudicatedPrior,
                  goal,
                })
                const final = yield* runRequiredStage(runtime, solTask, snapshot.historyPath, runId, report)
                const directFindings = normalizeLunaFinalFindings(successful, priorFindings)
                const findings = [...reconcilePrior(final.output.findings, adjudicatedPrior), ...directFindings].map(
                  withFindingId,
                )
                const activeDirectFindings = directFindings.filter(isActiveFinding).length
                const usage = yield* runtime.usage
                const totalInputTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
                const result = ReviewResult.make({
                  runId,
                  repositoryRoot: snapshot.repositoryRoot,
                  branch: snapshot.branch,
                  baseRef: snapshot.baseRef,
                  baseTip: snapshot.baseTip,
                  mergeBase: snapshot.mergeBase,
                  head: snapshot.head,
                  effectiveTreeId: snapshot.effectiveTreeId,
                  promptVersion: PROMPT_VERSION,
                  standardsDigest,
                  models: request.models,
                  mode,
                  complete: lunaResults.every(Either.isRight),
                  costUsd: usage.costUsd,
                  cachedInputPercent: totalInputTokens === 0 ? null : (usage.cacheReadTokens / totalInputTokens) * 100,
                  summary:
                    activeDirectFindings === 0
                      ? final.output.summary
                      : `${final.output.summary} ${activeDirectFindings} Luna-final ${activeDirectFindings === 1 ? "finding remains" : "findings remain"} active.`,
                  findings,
                  historyPath: snapshot.historyPath,
                })
                yield* finish(snapshot.historyPath, result)
                yield* report({ type: "review_finished", complete: result.complete })
                return result
              }),
            ).pipe(
              Effect.tapError((error) =>
                appendReviewRecord(snapshot.historyPath, {
                  type: "run_failed",
                  at: new Date().toISOString(),
                  runId,
                  error: error._tag,
                }).pipe(Effect.ignore),
              ),
            )
          }),
        )
      })

      return Review.of({ run: runReview })
    }),
  )

  static readonly layer = Review.layerWithoutDependencies.pipe(Layer.provide(OpenCodeRuntime.layer))
}

const compatiblePrior = Effect.fn("Review.compatiblePrior")(function* (
  snapshot: ReviewSnapshot,
  prior: PriorReview | null,
  standardsDigest: string,
  models: ReviewRequest["models"],
) {
  if (
    prior === null ||
    prior.branch !== snapshot.branch ||
    prior.baseRef !== snapshot.baseRef ||
    prior.baseTip !== snapshot.baseTip ||
    prior.mergeBase !== snapshot.mergeBase ||
    prior.promptVersion !== PROMPT_VERSION ||
    prior.standardsDigest !== standardsDigest ||
    prior.models.reviewer !== models.reviewer ||
    prior.models.coordinator !== models.coordinator
  )
    return null
  return (yield* isAncestor(snapshot.repositoryRoot, prior.head, snapshot.head)) ? prior : null
})

const extractJson = (role: string, output: string): Effect.Effect<unknown, ReviewerOutputError> =>
  Effect.try({
    try: () => {
      const trimmed = output
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
      const start = trimmed.indexOf("{")
      const end = trimmed.lastIndexOf("}")
      if (start === -1 || end < start) throw new Error("response contains no JSON object")
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown
    },
    catch: (cause) =>
      new ReviewerOutputError({
        role,
        message: `reviewer returned invalid JSON: ${String(cause)}`,
        output: output.slice(0, 4_000),
      }),
  })

const runLuna = Effect.fn("Review.runLuna")(function* (runtime: RunningOpenCode, luna: LunaReviewerTask) {
  const response = yield* runWithOutputRetry(runtime, luna.task, LunaOutput, (output) => {
    const assigned = new Set(luna.unit.paths)
    const reviewed = new Set(output.reviewedPaths)
    const missing = luna.unit.paths.filter((path) => !reviewed.has(path))
    const unexpected = output.reviewedPaths.filter((path) => !assigned.has(path))
    if (missing.length === 0 && unexpected.length === 0) return Effect.succeed(output)
    return Effect.fail(new ReviewerOutputError({
      role: luna.task.role,
      message: `reviewer coverage does not match its assigned paths; missing=${missing.join(",")}; unexpected=${unexpected.join(",")}`,
      output: JSON.stringify(output).slice(0, 4_000),
    }))
  })
  return { response: response.response, output: response.decoded }
})

const runCanonical = Effect.fn("Review.runCanonical")(function* (runtime: RunningOpenCode, task: ReviewerTask) {
  const response = yield* runWithOutputRetry(runtime, task, CoordinatorOutput)
  return { response: response.response, output: response.decoded }
})

const runWithOutputRetry = <A, I>(
  runtime: RunningOpenCode,
  task: ReviewerTask,
  schema: Schema.Schema<A, I>,
  validate?: (decoded: A) => Effect.Effect<A, ReviewerOutputError>,
): Effect.Effect<{ readonly response: ReviewerResponse; readonly decoded: A }, ReviewError> => {
  const attempt = Effect.gen(function* () {
    const response = yield* runtime.run(task)
    const json = yield* extractJson(task.role, response.text)
    const decoded = yield* Schema.decodeUnknown(schema)(json).pipe(
      Effect.mapError(
        (cause) =>
          new ReviewerOutputError({
            role: task.role,
            message: `reviewer JSON does not match its contract: ${String(cause)}`,
            output: response.text.slice(0, 4_000),
          }),
      ),
    )
    return { response, decoded: validate === undefined ? decoded : yield* validate(decoded) }
  })
  return attempt.pipe(
    Effect.retry({
      times: 1,
      while: (error) => error instanceof ReviewerOutputError,
    }),
  )
}

const runLunaStage = Effect.fn("Review.runLunaStage")(function* (
  runtime: RunningOpenCode,
  luna: LunaReviewerTask,
  historyPath: string,
  runId: string,
  report: ReviewProgressReporter,
) {
  yield* report({ type: "stage_started", role: luna.task.role })
  const result = yield* runLuna(runtime, luna).pipe(Effect.either)
  yield* appendStage(historyPath, runId, luna.task, result)
  yield* report({
    type: "stage_finished",
    role: luna.task.role,
    status: Either.isRight(result) ? "succeeded" : "failed",
    findingCount: Either.isRight(result) ? result.right.output.findings.length : 0,
  })
  return result
})

const runRequiredStage = Effect.fn("Review.runRequiredStage")(function* (
  runtime: RunningOpenCode,
  task: ReviewerTask,
  historyPath: string,
  runId: string,
  report: ReviewProgressReporter,
) {
  yield* report({ type: "stage_started", role: task.role })
  const result = yield* runCanonical(runtime, task).pipe(Effect.either)
  yield* appendStage(historyPath, runId, task, result)
  yield* report({
    type: "stage_finished",
    role: task.role,
    status: Either.isRight(result) ? "succeeded" : "failed",
    findingCount: Either.isRight(result) ? result.right.output.findings.length : 0,
  })
  if (Either.isLeft(result)) return yield* result.left
  return result.right
})

const appendStage = <A>(
  historyPath: string,
  runId: string,
  task: ReviewerTask,
  result: Either.Either<{ readonly response: ReviewerResponse; readonly output: A }, ReviewError>,
): Effect.Effect<void, ReviewError> =>
  appendReviewRecord(
    historyPath,
    Either.match(result, {
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
    }),
  )

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
  const currentIds = new Set(current.flatMap((finding) => (finding.id === null ? [] : [finding.id])))
  const omittedOpenFindings = prior
    .filter(
      (finding) =>
        finding.id !== null && (finding.status === "new" || finding.status === "open") && !currentIds.has(finding.id),
    )
    .map((finding) => CanonicalFinding.make({ ...finding, status: "open" }))
  return [...current, ...omittedOpenFindings]
}

const isDirectFinding = (finding: CanonicalFinding): boolean =>
  isDirectCategory(finding.category)

const isDirectCategory = (category: CanonicalFinding["category"]): category is DirectFindingCategory =>
  category === "documentation" || category === "repository-standards"

const isActiveFinding = (finding: CanonicalFinding): boolean => finding.status === "new" || finding.status === "open"

const normalizeLunaFinalFindings = (
  outputs: ReadonlyArray<{ readonly role: string; readonly output: LunaOutput }>,
  allPrior: ReadonlyArray<CanonicalFinding>,
): ReadonlyArray<CanonicalFinding> => {
  const prior = allPrior.filter(isDirectFinding)
  const priorIds = new Set(prior.flatMap((finding) => (finding.id === null ? [] : [finding.id])))
  const normalized = outputs.flatMap(({ role, output }) => output.findings.flatMap((finding) => {
    if (!isDirectCategory(finding.category)) return []
    const reusesPrior = finding.id !== null && priorIds.has(finding.id)
    const normalizedFinding = withFindingId(
      CanonicalFinding.make({
        ...finding,
        id: reusesPrior ? finding.id : null,
        status: reusesPrior ? (finding.status === "new" ? "open" : finding.status) : "new",
        category: finding.category,
        sources: [role],
      }),
    )
    return [!reusesPrior && normalizedFinding.id !== null && priorIds.has(normalizedFinding.id)
      ? CanonicalFinding.make({ ...normalizedFinding, status: "open" })
      : normalizedFinding]
  }))
  const unique = new Map<string | null, CanonicalFinding>()
  for (const finding of normalized) {
    const existing = unique.get(finding.id)
    unique.set(
      finding.id,
      existing === undefined
        ? finding
        : CanonicalFinding.make({ ...finding, sources: [...new Set([...existing.sources, ...finding.sources])] }),
    )
  }
  return reconcilePrior([...unique.values()], prior)
}

const silentProgress: ReviewProgressReporter = () => Effect.void

const withFindingId = (finding: CanonicalFinding): CanonicalFinding => {
  if (finding.id !== null) return finding
  const location = finding.location === null ? "" : `${finding.location.path}:${finding.location.symbol ?? ""}`
  const key = [
    finding.category,
    finding.rule ?? "",
    location,
    finding.title.toLowerCase().replace(/\W+/g, " ").trim(),
  ].join("\0")
  return CanonicalFinding.make({
    ...finding,
    id: createHash("sha256").update(key).digest("hex").slice(0, 20),
  })
}
