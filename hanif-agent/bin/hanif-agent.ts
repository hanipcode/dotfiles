#!/usr/bin/env bun

import { Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Either, Layer, Option, Schema } from "effect"
import { copyToClipboard } from "../src/clipboard.ts"
import { ReviewRunError, reviewErrorMessage } from "../src/errors.ts"
import { ReviewModels, type ReviewResult, type ReviewProgressReporter } from "../src/review/domain.ts"
import { cachedInput, reviewCost, reviewMarkdown, reviewText } from "../src/review/presentation.ts"
import { makeCompactProgressReporter } from "../src/review/progress.ts"
import { Review } from "../src/review/review.ts"
import { reviewDiagnostic } from "../src/review/review-diagnostics.ts"
import { readReviewRun } from "../src/review/review-runs.ts"
import { reviewPreflight } from "../src/review/review-preflight.ts"
import { resolve } from "node:path"
import { realpath } from "node:fs/promises"

const baseOption = Options.text("base").pipe(Options.optional)
const repoOption = Options.text("repo").pipe(Options.withDefault(process.cwd()))
const jsonOption = Options.boolean("json")
const reviewerModelOption = Options.text("reviewer-model").pipe(Options.withDefault("openai/gpt-5.6-luna#high"))
const coordinatorModelOption = Options.text("coordinator-model").pipe(Options.withDefault("openai/gpt-6-astra#high"))
const timeoutOption = Options.integer("timeout-seconds").pipe(
  Options.withDefault(600), Options.withSchema(Schema.Number.pipe(Schema.int(), Schema.between(1, 3_600))),
)
const progressOption = Options.choice("progress", ["text", "json", "none"]).pipe(Options.withDefault("text"))

type ReviewCommandName = "review" | "review-worktree" | "review-lc" | "review-retry"

interface ReviewCommandOptions {
  readonly repo: string
  readonly json: boolean
  readonly reviewerModel: string
  readonly coordinatorModel: string
  readonly timeoutSeconds: number
  readonly progress: string
}

const render = (command: ReviewCommandName, result: ReviewResult, json: boolean): Effect.Effect<void> => {
  if (json) return Console.log(JSON.stringify({ schemaVersion: 1, ok: result.complete,
    status: result.complete ? "complete" : "incomplete", command, data: result }, null, 2))
  const active = result.findings.filter((finding) => finding.status === "new" || finding.status === "open")
  return Effect.gen(function* () {
    yield* Console.log(
      `${result.complete ? "Review complete" : "Review incomplete"}: ${reviewText(result.summary, true)}`,
    )
    yield* Console.log(
      `${reviewText(result.branch, true)} against ${reviewText(result.baseRef, true)} (${result.mode})`,
    )
    yield* Console.log(`Cost: ${reviewCost(result.costUsd)} | Cached input: ${cachedInput(result.cachedInputPercent)}`)
    if (active.length === 0) yield* Console.log("\nNo active findings.")
    for (const finding of active) {
      const location =
        finding.location === null
          ? ""
          : ` ${reviewText(finding.location.path, true)}${finding.location.line === null ? "" : `:${finding.location.line}`}`
      yield* Console.log(
        `\n[${finding.severity.toUpperCase()}]${location} ${reviewText(finding.title, true)}\n${reviewText(finding.impact)}\nEvidence: ${reviewText(finding.evidence)}`,
      )
    }
    yield* Console.log(`\nHistory: ${reviewText(result.historyPath, true)}`)
    for (const stage of result.stages) {
      if (stage.error !== null) yield* Console.error(`[${stage.role}] ${stage.error.kind}: ${stage.error.message}`)
    }
  })
}

const renderFailure = (command: string, json: boolean, error: unknown,
  run: { readonly runId: string; readonly historyPath: string } | null = null) => Effect.gen(function* () {
  const diagnostic = reviewDiagnostic(error)
  if (json) yield* Console.log(JSON.stringify({ schemaVersion: 1, ok: false, status: "failed", command, run, error: diagnostic }))
  else yield* Console.error(`hanif-agent: ${diagnostic.message}`)
  yield* Effect.sync(() => { process.exitCode = 1 })
})

