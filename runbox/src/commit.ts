import { Prompt } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import type { ProjectContext } from "./domain.ts"
import { DirtyWorktree, RunboxError } from "./errors.ts"
import { Git } from "./services/Git.ts"
import { OpenCode } from "./services/OpenCode.ts"

export interface CommitOptions {
  readonly noTui: boolean
  readonly commitMessage: Option.Option<string>
  readonly agentCommit: boolean
}

export const generateCommitMessage = Effect.fn("Commit.generateCommitMessage")(function* (project: ProjectContext) {
  const openCode = yield* OpenCode
  const result = yield* openCode.run({
    directory: project.repoRoot,
    model: "openai/gpt-5.6-luna",
    agent: "plan",
    prompt: "Inspect the current git diff and return exactly one concise conventional commit subject. Do not edit files and do not include explanation or markdown.",
  })
  const message = result.records.flatMap((record) => record.type === "text" ? [record.text] : [])
    .at(-1)?.trim().split("\n")[0]?.replace(/^['"`]|['"`]$/g, "")
  if (message === undefined || message === "") {
    return yield* new RunboxError({ operation: "generate commit message", message: "Luna returned no commit subject" })
  }
  return message
})

export const ensureCommitted = Effect.fn("Commit.ensureCommitted")(function* (
  project: ProjectContext,
  options: CommitOptions,
) {
  const git = yield* Git
  const summary = yield* git.dirty(project)
  if (summary === "") return false

  let message: string
  if (Option.isSome(options.commitMessage)) {
    message = options.commitMessage.value
  } else if (options.agentCommit) {
    yield* Console.error("Generating commit message with GPT-5.6 Luna...")
    message = yield* generateCommitMessage(project)
  } else if (options.noTui || !process.stdin.isTTY) {
    return yield* new DirtyWorktree({ path: project.repoRoot, summary })
  } else {
    const choice = yield* Prompt.select({
      message: `Worktree has uncommitted changes:\n${summary}`,
      choices: [
        { title: "Commit with my message", value: "manual" as const },
        { title: "Commit with Luna message", value: "agent" as const },
        { title: "Cancel", value: "cancel" as const },
      ],
    })
    if (choice === "cancel") {
      return yield* new RunboxError({ operation: "commit changes", message: "cancelled" })
    }
    message = choice === "agent"
      ? yield* Console.error("Generating commit message with GPT-5.6 Luna...").pipe(
        Effect.zipRight(generateCommitMessage(project)),
      )
      : yield* Prompt.text({
          message: "Commit message",
          validate: (value) => value.trim() === ""
            ? Effect.fail("Commit message cannot be empty")
            : Effect.succeed(value.trim()),
        })
  }
  yield* git.commit(project, message).pipe(
    Effect.mapError((error) =>
      new RunboxError({ operation: "commit changes", message: error.message }),
    ),
  )
  return true
})
