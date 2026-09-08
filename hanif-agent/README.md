# hanif-agent

Personal agent workflows backed by ephemeral Codex threads.

```sh
hanif-agent review
hanif-agent review --base main
hanif-agent review --repo ~/Projects/example --json
hanif-agent review-worktree
hanif-agent review-lc
```

The review command compares the merge base with the current effective worktree.
Four specialist Luna reviewers and an independent Astra reviewer start concurrently.
Luna checks correctness, security, documentation, and applicable standards; Astra
independently reviews every changed path for security, correctness, goals, and
architecture without seeing Luna's evidence. After both finish, a separate Astra
invocation reconciles its independent findings with eligible Luna findings and
cross-domain seam notes. Reconciliation verifies conflicts and new evidence rather
than routinely repeating the full inspection. Independent findings cannot be
silently dropped by reconciliation. Standards, documentation, and repository-standard
findings remain Luna-final and are never sent to Astra. The defaults are
`openai/gpt-5.6-luna#high` and `openai/gpt-6-astra#high`.
Repository standards are
discovered from inert copies of the target base revision's tracked guidance, so
root review files and linked playbooks work from the main checkout or a Git
worktree without activating repository agent configuration.
Changes over 12 paths, 1,200 changed lines, or 64 KiB receive bounded semantic
navigation units to make a large patch easier to inspect without creating extra
reviewer sessions.

For Effect projects, Luna's two standards specialists also apply the
**effect-slopcop** review policy in `src/review/effect-slopcop.ts`. Its 19 rules
cover schema-first modeling, Option, exhaustive matching, typed error recovery,
immutable collections, helper cleanup, adapter boundaries, and service composition.
Reviewers establish applicability per package and verify the pinned Effect APIs.
Findings cite `effect-slopcop/<number>` and remain Luna-final; reviewers recommend
fixes without modifying the repository.

Reviewer threads run with `codex exec --ephemeral`, so they are never attached to
the reviewed project or retained in Codex session history. User and project rules
and Codex configuration are ignored for these isolated reviewer invocations.

`review-worktree` runs the same review pipeline against `HEAD`, so it reviews only
staged, unstaged, and untracked changes. It excludes changes already committed on
the current branch and does not accept `--base`.

`review-lc` reviews exactly `HEAD^..HEAD`, using the committed `HEAD` tree as its
immutable source. Staged, unstaged, and untracked changes are excluded. For a merge
commit, `HEAD^` means its first parent. The command does not accept `--base`.

CallDiff call-flow changes are captured as optional syntactic evidence for Luna's
correctness review and Astra's architecture review. CallDiff failures do not fail a
review, and reviewers must verify its output against the immutable source tree.

A paste-ready Markdown report is copied to the macOS clipboard after each
interactive result. JSON mode never accesses the clipboard. Compact stage and safe tool activity is streamed to stderr while
the review runs, keeping final output and `--json` on stdout. The terminal,
Markdown, and JSON outputs include the runtime-reported cost and prompt-cache
percentage for the run. Codex currently reports no USD cost for ephemeral CLI
runs. Completed results are retained as
append-only JSONL under `/tmp/agentic-review` and reused by later runs on the same
repository branch. Immutable source snapshots and review context exist only while
a review is running and are removed afterward.

## Calling from an agent

```sh
hanif-agent review-preflight --repo /path/to/repo --base main --json
hanif-agent review --repo /path/to/repo --base main --json --progress json
hanif-agent review-worktree --repo /path/to/repo --json --progress json
hanif-agent review-lc --repo /path/to/repo --json --progress json
```

Use the calling agent's background-command facility for long runs. `run_started`
on stderr includes the run ID and history path. `--progress text|json|none`
controls stderr; JSON progress is one versioned event per line. Tool activity is
parsed while Codex runs, not replayed after it exits. Heartbeats arrive every 15
seconds after snapshot setup. Quiet output is not permission to launch a duplicate
review. Reviewers never modify the source repository.

Preflight checks local Codex flags, model identifier syntax, the Git scope, and
trusted skill availability without making model calls. It does **not** verify
provider authentication or account access to a model. Use `--base HEAD` to check a
worktree review's base. Preflight captures and removes a temporary snapshot.

### Result contract

Execution results use one JSON object on stdout, including expected failures:

- `schemaVersion: 1` identifies the envelope.
- `status: complete | incomplete | failed` describes execution, not finding severity.
- Complete/incomplete responses contain `data`: the review result, run ID,
  per-stage model, attempts, duration, coverage, sanitized diagnostics, and history path.
- Failed responses contain a bounded `error` and `run` location when snapshot setup
  reached run registration. Partial stage outputs remain inspectable in history.
- Exit `0` means all required review stages completed, even when there are findings.
- Exit `2` means incomplete Luna coverage; partial findings are still returned.
- Exit `1` means execution failed, including failed Astra coverage or incompatible retry.

An empty findings list is not a clean review unless `status` is `complete`.
Unknown Codex USD cost is currently reported as zero, not a measured free run.
Cache hits perform no reviewer calls and have no newly measured stage timings.

### Inspect and retry

```sh
hanif-agent review-status --repo /path/to/repo --run RUN_ID --json
hanif-agent review-result --repo /path/to/repo --run RUN_ID --json
hanif-agent review-retry --repo /path/to/repo --run RUN_ID --json --progress json
```

Inspection never launches reviewers. Its `ok` means the lookup succeeded;
`data.status` reports `running`, `complete`, `incomplete`, `failed`, or `interrupted`.
Both inspection commands expose stage metadata, attempt events, errors, and the
final result when present. Dead owners and heartbeats older than 60 seconds are
reported as interrupted rather than running forever. History is an expendable
local cache; missing or legacy retry metadata requires a fresh review.

Retry reconstructs the current snapshot and checks repository, branch, base,
target, effective tree, models, prompt version, and trusted policy digest against
the original run. Only successful, coverage-validated Luna stages are reused.
Astra independently reviews again and then reconciles fresh evidence. Changed
inputs require a new review; old Sol histories are never rewritten or reused as
Astra checkpoints. Source snapshots do not need to be retained for recovery.

Retry keeps the original deadline unless `--timeout-seconds` overrides it.
`--timeout-seconds` sets each reviewer attempt's deadline (default 600, range
1–3600). Execution failures receive at most one runtime retry; invalid structured
output receives at most one application retry. Their nested budgets allow at most
four process attempts per stage. Timeout and cancellation kill the reviewer process
group, including its subprocess tools. Tune the deadline rather than disabling it.

The `hanif-agent-review` skill documents scope selection, background execution,
result interpretation, and compatible retry for calling agents.
