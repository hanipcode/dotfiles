import { Schema } from "effect"
import type { CommandRecord } from "./domain.ts"

export class RunboxError extends Schema.TaggedError<RunboxError>()(
  "RunboxError",
  {
    operation: Schema.String,
    message: Schema.String,
    code: Schema.String.pipe(Schema.optionalWith({ default: () => "RUNBOX_ERROR" })),
    suggestion: Schema.NullOr(Schema.String).pipe(Schema.optionalWith({ default: () => null })),
    retryable: Schema.Boolean.pipe(Schema.optionalWith({ default: () => false })),
    details: Schema.NullOr(Schema.String).pipe(Schema.optionalWith({ default: () => null })),
  },
) {}

export interface ErrorInfo {
  readonly code: string
  readonly message: string
  readonly operation: string
  readonly suggestion: string
  readonly retryable: boolean
  readonly details: string | null
}

/** Restore the original startup failure; older command records use a generic fallback. */
export const commandFailureError = (record: CommandRecord): RunboxError =>
  new RunboxError(record.failure ?? {
    operation: `start ${record.script}`,
    message: record.message ?? "Command failed during startup",
    code: "COMMAND_FAILED",
    suggestion: "Inspect the retained command log and retry after correcting the startup failure.",
    retryable: true,
    details: record.logFile,
  })

const runboxErrorInfo = (error: RunboxError): ErrorInfo => {
  if (error.code !== "RUNBOX_ERROR") {
    return {
      code: error.code,
      message: error.message,
      operation: error.operation,
      suggestion: error.suggestion ?? "Run 'runbox doctor --json' for a diagnostic report.",
      retryable: error.retryable,
      details: error.details,
    }
  }
  const value = `${error.operation} ${error.message}`.toLowerCase()
  if (value.includes("needs rebasing") || value.includes("gh stack rebase")) {
    return {
      code: "STACK_NEEDS_REBASE",
      message: error.message,
      operation: error.operation,
      suggestion: "Run 'gh stack rebase', resolve any conflicts, then retry the runbox stack command.",
      retryable: true,
      details: null,
    }
  }
  if (value.includes("stack worktrees are dirty")) {
    return {
      code: "STACK_DIRTY",
      message: error.message,
      operation: error.operation,
      suggestion: "Commit every listed stack worktree, rebase the stack, then retry.",
      retryable: true,
      details: null,
    }
  }
  if (value.includes("not part of a stack") || value.includes("not in a stack")) {
    return {
      code: "NOT_IN_STACK",
      message: error.message,
      operation: error.operation,
      suggestion: "Run this command from a gh-stack branch, or use 'runbox switch' for a normal worktree.",
      retryable: false,
      details: null,
    }
  }
  if (value.includes("gh-stack is unavailable") || value.includes("enoent") && value.includes("gh")) {
    return {
      code: "GH_STACK_UNAVAILABLE",
      message: error.message,
      operation: error.operation,
      suggestion: "Install it with 'gh extension install github/gh-stack' and confirm it appears in 'gh extension list'.",
      retryable: true,
      details: null,
    }
  }
  if (value.includes("another worktree") || value.includes("runbox switch") || value.includes("attached to a stack")) {
    return {
      code: "RUNNER_SOURCE_MISMATCH",
      message: error.message,
      operation: error.operation,
      suggestion: "Use 'runbox switch --no-tui --json' or 'runbox stack --no-tui --json <command>' to activate this source.",
      retryable: true,
      details: null,
    }
  }
  if (value.includes("daemon")) {
    return {
      code: "DAEMON_UNAVAILABLE",
      message: error.message,
      operation: error.operation,
      suggestion: "Run 'runbox doctor --json'. If the daemon is stale, run 'runbox stop all --json' and retry.",
      retryable: true,
      details: error.details,
    }
  }
  if (value.includes("opencode") || value.includes("prepare")) {
    return {
      code: "PREPARATION_FAILED",
      message: error.message,
      operation: error.operation,
      suggestion: "Inspect 'runbox logs setup --json' and the project's .agents/runbox instructions, then retry.",
      retryable: true,
      details: error.details,
    }
  }
  return {
    code: "RUNBOX_ERROR",
    message: error.message,
    operation: error.operation,
    suggestion: "Run 'runbox doctor --json' and inspect 'runbox status --json'.",
    retryable: false,
    details: error.details,
  }
}

export const toErrorInfo = (error: unknown): ErrorInfo => {
  if (error instanceof RunboxError) return runboxErrorInfo(error)
  if (error instanceof DirtyWorktree) {
    return {
      code: "DIRTY_WORKTREE",
      message: `worktree has uncommitted changes: ${error.path}`,
      operation: "commit source worktree",
      suggestion: "Commit the changes, or pass --commit-message or --agent-commit to switch noninteractively.",
      retryable: true,
      details: error.summary,
    }
  }
  if (error instanceof ScriptNotFound) {
    return {
      code: "SCRIPT_NOT_FOUND",
      message: `package script '${error.script}' does not exist`,
      operation: "resolve package script",
      suggestion: "Run 'runbox commands --json' to list scripts for the nearest package.json.",
      retryable: false,
      details: error.packagePath,
    }
  }
  if (error instanceof AgentMutation) {
    return {
      code: "AGENT_MUTATION_REJECTED",
      message: "OpenCode changed protected Git state while preparing the runner",
      operation: "prepare managed runner",
      suggestion: "Review .agents/runbox instructions so setup only changes ignored environment state.",
      retryable: false,
      details: error.summary,
    }
  }
  if (error instanceof InvalidState) {
    return {
      code: "INVALID_STATE",
      message: error.message,
      operation: "load runbox state",
      suggestion: "Run 'runbox doctor --json'. If unrecoverable, remove only the reported runbox state file and retry.",
      retryable: false,
      details: error.path,
    }
  }
  if (error instanceof CommandFailed) {
    return {
      code: "COMMAND_FAILED",
      message: `${error.command} exited with ${error.exitCode}`,
      operation: "execute external command",
      suggestion: "Inspect stderr and run 'runbox doctor --json' before retrying.",
      retryable: true,
      details: error.stderr,
    }
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
  ) {
    return {
      code: "INVALID_ARGUMENT",
      message: `invalid runbox command line (${error._tag})`,
      operation: "parse command line",
      suggestion: "Run 'runbox --help' or 'runbox <command> --help', then retry with the required arguments.",
      retryable: false,
      details: null,
    }
  }
  const message = typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error)
  return {
    code: "INTERNAL_ERROR",
    message,
    operation: "runbox",
    suggestion: "Run 'runbox doctor --json' and inspect the daemon log reported there.",
    retryable: false,
    details: null,
  }
}

export class CommandFailed extends Schema.TaggedError<CommandFailed>()(
  "CommandFailed",
  {
    command: Schema.String,
    cwd: Schema.String,
    exitCode: Schema.Number,
    stderr: Schema.String,
  },
) {}

export class InvalidState extends Schema.TaggedError<InvalidState>()(
  "InvalidState",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class DirtyWorktree extends Schema.TaggedError<DirtyWorktree>()(
  "DirtyWorktree",
  {
    path: Schema.String,
    summary: Schema.String,
  },
) {}

export class ScriptNotFound extends Schema.TaggedError<ScriptNotFound>()(
  "ScriptNotFound",
  {
    script: Schema.String,
    packagePath: Schema.String,
  },
) {}

export class AgentMutation extends Schema.TaggedError<AgentMutation>()(
  "AgentMutation",
  {
    summary: Schema.String,
  },
) {}