const reviewRepositoryPath = (repo: string) => Effect.tryPromise({
  try: () => realpath(repo),
  catch: () => new ReviewRunError({ operation: "resolve review repository", message: "Repository path is unavailable" }),
})

const executeReview = (
  command: ReviewCommandName,
  { coordinatorModel, json, repo, reviewerModel, timeoutSeconds, progress }: ReviewCommandOptions,
  baseRef?: string,
  targetRef?: string,
  retryRunId?: string,
): Effect.Effect<void, never, Review> => {
  let runLocation: { readonly runId: string; readonly historyPath: string } | null = null
  return Effect.gen(function* () {
    const review = yield* Review
    const compact = makeCompactProgressReporter((line) => process.stderr.write(`${line}\n`))
    const onProgress: ReviewProgressReporter = (event) => {
      if (event.type === "run_started") runLocation = { runId: event.runId, historyPath: event.historyPath }
      if (progress === "none") return Effect.void
      if (progress === "json") return Effect.sync(() => {
        process.stderr.write(`${JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), ...event })}\n`)
      })
      return compact(event)
    }
    const result = yield* review.run({
      cwd: repo,
      ...(baseRef === undefined ? {} : { baseRef }),
      ...(targetRef === undefined ? {} : { targetRef }),
      models: ReviewModels.make({
        reviewer: reviewerModel,
        coordinator: coordinatorModel,
      }),
      onProgress,
      timeoutMs: timeoutSeconds * 1_000,
      ...(retryRunId === undefined ? {} : { retryRunId }),
    })
    yield* render(command, result, json)
    yield* Effect.sync(() => { process.exitCode = result.complete ? 0 : 2 })
    if (!json) {
      const clipboard = yield* copyToClipboard(reviewMarkdown(result)).pipe(Effect.either)
      if (Either.isLeft(clipboard)) yield* Console.error(`hanif-agent: ${reviewErrorMessage(clipboard.left)}`)
      else yield* Console.log("\nCopied Markdown review to clipboard.")
    }
  }).pipe(
    Effect.catchAll((error) => renderFailure(command, json, error, runLocation)),
  )
}

const reviewCommand = Command.make(
  "review",
  {
    base: baseOption,
    repo: repoOption,
    json: jsonOption,
    reviewerModel: reviewerModelOption,
    coordinatorModel: coordinatorModelOption,
    timeoutSeconds: timeoutOption,
    progress: progressOption,
  },
  ({ base, ...options }) =>
    executeReview("review", options, Option.isSome(base) ? base.value : undefined),
).pipe(Command.withDescription("Run a reusable adversarial review of the current branch and worktree"))

const reviewWorktreeCommand = Command.make(
  "review-worktree",
  {
    repo: repoOption,
    json: jsonOption,
    reviewerModel: reviewerModelOption,
    coordinatorModel: coordinatorModelOption,
    timeoutSeconds: timeoutOption,
    progress: progressOption,
  },
  (options) => executeReview("review-worktree", options, "HEAD"),
).pipe(Command.withDescription("Review only staged, unstaged, and untracked worktree changes"))

const reviewLastCommitCommand = Command.make(
  "review-lc",
  {
    repo: repoOption,
    json: jsonOption,
    reviewerModel: reviewerModelOption,
    coordinatorModel: coordinatorModelOption,
    timeoutSeconds: timeoutOption,
    progress: progressOption,
  },
  (options) => executeReview("review-lc", options, "HEAD^", "HEAD"),
).pipe(Command.withDescription("Review the last commit against its first parent"))

