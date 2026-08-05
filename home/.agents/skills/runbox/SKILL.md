---
name: runbox
description: Use when a project has runbox and an agent needs to test committed work, including a gh-stack top, in the shared managed runner instead of launching package scripts in its own Git worktree.
---

# Runbox

Runbox owns the long-running development processes for a Git repository. Never
launch a package script such as `dev`, `start`, or `storybook` directly from an
agent worktree when the project uses runbox.

## Agent workflow

1. Finish and verify changes that do not require the long-running app.
2. Commit the worktree. Runbox switches exact commits, never uncommitted files.
3. Run the intended command, such as `runbox dev --no-tui --json`, from the agent
   worktree. A direct script command automatically switches the managed runner.
4. Treat a zero exit status as confirmation that setup and all previously active commands restarted successfully.
5. On failure, branch on `error.code`, follow `error.suggestion`, and use logs or doctor for evidence. Do not start the package script locally as a workaround.

## Agent interface

Every JSON command returns one object. Success uses `{ "ok": true, "command":
"...", "data": ... }`. Failure uses `{ "ok": false, "error": { "code",
"message", "operation", "suggestion", "retryable", "details" } }` and exits
non-zero. Never parse human-readable stderr when `--json` is available.

Discover scripts and globally running projects before guessing names:

```sh
runbox commands --json
runbox projects --json
```

Run local commands from the intended package directory. In a monorepo,
`cd apps/operator && runbox dev` selects `apps/operator/package.json`; running from
the repository root selects the root script and may start every workspace service.
Runbox loads `.env` and `.env.local` through the selected package's ancestor package
chain and synchronizes ignored `.env*` files from the configured primary worktree.
Never guess missing credentials in the managed runner; report the missing source
value or ask the user to configure `runbox init --environment-source <path>`.

Read retained output from the current project or from anywhere on the machine:

```sh
runbox logs dev --json
runbox logs example-operator-dev-fe dev --json
runbox logs example-operator-dev-fe setup --json
runbox logs example-operator-dev-fe dev --lines 500 --json
```

The project argument accepts the project name, repo ID, or `name#repoId` key from
`runbox projects --json`. If script names collide in a monorepo, use the full command
ID such as `apps/web:dev`.

Preparation is bounded to five minutes by default and returns
`PREPARATION_TIMEOUT` if OpenCode does not finish. Inspect setup logs before retrying;
`RUNBOX_AGENT_TIMEOUT_MS` can override the deadline when a project legitimately needs
longer setup.

For a later runtime crash, inspect logs first, then restart the tracked command:

```sh
runbox restart dev --json
runbox restart example-operator-dev-fe dev --json
```

Use doctor before manual recovery. It is read-only and does not start a daemon:

```sh
runbox doctor --json
runbox doctor example-operator-dev-fe --json
```

## Stacked branches

When the current branch belongs to a stack managed by `gh stack`, test the complete
stack from its highest active branch:

```sh
gh stack view --json
runbox stack --no-tui --json dev
```

`runbox stack` never checks out or rebases source branches. It fails if any local
stack worktree is dirty or an active branch needs rebasing. Commit changes in the
correct stack layer and run `gh stack rebase` before retrying. Do not bypass the
failure with `runbox switch` or by launching the command locally.

The stack command switches every active runbox command to the top commit, restarts
them, then starts or attaches the requested command. Additional script arguments go
after `--`, for example `runbox stack --no-tui --json dev -- --host 0.0.0.0`.

Runbox invokes GPT-5.6 Luna for project setup, command-specific preparation, and
up to three startup repair attempts. Project instructions live at:

```text
.agents/runbox/setup.md
.agents/runbox/instructions/<command>
.agents/runbox/instructions/<package-path>/<command>
```

Useful noninteractive commands:

```sh
runbox status --json
runbox commands --json
runbox projects --json
runbox logs example-operator-dev-fe dev --json
runbox restart example-operator-dev-fe dev --json
runbox doctor example-operator-dev-fe --json
runbox switch --no-tui --json
runbox switch --no-tui --json --commit-message "fix: describe change"
runbox switch --no-tui --json --agent-commit
runbox stack --no-tui --json dev
runbox stop all --json
```

Do not use `--agent-commit` when the current agent can write an accurate commit
message itself. Do not edit the managed runner under `~/.local/share/runbox`.
