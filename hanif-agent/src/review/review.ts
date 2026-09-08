import { Context, Effect, Either, Fiber, Layer, Option, Ref, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { ReviewerExecutionError, ReviewerOutputError, ReviewRunError, type ReviewError } from "../errors.ts"
import {
  CanonicalFinding,
  CoordinatorOutput,
  LunaOutput,
  ReviewResult,
  ReviewStage,
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
import { CodexRuntime, type RunningCodex } from "./codex-runtime.ts"
import { readReviewRun } from "./review-runs.ts"
import { reviewDiagnostic } from "./review-diagnostics.ts"
import {
  detectEffectAtomUsage,
  goalReferenceFromBranch,
  reconciliationReviewTask,
  independentReviewTask,
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
      const codex = yield* CodexRuntime

      const runReview = Effect.fn("Review.run")(function* (request: ReviewRequest) {
        const runId = randomUUID()
        const report = request.onProgress ?? silentProgress
        yield* report({ type: "snapshot_started" })
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const snapshot = yield* captureReviewSnapshot(request.cwd, request.baseRef, runId, request.targetRef)
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
            const compatibilityKey = createHash("sha256").update(JSON.stringify({
              root: snapshot.repositoryRoot, branch: snapshot.branch, baseRef: snapshot.baseRef,
              baseTip: snapshot.baseTip, mergeBase: snapshot.mergeBase, head: snapshot.head,
              tree: snapshot.effectiveTreeId, prompt: PROMPT_VERSION, standardsDigest,
              models: request.models, targetRef: request.targetRef ?? null,
            })).digest("hex")
            const retry = request.retryRunId === undefined ? Option.none() : Option.some(yield* readReviewRun(request.retryRunId))
            if (Option.isSome(retry)) {
              const started = retry.value.records.find((record) => record.type === "run_started")
              if (retry.value.status === "running" || retry.value.status === "complete" || started?.compatibilityKey !== compatibilityKey) {
                return yield* new ReviewRunError({
                  operation: "retry review run",
                  message: "Review retry requires an incomplete, failed, or interrupted run with identical snapshot, scope, models, and policy. Start a fresh review for changed inputs.",
                })
              }
            }

            yield* appendReviewRecord(snapshot.historyPath, {
              type: "run_started",
              at: new Date().toISOString(),
              runId,
              branch: snapshot.branch,
              head: snapshot.head,
              effectiveTreeId: snapshot.effectiveTreeId,
              pid: process.pid,
              compatibilityKey,
              input: { cwd: snapshot.repositoryRoot, baseRef: snapshot.baseRef, targetRef: request.targetRef ?? null,
                models: request.models, timeoutMs: request.timeoutMs ?? 600_000 },
            })
            yield* report({ type: "run_started", runId, historyPath: snapshot.historyPath })
            const trackedReport: ReviewProgressReporter = (event) => Effect.gen(function* () {
              // Progress is advisory; authoritative stage checkpoint writes below still fail explicitly.
              yield* appendReviewRecord(snapshot.historyPath, { ...event, at: new Date().toISOString(), runId,
                ...(event.type === "attempt_failed" ? { diagnostic: event.error } : {}) }).pipe(Effect.ignore)
              yield* report(event)
            })
            yield* Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep("15 seconds")
                yield* appendReviewRecord(snapshot.historyPath, { type: "heartbeat", at: new Date().toISOString(), runId })
                yield* report({ type: "heartbeat", runId })
              }
            }).pipe(Effect.forkScoped)

            const compatible = yield* compatiblePrior(snapshot, prior, standardsDigest, request.models)
            if (Option.isNone(retry) && compatible !== null && compatible.effectiveTreeId === snapshot.effectiveTreeId && goal === null) {
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
                const runtime = yield* codex.start({
                  directory: snapshot.runtimeDirectory,
                  goal,
                  onProgress: trackedReport,
                  timeoutMs: request.timeoutMs ?? 600_000,
                })
                const tasks = lunaReviewTasks({
                  snapshot,
                  priorFindings,
                  reviewerModel: request.models.reviewer,
                  usesEffectAtom,
                })
                const independent = yield* runRequiredStage(runtime, independentReviewTask({
                  snapshot, coordinatorModel: request.models.coordinator, priorFindings: adjudicatedPrior, goal,
                }), snapshot.historyPath, runId, trackedReport, snapshot.changedPaths).pipe(Effect.either, Effect.forkScoped)
                const lunaResults = yield* Effect.forEach(
                  tasks,
                  (luna) => Effect.gen(function* () {
                    if (Option.isSome(retry)) {
                      const checkpoint = [...retry.value.records].reverse().find((record) =>
                        record.stage?.role === luna.task.role && record.stage.status !== "failed" && record.output !== undefined)
                      const output = Schema.decodeUnknownOption(LunaOutput)(checkpoint?.output)
                      if (Option.isSome(output)) {
                        const covered = yield* validateCoverage(luna.task.role, luna.unit.paths, output.value.reviewedPaths, output.value).pipe(Effect.either)
                        if (Either.isRight(covered)) {
                          const stage = ReviewStage.make({ role: luna.task.role, model: luna.task.model, status: "reused",
                            attempts: 0, durationMs: 0, reviewedPaths: covered.right.reviewedPaths, error: null })
                          yield* appendReviewRecord(snapshot.historyPath, { type: "stage_finished", at: new Date().toISOString(), runId,
                            role: luna.task.role, status: "succeeded", stage, output: covered.right })
                          yield* trackedReport({ type: "stage_reused", role: luna.task.role })
                          return Either.right({ response: { role: luna.task.role, sessionId: "checkpoint", text: "" }, output: covered.right })
                        }
                      }
                    }
                    return yield* runLunaStage(runtime, luna, snapshot.historyPath, runId, trackedReport)
                  }),
                  { concurrency: lunaConcurrency },
                )

                const successful = lunaResults.flatMap((result, index) => {
                  if (Either.isLeft(result)) return []
                  const luna = tasks[index]
                  return luna === undefined ? [] : [{ role: luna.task.role, output: result.right.output }]
                })

                const independentResult = yield* Fiber.join(independent)
                if (Either.isLeft(independentResult)) return yield* independentResult.left
                const independentFindings = independentResult.right.output.findings.map((finding) => ({
                  ...withFindingId(finding), category: finding.category,
                }))
                const reconciliationPrior = [
                  ...adjudicatedPrior.filter((finding) => !independentFindings.some((independentFinding) => independentFinding.id === finding.id)),
                  ...independentFindings,
                ]
                const reconciliationTask = reconciliationReviewTask({
                  snapshot,
                  coordinatorModel: request.models.coordinator,
                  lunaOutputs: successful.map(({ role, output }) => ({
                    role,
                    reviewedPaths: output.reviewedPaths,
                    seamNotes: output.seamNotes,
                    findings: output.findings.filter((finding) => !isDirectCategory(finding.category)),
                  })),
                  failedAssignments: lunaResults.flatMap((result, index) => {
                    const luna = tasks[index]
                    return Either.isLeft(result) && luna !== undefined
                      ? [{ role: luna.task.role, unit: luna.unit }]
                      : []
                  }),
                  priorFindings: adjudicatedPrior,
                  goal,
                  independentOutput: { ...independentResult.right.output, findings: independentFindings },
                })
                const final = yield* runRequiredStage(
                  runtime,
                  reconciliationTask,
                  snapshot.historyPath,
                  runId,
                  trackedReport,
                  snapshot.changedPaths,
                )
                const directFindings = normalizeLunaFinalFindings(successful, priorFindings)
                const findings = [...reconcilePrior(final.output.findings, reconciliationPrior), ...directFindings].map(
                  withFindingId,
                )
                const activeDirectFindings = directFindings.filter(isActiveFinding).length
                const usage = yield* runtime.usage
                const totalInputTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
                const recordedRun = yield* readReviewRun(runId)
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
                  stages: recordedRun.records.flatMap((record) => record.stage === undefined ? [] : [record.stage]),
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
              Effect.onInterrupt(() => appendReviewRecord(snapshot.historyPath, {
                type: "run_interrupted", at: new Date().toISOString(), runId,
              }).pipe(Effect.ignore)),
              Effect.tapError((error) =>
                appendReviewRecord(snapshot.historyPath, {
                  type: "run_failed",
                  at: new Date().toISOString(),
                  runId,
                  error: error._tag,
                  diagnostic: reviewDiagnostic(error),
                }).pipe(Effect.ignore),
              ),
            )
          }),
        )
      })

      return Review.of({ run: runReview })
    }),
  )

  static readonly layer = Review.layerWithoutDependencies.pipe(Layer.provide(CodexRuntime.layer))
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