const inspectCommands = ["review-status", "review-result"].map((command) => Command.make(command, {
  run: Options.text("run"), repo: repoOption, json: jsonOption,
}, ({ run, repo, json }) => Effect.gen(function* () {
  const stored = yield* readReviewRun(run)
  const input = stored.records.find((record) => record.type === "run_started")?.input
  const root = input?.cwd ?? Option.getOrUndefined(Option.map(stored.result, (result) => result.repositoryRoot))
  const repositoryPath = yield* reviewRepositoryPath(repo)
  if (root !== undefined && resolve(root) !== repositoryPath) return yield* new ReviewRunError({
    operation: command, message: "Review run belongs to a different repository; supply its --repo path" })
  const data = { runId: run, status: stored.status, historyPath: stored.historyPath,
    events: stored.records.filter((record) => record.type === "stage_started" || record.type === "attempt_started" || record.type === "attempt_failed")
      .map((record) => ({ type: record.type, at: record.at, role: record.role, attempt: record.attempt,
        timeoutMs: record.timeoutMs, error: record.diagnostic })),
    stages: stored.records.flatMap((record) => record.stage === undefined ? [] : [record.stage]),
    errors: stored.records.flatMap((record) => record.diagnostic === undefined ? [] : [record.diagnostic]),
    result: Option.getOrNull(stored.result) }
  yield* Console.log(JSON.stringify({ schemaVersion: 1, ok: true, command, data }, null, 2))
}).pipe(Effect.catchAll((error) => renderFailure(command, json, error)))).pipe(
  Command.withDescription("Inspect a saved review without launching reviewers"),
))

const retryCommand = Command.make("review-retry", {
  run: Options.text("run"), repo: repoOption, json: jsonOption,
  timeoutSeconds: Options.integer("timeout-seconds").pipe(
    Options.withSchema(Schema.Number.pipe(Schema.int(), Schema.between(1, 3_600))), Options.optional,
  ),
  progress: progressOption,
}, ({ run, repo, json, timeoutSeconds, progress }) => Effect.gen(function* () {
  const stored = yield* readReviewRun(run)
  const input = stored.records.find((record) => record.type === "run_started")?.input
  const repositoryPath = yield* reviewRepositoryPath(repo)
  if (input === undefined || resolve(input.cwd) !== repositoryPath) return yield* new ReviewRunError({
    operation: "retry review run", message: "Run has no retry metadata or belongs to another repository" })
  yield* executeReview("review-retry", { repo, json,
    timeoutSeconds: Option.getOrElse(timeoutSeconds, () => input.timeoutMs / 1_000), progress,
    reviewerModel: input.models.reviewer, coordinatorModel: input.models.coordinator },
    input.baseRef, input.targetRef ?? undefined, run)
}).pipe(Effect.catchAll((error) => renderFailure("review-retry", json, error)))).pipe(
  Command.withDescription("Retry a compatible incomplete run, reusing successful Luna checkpoints"),
)

const preflightCommand = Command.make("review-preflight", {
  repo: repoOption, json: jsonOption, base: baseOption,
  reviewerModel: reviewerModelOption, coordinatorModel: coordinatorModelOption,
}, ({ repo, json, base, reviewerModel, coordinatorModel }) => Effect.gen(function* () {
  const data = yield* reviewPreflight({ cwd: repo,
    ...(Option.isSome(base) ? { baseRef: base.value } : {}),
    models: ReviewModels.make({ reviewer: reviewerModel, coordinator: coordinatorModel }) })
  yield* Console.log(JSON.stringify({ schemaVersion: 1, ok: true, command: "review-preflight", data }, null, 2))
}).pipe(Effect.catchAll((error) => renderFailure("review-preflight", json, error)))).pipe(
  Command.withDescription("Check local review prerequisites without making model calls"),
)

const root = Command.make("hanif-agent", {}, () =>
  Console.log("Use 'hanif-agent --help' to list workflows."),
).pipe(
  Command.withDescription("Personal agent workflows backed by ephemeral Codex threads"),
  Command.withSubcommands([reviewCommand, reviewWorktreeCommand, reviewLastCommitCommand, ...inspectCommands, retryCommand, preflightCommand]),
)

const cli = Command.run(root, { name: "hanif-agent", version: "0.1.0" })
const AppLayer = Layer.merge(Review.layer, BunContext.layer)

cli(process.argv).pipe(
  Effect.catchAll(() => renderFailure("cli", process.argv.includes("--json"), new ReviewRunError({
    operation: "parse review command", message: "Invalid command options; see stderr or run hanif-agent --help",
  }))),
  Effect.provide(AppLayer),
  BunRuntime.runMain,
)
