---
name: runbox
description: Use when a project has runbox and an agent needs to sync uncommitted changes, run or watch a package script, execute an arbitrary one-off command, or activate a gh-stack top in the shared managed runner.
---

# Runbox

Runbox owns the long-running development processes for a Git repository. Never
launch a package script such as `dev`, `start`, or `storybook` directly from an
agent worktree when the project uses runbox.

## Agent workflow

1. Finish and verify changes that do not require the long-running app.
2. For exact committed testing, commit the worktree and use a normal Runbox command.
   For deliberate dirty-worktree testing, use `runbox sync` or a script with `-w`.
3. Run the intended command, such as `runbox dev --no-tui --json` or
   `runbox dev -w --no-tui --json`, from the agent worktree.
4. Treat a zero exit status as confirmation that setup and all previously active commands restarted successfully.
5. On failure, branch on `error.code`, follow `error.suggestion`, and use logs or doctor for evidence. Do not start the package script locally as a workaround.

## Source synchronization

Use `runbox sync --json` to copy the invoking worktree's tracked changes, deletions,
and non-ignored untracked files into the managed runner without committing. Sync may
activate that worktree. It never copies ignored dependencies, caches, generated
output, or ignored `.env*`; those remain runner-local or owned by canonical
environment synchronization.

Use `-w` when a long-running package script already provides file watching or HMR:

```sh
runbox dev -w --no-tui --json
runbox dev -w --no-tui --json -- --host 0.0.0.0
```

Runbox owns one watcher per repository, not one per command. Moving from watched
worktree A to B keeps the existing dev PID, closes A's watcher, cleans A's overlay,
applies B's committed and uncommitted files, and starts one watcher for B. Later A
events are ignored. Stop the last watched command to close the watcher.

The watcher is only an invalidation signal; Git reconciliation is authoritative.
Completion of `runbox sync` requires a successful final JSON result. Watch mode is
healthy only when `runbox status --json` reports `data.sync.mode` as `watch` and its
phase as `watching`.

On sync/watch failure, inspect:

```sh
runbox status --json
runbox logs sync --json
```

Never copy files into the managed runner manually. `SYNC_DESTINATION_CONFLICT` means
an untracked source path would overwrite unowned runner state. `SYNC_SOURCE_CHANGED`
is retryable after refreshing the worktree HEAD. `SYNC_SUBMODULE_DIRTY` requires
handling the submodule separately. `SYNC_ROLLBACK_FAILED` means Runbox stopped
commands because neither source could be restored safely; repair the source and run
`runbox sync --json` before restarting. Watch failures do not justify launching the
package script locally.

## One-off commands

Use `forward` for synchronous work that should run once in the managed runner, such
as dependency installation, a build, a non-watch test, code generation, or a
migration. Pass the complete argv; Runbox performs no package-manager inference or
shell parsing:

```sh
runbox forward pnpm install
runbox forward --no-tui --json -- pnpm test --filter operator
runbox forward --no-tui --json -- env CI=1 pnpm test --run
```

Use a direct script command such as `runbox dev` for a long-running process that
Runbox should track, restart, repair, and show in the dashboard. `forward` waits,
streams output in human mode, returns the child's exit status, and creates no
tracked command. It has no stdin, so pass noninteractive flags. Use an explicit
shell such as `runbox forward -- sh -lc 'first | second'` only when shell behavior
is intentional.

Invoke `forward` from the intended package directory. It switches to the invoking
worktree's committed HEAD, runs in that package inside the managed runner, and
restarts active commands as part of the switch. Durable source changes made there
do not flow back to the agent worktree.

Agents should use `--no-tui --json`. Completion requires the final result, not an
expected output line. On failure, inspect `error.code`, `data.started` or error
details, and `error.retryable`. Never blindly retry a side-effecting command after
it starts or when startup is unknown.
Read its retained evidence first:

```sh
runbox logs forward --json
runbox logs sample-web-app forward --json
```

`FORWARDED_COMMAND_FAILED` means the child ran and exited nonzero;
`FORWARD_INTERRUPTED` means it may have produced partial side effects. A transport
failure after the start frame also requires inspecting the forward log before a
retry. `FORWARD_EXECUTABLE_NOT_FOUND` means the full command or runner setup must be
corrected. `FORWARD_LOG_INCOMPLETE` is a warning: trust the child exit status and do
not rerun solely to recreate a log.

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
runbox logs sample-web-app dev --json
runbox logs sample-web-app setup --json
runbox logs sample-web-app dev --lines 500 --json
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
runbox restart sample-web-app dev --json
```

Use doctor before manual recovery. It is read-only and does not start a daemon:

```sh
runbox doctor --json
runbox doctor sample-web-app --json
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
runbox logs sample-web-app dev --json
runbox restart sample-web-app dev --json
runbox doctor sample-web-app --json
runbox switch --no-tui --json
runbox switch --no-tui --json --commit-message "fix: describe change"
runbox switch --no-tui --json --agent-commit
runbox stack --no-tui --json dev
runbox dev -w --no-tui --json
runbox sync --json
runbox forward --no-tui --json -- pnpm install --frozen-lockfile
runbox stop all --json
```

Do not use `--agent-commit` when the current agent can write an accurate commit
message itself. Do not edit the managed runner under `~/.local/share/runbox`.
