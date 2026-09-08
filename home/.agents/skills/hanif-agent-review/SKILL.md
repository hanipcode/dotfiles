---
name: hanif-agent-review
description: Run reusable code reviews with the hanif-agent CLI, parallel Luna specialists, and Astra independent review and reconciliation. Use for Luna/Astra reviews, effect-slopcop reviews, or inspecting and retrying a hanif-agent review run.
---

# hanif-agent review

Use the CLI as the review engine. Its reviewers are read-only. The calling agent
owns implementing approved findings; the CLI never fixes code or launches more
calling-agent sessions.

Follow [the one-pass review and human-disposition policy](../code-review/REVIEW-HANDOFF.md).
Present all findings with evidence and recommended dispositions, obtain human approval
before fixes, then verify approved fixes with focused checks. When the separate
`code-review` is also requested, retain both reports; neither replaces the other.

## 1. Pin scope

Choose the command matching the user's requested comparison:

- Branch plus effective worktree: `hanif-agent review --repo REPO --base BASE`.
- Uncommitted work only: `hanif-agent review-worktree --repo REPO`.
- Last committed change only: `hanif-agent review-lc --repo REPO`.

Use an explicit repository path. Resolve an ambiguous base before starting a
branch review; do not substitute worktree or last-commit scope. Check installed
`--help` for current options. If the executable is missing, report the setup gap
rather than silently substituting a different review workflow.

Complete when the command matches the user's repository and requested scope.

## 2. Preflight and launch once

Run `hanif-agent review-preflight --repo REPO --base BASE --json` when setup is
unverified. For worktree scope use `--base HEAD`. Preflight checks local prerequisites,
not provider authentication or model entitlement.

Append `--json --progress json` to the review command. Use the harness's supported
background-command facility so the review can outlive a short tool timeout.
Respect that harness's completion-notification and polling rules; never assume a
particular shell or pane manager is available. Capture stdout separately from
stderr. Record the run ID and history path from stderr's `run_started` event.

Four Luna specialists and Astra's independent review run concurrently. Astra
reconciliation runs afterward. Quiet model reasoning is not evidence of a hung
run. Use heartbeat and attempt events; do not start duplicate reviews. The CLI
already owns bounded retries. Increase `--timeout-seconds` deliberately when
evidence shows the default deadline is insufficient.

Complete when one invocation is running or has produced a terminal result.

## 3. Interpret the execution result before findings

Read the single stdout JSON envelope (`schemaVersion: 1`):

- `status: complete`, exit 0: all required coverage completed. Findings may still
  require work; zero exit does not mean no findings.
- `status: incomplete`, exit 2: inspect `data.stages` for failed Luna coverage.
  Report findings as partial, never as a clean review.
- `status: failed`, exit 1: inspect `error` and `run`; retrieve saved stages when a
  run ID exists. Failure JSON belongs on stdout, not in human progress text.

Preserve finding IDs and distinguish active findings from resolved/suppressed
ones. Luna-final standards findings, including `effect-slopcop/<number>`, are not
subject to Astra adjudication. Human disposition remains explicit for every finding;
general implementation authorization is not approval to fix review findings.

Complete when the report states coverage status and every active finding is
accounted for, even when the findings list is empty.

## 4. Inspect or recover

Use `review-status --repo REPO --run ID --json` or
`review-result --repo REPO --run ID --json` without starting model work. Inspection
`ok` describes lookup success; the run state is `data.status`. Interrupted means
the owner stopped or its heartbeat is stale, not successful completion.

For an incomplete, failed, or interrupted run, use
`review-retry --repo REPO --run ID --json --progress json` when another attempt is
authorized. The CLI reconstructs and verifies scope, snapshot, models, and policy
before reusing successful Luna checkpoints; Astra runs again. An incompatible
retry requires a new review, never manual editing of history. Legacy or expired
history may not be recoverable. Source snapshots are removed after each run.

Ask the human whether to retry missing coverage or proceed with the disclosed limitation.
After approved code fixes, run affected checks and report results without an automatic
review rerun. If the human explicitly requests another review of changed inputs, use a
fresh invocation for that scope rather than recovering the old snapshot.
