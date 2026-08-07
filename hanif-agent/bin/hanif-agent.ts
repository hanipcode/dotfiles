#!/usr/bin/env bun

import { Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Either, Layer, Option } from "effect"
import { copyToClipboard } from "../src/clipboard.ts"
import { reviewErrorMessage } from "../src/errors.ts"
import { ReviewModels, type ReviewResult } from "../src/review/domain.ts"
import { reviewMarkdown, reviewText } from "../src/review/presentation.ts"
import { Review } from "../src/review/review.ts"

const baseOption = Options.text("base").pipe(Options.optional)
const repoOption = Options.text("repo").pipe(Options.withDefault(process.cwd()))
const jsonOption = Options.boolean("json")
const reviewerModelOption = Options.text("reviewer-model").pipe(Options.withDefault("openai/gpt-5.6-luna"))
const coordinatorModelOption = Options.text("coordinator-model").pipe(Options.withDefault("openai/gpt-5.6-sol"))

const render = (result: ReviewResult, json: boolean): Effect.Effect<void> => {
  if (json) return Console.log(JSON.stringify({ ok: true, command: "review", data: result }, null, 2))
  const active = result.findings.filter((finding) => finding.status === "new" || finding.status === "open")
  return Effect.gen(function* () {
    yield* Console.log(`${result.complete ? "Review complete" : "Review incomplete"}: ${reviewText(result.summary, true)}`)
    yield* Console.log(`${reviewText(result.branch, true)} against ${reviewText(result.baseRef, true)} (${result.mode})`)
    if (active.length === 0) yield* Console.log("\nNo active findings.")
    for (const finding of active) {
      const location = finding.location === null
        ? ""
        : ` ${reviewText(finding.location.path, true)}${finding.location.line === null ? "" : `:${finding.location.line}`}`
      yield* Console.log(`\n[${finding.severity.toUpperCase()}]${location} ${reviewText(finding.title, true)}\n${reviewText(finding.impact)}\nEvidence: ${reviewText(finding.evidence)}`)
    }
    yield* Console.log(`\nHistory: ${reviewText(result.historyPath, true)}`)
  })
}

const reviewCommand = Command.make(
  "review",
  {
    base: baseOption,
    repo: repoOption,
    json: jsonOption,
    reviewerModel: reviewerModelOption,
    coordinatorModel: coordinatorModelOption,
  },
  ({ base, coordinatorModel, json, repo, reviewerModel }) => Effect.gen(function* () {
    const review = yield* Review
    const result = yield* review.run({
      cwd: repo,
      ...(Option.isSome(base) ? { baseRef: base.value } : {}),
      models: ReviewModels.make({ reviewer: reviewerModel, coordinator: coordinatorModel }),
    })
    const clipboard = yield* copyToClipboard(reviewMarkdown(result)).pipe(Effect.either)
    yield* render(result, json)
    if (Either.isLeft(clipboard)) {
      yield* Console.error(`hanif-agent: ${reviewErrorMessage(clipboard.left)}`)
    } else if (!json) {
      yield* Console.log("\nCopied Markdown review to clipboard.")
    }
  }).pipe(
    Effect.catchAll((error) => (json
      ? Console.error(JSON.stringify({ ok: false, error: reviewErrorMessage(error) }, null, 2))
      : Console.error(`hanif-agent: ${reviewErrorMessage(error)}`)).pipe(
        Effect.tap(() => Effect.sync(() => { process.exitCode = 1 })),
      )),
  ),
).pipe(Command.withDescription("Run an incremental adversarial review of the current branch and worktree"))

const root = Command.make("hanif-agent", {}, () => Console.log("Use 'hanif-agent review --help' to run a workflow.")).pipe(
  Command.withDescription("Personal agent workflows backed by OpenCode"),
  Command.withSubcommands([reviewCommand]),
)

const cli = Command.run(root, { name: "hanif-agent", version: "0.1.0" })
const AppLayer = Layer.merge(Review.layer, BunContext.layer)

cli(process.argv).pipe(Effect.provide(AppLayer), BunRuntime.runMain)