const runLuna = Effect.fn("Review.runLuna")(function* (runtime: RunningCodex, luna: LunaReviewerTask, report: ReviewProgressReporter) {
  const response = yield* runWithOutputRetry(runtime, luna.task, LunaOutput, (output) =>
    validateCoverage(luna.task.role, luna.unit.paths, output.reviewedPaths, output), report)
  return { response: response.response, output: response.decoded }
})

const validateCoverage = <A>(
  role: string,
  expectedPaths: ReadonlyArray<string>,
  reviewedPaths: ReadonlyArray<string>,
  output: A,
): Effect.Effect<A, ReviewerOutputError> => {
  const expected = new Set(expectedPaths)
  const reviewed = new Set(reviewedPaths)
  const missing = expectedPaths.filter((path) => !reviewed.has(path))
  const unexpected = reviewedPaths.filter((path) => !expected.has(path))
  if (missing.length === 0 && unexpected.length === 0) return Effect.succeed(output)
  return Effect.fail(new ReviewerOutputError({
    role,
    message: `reviewer coverage does not match its assigned paths; missing=${missing.join(",")}; unexpected=${unexpected.join(",")}`,
    output: JSON.stringify(output).slice(0, 4_000),
  }))
}

const runCanonical = Effect.fn("Review.runCanonical")(function* (
  runtime: RunningCodex,
  task: ReviewerTask,
  expectedPaths: ReadonlyArray<string>,
  report: ReviewProgressReporter,
) {
  const response = yield* runWithOutputRetry(runtime, task, CoordinatorOutput, (output) =>
    validateCoverage(task.role, expectedPaths, output.reviewedPaths, output), report)
  return { response: response.response, output: response.decoded }
})

