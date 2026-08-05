# runbox

Run package scripts from one persistent, detached Git worktree instead of every
agent worktree. Runbox keeps dependencies warm, owns the development ports, and
switches the runner to a committed agent branch on demand.

```sh
runbox init
runbox dev
runbox switch
runbox stack dev
runbox stop dev
runbox stop all
runbox status --json
runbox projects --json
runbox logs my-project dev --json
```

Runbox is personal macOS tooling built with Bun, Effect, `@effect/cli`, OpenTUI
React, and OpenCode using `openai/gpt-5.6-luna`.

## Workflow

Run `runbox init` once from a worktree where the project already runs. The wizard
records general setup guidance, lets you choose package scripts, and writes
preparation instructions for each selected command. Initialization is resumable:
you can leave the generated files uncommitted, commit them yourself, and rerun the
wizard to continue setup. When initialization commits those files, it switches and
prepares the runner at that exact commit before returning, so the selected commands
are immediately usable.

Runbox automatically records Git's primary worktree as the canonical environment
source. Override it with `runbox init --environment-source <path>` when another
worktree owns the valid local environment files. The override must belong to the
same Git repository.

Runbox resolves the nearest `package.json` and detects Bun, pnpm, Yarn, or npm from
the `packageManager` field and lockfiles. A command can receive additional arguments:

```sh
runbox dev -- --host 0.0.0.0
```

In a monorepo, invoke runbox from the package whose script you want. For example,
`cd apps/operator && runbox dev` runs `apps/operator`'s `dev` script without also
starting unrelated root-workspace services.

The first command creates one persistent detached worktree for the Git repository.
Ignored `.env*` files are synchronized from the canonical environment source before
setup and command startup. Matching runner files are refreshed, while runner-only
generated environment files are preserved. Dependencies and build caches remain
local to the runner. Runtime state lives in:

```text
~/.runbox/data/<repo-id>/worktree
~/.runbox/state/<repo-id>/
/tmp/runbox-$UID/<repo-id>.sock
```

Set `RUNBOX_HOME` to override `~/.runbox`. Existing XDG-based installations are
migrated per repository when their daemon is idle; active repositories stay on
their legacy paths until they can move without interrupting commands.

Commands run under a per-repository background supervisor. Closing the TUI only
detaches. Running `runbox dev` from a different clean worktree automatically switches
the runner to that worktree's commit, restarts active commands, and starts or attaches
`dev`. Opening bare `runbox` launches the global dashboard from any directory and never
switches, starts a daemon, creates a runner, or migrates storage implicitly.

The TUI opens immediately and shows `preparing`, `starting`, and repair progress while
the supervisor performs setup in the background. Non-TUI commands wait until the
command reaches a terminal state or is initially classified as running.

## Switching

`runbox switch` requires an exact commit. A dirty worktree offers a manual commit
message, a GPT-5.6 Luna generated message, or cancellation. After committing,
runbox stops every active process tree, checks out the new commit in its detached
runner, prepares the revision, and restarts all previously active commands.
Direct script commands such as `runbox dev` perform this switch automatically;
`runbox switch` remains useful when no command should be launched.

## GitHub stacks

