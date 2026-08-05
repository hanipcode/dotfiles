import { Prompt } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import type { ProjectContext } from "./domain.ts"
import { DirtyWorktree, RunboxError } from "./errors.ts"
import { Git } from "./services/Git.ts"
import { Shell } from "./services/Shell.ts"

export interface CommitOptions {
  readonly noTui: boolean
  readonly commitMessage: Option.Option<string>
  readonly agentCommit: boolean
}

const textValues = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return []
  if (Array.isArray(value)) return value.flatMap(textValues)
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, child]) =>
    key === "text" && typeof child === "string" ? [child] : textValues(child),
  )
}

export const generateCommitMessage = Effect.fn("Commit.generateCommitMessage")(function* (project: ProjectContext) {
  const shell = yield* Shell
  const executable = process.env.RUNBOX_OPENCODE_BIN ?? "opencode"
  const result = yield* shell.run([
    executable,
    "run",
    "-m",
    "openai/gpt-5.6-luna",
    "--agent",
    "plan",
    "--format",
    "json",
    "--dir",
    project.repoRoot,
    "Inspect the current git diff and return exactly one concise conventional commit subject. Do not edit files and do not include explanation or markdown.",
  ], { cwd: project.repoRoot, allowFailure: true }).pipe(
    Effect.mapError((error) =>
      new RunboxError({ operation: "generate commit message", message: error.stderr }),
    ),
  )
  if (result.exitCode !== 0) {
    return yield* new RunboxError({
      operation: "generate commit message",
      message: result.stderr || `OpenCode exited with ${result.exitCode}`,
    })
  }
  const values = result.stdout.split("\n").flatMap((line) => {
    try {
      return textValues(JSON.parse(line) as unknown)
    } catch {
      return []
    }
  })
  const message = (values.at(-1) ?? result.stdout).trim().split("\n")[0]?.replace(/^['"`]|['"`]$/g, "")
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