const runWithOutputRetry = <A, I>(
  runtime: RunningCodex,
  task: ReviewerTask,
  schema: Schema.Schema<A, I>,
  validate: (decoded: A) => Effect.Effect<A, ReviewerOutputError>,
  report: ReviewProgressReporter,
): Effect.Effect<{ readonly response: ReviewerResponse; readonly decoded: A }, ReviewError> => {
  return Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const attempt = Effect.gen(function* () {
      const response = yield* runtime.run(task).pipe(Effect.tapError((error) =>
        Ref.update(attempts, (count) => count + error.attempts)))
      yield* Ref.update(attempts, (count) => count + (response.attempts ?? 1))
      const json = yield* extractJson(task.role, response.text)
      const decoded = yield* Schema.decodeUnknown(schema)(json).pipe(
        Effect.mapError((cause) => new ReviewerOutputError({
          role: task.role,
          message: `reviewer JSON does not match its contract: ${String(cause)}`,
          output: response.text.slice(0, 4_000),
        })),
      )
      return {
        response: { ...response, attempts: yield* Ref.get(attempts) },
        decoded: yield* validate(decoded),
      }
    })
    const retried = attempt.pipe(
      Effect.tapErrorTag("ReviewerOutputError", (error) => Effect.gen(function* () {
        yield* report({ type: "attempt_failed", role: task.role, attempt: yield* Ref.get(attempts),
          error: reviewDiagnostic(error) })
      })),
      Effect.retry({ times: 1, while: Schema.is(ReviewerOutputError) }),
    )
    return yield* retried.pipe(
      Effect.catchTag("ReviewerOutputError", (error) => Effect.gen(function* () {
        return yield* new ReviewerOutputError({ role: error.role, message: error.message, output: error.output,
          attempts: yield* Ref.get(attempts) })
      })),
      Effect.catchTag("ReviewerExecutionError", (error) => Effect.gen(function* () {
        return yield* new ReviewerExecutionError({ ...error, message: error.message, attempts: yield* Ref.get(attempts) })
      })),
    )
  })
}

const runLunaStage = Effect.fn("Review.runLunaStage")(function* (
  runtime: RunningCodex,
  luna: LunaReviewerTask,
  historyPath: string,
  runId: string,
  report: ReviewProgressReporter,
) {
  const startedAt = Date.now()
  yield* report({ type: "stage_started", role: luna.task.role })
  const result = yield* runLuna(runtime, luna, report).pipe(Effect.either)
  yield* appendStage(historyPath, runId, luna.task, result, Date.now() - startedAt)
  yield* report({
    type: "stage_finished",
    role: luna.task.role,
    status: Either.isRight(result) ? "succeeded" : "failed",
    findingCount: Either.isRight(result) ? result.right.output.findings.length : 0,
  })
  return result
})

const runRequiredStage = Effect.fn("Review.runRequiredStage")(function* (
  runtime: RunningCodex,
  task: ReviewerTask,
  historyPath: string,
  runId: string,
  report: ReviewProgressReporter,
  expectedPaths: ReadonlyArray<string>,
) {
  const startedAt = Date.now()
  yield* report({ type: "stage_started", role: task.role })
  const result = yield* runCanonical(runtime, task, expectedPaths, report).pipe(Effect.either)
  yield* appendStage(historyPath, runId, task, result, Date.now() - startedAt)
  yield* report({
    type: "stage_finished",
    role: task.role,
    status: Either.isRight(result) ? "succeeded" : "failed",
    findingCount: Either.isRight(result) ? result.right.output.findings.length : 0,
  })
  if (Either.isLeft(result)) return yield* result.left
  return result.right
})

const appendStage = <A extends { readonly reviewedPaths: ReadonlyArray<string> }>(
  historyPath: string,
  runId: string,
  task: ReviewerTask,
  result: Either.Either<{ readonly response: ReviewerResponse; readonly output: A }, ReviewError>,
  durationMs: number,
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
        diagnostic: reviewDiagnostic(error),
        stage: ReviewStage.make({ role: task.role, model: task.model, status: "failed", durationMs,
          attempts: Schema.is(ReviewerExecutionError)(error) || Schema.is(ReviewerOutputError)(error) ? error.attempts : 1,
          reviewedPaths: [], error: reviewDiagnostic(error) }),
      }),
      onRight: ({ response, output }) => ({
        type: "stage_finished",
        at: new Date().toISOString(),
        runId,
        role: task.role,
        sessionId: response.sessionId,
        status: "succeeded",
        output,
        stage: ReviewStage.make({ role: task.role, model: task.model, status: "succeeded", durationMs,
          attempts: response.attempts ?? 1, reviewedPaths: output.reviewedPaths, error: null }),
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
  category === "standards" || category === "documentation" || category === "repository-standards"

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