With the [`gh-stack`](https://github.com/github/gh-stack) GitHub CLI extension
installed, `runbox stack <command>` runs the integrated code at the highest active
branch in the current stack:

```sh
runbox stack dev
runbox stack --no-tui --json dev
runbox stack dev -- --host 0.0.0.0
```

Runbox reads the stack through `gh stack view --json`; it never navigates, commits,
or rebases stack branches. It refuses to run when a locally checked-out stack branch
is dirty or an active branch needs rebasing. After validation, it switches every
active command to the top branch's exact HEAD, restarts them, and starts or attaches
the requested command.

The dashboard and JSON state retain the active stack's trunk, ordered branch chain,
top branch and commit, and a stable stack fingerprint. Merged branches remain visible
as provenance but are not eligible as the selected top.

Project-owned prompts are Markdown or plain text:

```text
.agents/runbox/setup.md
.agents/runbox/instructions/dev
.agents/runbox/instructions/apps/web/dev
```

Luna may install dependencies, clean up stale processes, and create ignored or
generated environment state, but it is told never to guess credentials or replace
synchronized values. Runbox rejects tracked and non-ignored source changes.
Each command loads `.env` and `.env.local` from every ancestor directory containing
a `package.json`, from the repository root through the selected package. Nearer
packages override their ancestors, and the invoking shell takes final precedence.
Task runners such as Turbo may additionally need their own environment-forwarding
configuration.

Failures during the stabilization window get up to three Luna repair attempts; later
crashes remain failed for review. The initial running classification defaults to three
seconds and the stabilization window defaults to 180 seconds. Set
`RUNBOX_STARTUP_GRACE_MS` or `RUNBOX_STABILIZATION_MS` to non-negative millisecond
values to override them.
Long preparation streams OpenCode output to the retained setup log and shows one
in-place spinner with elapsed time in interactive commands. Preparation is terminated
after five minutes by
default; set `RUNBOX_AGENT_TIMEOUT_MS` to a positive millisecond value to override it.

Successful preparation is keyed by a fingerprint of tracked setup inputs. Matching
fingerprints skip OpenCode entirely. Changed setups receive two local, append-only
memory files under the repository's Runbox state directory:

```text
run-history.jsonl
instructions.jsonl
```

The history records actual tool calls, exact secret-redacted inputs and commands,
timings, status, output hashes, and bounded redacted previews. Instructions are a
folded living document: later records correct or remove earlier keys without
rewriting history. Inspect them with `runbox logs history --json` and
`runbox logs instructions --json` (or include a global project selector first).

## Agent usage

Automation should use the noninteractive interface and trust its exit status:

```sh
runbox switch --no-tui --json
runbox switch --no-tui --json --commit-message "fix: repair checkout"
runbox stack --no-tui --json dev
runbox status --json
runbox commands --json
runbox projects --json
runbox logs sample-web-app dev --json
runbox restart sample-web-app dev --json
runbox doctor sample-web-app --json
```

JSON is a stable envelope. Successful commands return:

```json
{
  "ok": true,
  "command": "logs",
  "data": {}
}
```

Failures exit non-zero and include a stable code plus the next action:

```json
{
  "ok": false,
  "error": {
    "code": "COMMAND_NOT_TRACKED",
    "message": "project has no tracked command",
    "operation": "resolve tracked command",
    "suggestion": "Start the command, then retry logs.",
    "retryable": false,
    "details": null
  }
}
```

## Global registry and logs

Runbox state is partitioned by Git common directory, so agents can inspect projects
without changing directories:

```sh
runbox projects --json
runbox logs <project> <command> --json
runbox restart <project> <command> --json
runbox doctor <project> --json
```

`projects` lists the stable `name#repoId` key, repository path, canonical environment
source, active source, all
tracked commands, and commands whose process is currently alive. `logs` accepts the
project name, repo ID, or stable key. A command can be a unique script name or its
full monorepo ID such as `apps/web:dev`. Use `setup` as the command to retrieve Luna's
setup transcript. `--lines` limits returned output and defaults to 200 lines.

`commands --json` lists scripts from the nearest `package.json`, their detected
package manager, and whether each has a runbox preparation instruction. `doctor` is
read-only: it checks the package manager, OpenCode, gh-stack, runner, instructions,
daemon socket, state paths, and stale process records without starting anything.

The personal `runbox` agent skill tells coding agents to commit their work and use
this path instead of launching long-running package scripts in their own worktrees.

## Global dashboard

The default OpenTUI dashboard lists every repository known through current or legacy
Runbox state. It keeps the canonical environment source, active execution source,
managed runner, worktrees, stack provenance, packages, and commands distinct. Merely
browsing the dashboard is passive: worktrees and package manifests are inspected lazily,
retained logs are read from disk, and existing daemons are only pinged.

Selecting another worktree does not switch the runner. Running a script or explicitly
switching first displays an action plan with every repository command that will restart.
The plan is rejected if the state or selected HEAD changes before confirmation. Dirty
worktrees offer a manual commit message, a Luna-generated message, or cancellation.
Legacy storage migration is included in the plan and still follows the existing rule
that active repositories are not interrupted.

Direct commands such as `runbox dev` open the same global dashboard focused on that
command while activation proceeds. Active gh-stack provenance is displayed as a source;
use `runbox stack <command>` to select and activate a stack.

```text
tab                  move between repository, source, and command panes
j/k or arrows        move within the focused pane
enter                inspect the selected repository, source, or command
/ or ctrl+p          search visible repositories, worktrees, packages, and commands
?                    show contextual keyboard help
r                    review running the selected script
x                    review switching to the selected worktree
s                    review stopping the selected command
R                    review restarting the selected command
escape               close a plan or command detail
q                    detach
```
