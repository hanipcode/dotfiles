---
name: herdr-managed-agent
description: "Work as a managed worker under a herdr orchestrator agent — report state by prompting it, decide inside your scope and escalate outside it, stay off the runbox lease, and leave push/PR to the orchestrator. Use when a prompt says you are managed or orchestrated by another agent, names an orchestrator to report to, or briefs you as a worker in a herdr worktree. Requires HERDR_ENV=1."
---

# Herdr managed agent

You are a **worker**: one agent on one branch in one herdr worktree, managed by an orchestrator. Your brief named it and its pane id.

```bash
test "${HERDR_ENV:-}" = 1
```

If that fails you are not running inside Herdr and nothing is managing you — ignore this skill.

The `herdr` skill is the authority on CLI syntax. Read it rather than guessing flags.

## Report without being asked

Your orchestrator cannot see your pane unless it looks. Push each state change to it:

```bash
herdr agent prompt <orchestrator> "<your-name>: DONE|BLOCKED|QUESTION|SCOPE-CHANGE — one line"
```

Keep it to one line. The orchestrator reads your pane for the detail. Report on every one of these:

- **DONE** — the brief's "Done means" commands pass. Say which.
- **BLOCKED** — you cannot proceed. Say what would unblock you.
- **QUESTION** — you need a decision before continuing.
- **SCOPE-CHANGE** — what you are building is no longer what the brief said, including when the user redirected you in your own pane. An orchestrator deciding on a stale model is worse than one waiting.

If the orchestrator's name stops resolving it was restarted. Fall back to its pane id, then `herdr agent list` to find the agent now occupying that pane.

## Decide inside your scope, escalate outside it

Decide anything the brief's task covers, and do not ask permission to start.

Escalate before you change a **frozen interface**, edit a file the brief listed as another worker's **boundary**, alter a shared contract or generated artifact, or depart from the plan. Ask; do not edit and mention it afterwards. A sibling worker is compiling against what you were given.

If the work genuinely needs a file outside your boundary, say so and wait. Reaching across is how two workers silently overwrite each other.

## Hands off the runner

Never run `runbox dev`, `runbox sync`, `runbox switch`, or `runbox stack`. One runner and one watcher exist per repository, so starting one yanks it from another worktree.

Ask your orchestrator to point the runner at your worktree, and say what you need to see. Do not start the package script locally as a workaround — the `runbox` skill's failure paths apply to your orchestrator, not to you.

## Hands off the remote

Commit on your own branch as often as you like. Do not push, open or update a PR, merge, or run any `gh stack` command — your orchestrator sequences those across every branch in flight.
