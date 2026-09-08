---
name: herdr-agent-orchestrator
description: "Orchestrate work across herdr worktree agents — spawn a worker per branch or stack layer, brief it, arbitrate the runbox lease, fan in results, and route the user to a worker. Use when the user asks you to orchestrate or delegate work across herdr worktrees, to act as orchestrator over worktree agents, or to decide which worktree runbox runs. Requires HERDR_ENV=1."
---

# Herdr agent orchestrator

You manage **workers**: coding agents, one per branch, each in its own herdr worktree. You plan, brief, arbitrate, and verify. You do not write the code.

## Preflight

```bash
test "${HERDR_ENV:-}" = 1
```

If that fails, say you are not running inside Herdr and stop.

The `herdr` skill is the authority on CLI syntax and the `runbox` skill on the runner. Read them for flags and semantics; this skill covers only what orchestration adds.

Name yourself first, so a worker can prompt you back:

```bash
herdr agent rename "$HERDR_PANE_ID" orchestrator
```

Keep `$HERDR_PANE_ID` — every **brief** carries it. An agent name is cleared when that agent exits or is replaced; a pane id survives.

## You do not code

Read anything, plan, verify, review. Never edit a file inside a worker's worktree — a one-line fix still goes to the worker that owns that **boundary**, or two writers race on one branch. Your own worktree holds planning artifacts only.

## Spawn one worker per branch

```bash
herdr worktree create --workspace <repo-parent-workspace> --branch <branch> --base <ref> --no-focus
# read .result.workspace, .result.tab, .result.root_pane, and the worktree path
herdr agent start <worker-name> --kind <your-own-kind> --pane <root_pane_id> [-- <bypass-flag>]
herdr agent prompt <worker-name> "<brief>"
herdr agent get <worker-name>          # status must be working — the brief landed
```

`worktree create` runs only from the repo's parent workspace. Called from inside a linked worktree it fails with `linked_worktree_source`, so pass the parent's `--workspace` — read it from `herdr worktree list` as `source_workspace_id`.

**Spawn your own kind.** A `claude` orchestrator spawns `claude` workers, an `opencode` orchestrator spawns `opencode` workers. Read your kind off yourself rather than assuming it — `herdr agent get "$HERDR_PANE_ID"` returns it as `.result.agent.agent`. Only a kind the user explicitly names overrides this.

**Bypass the worker's permission prompts.** A worker that stops to approve its own tool calls is a stalled worker: nobody is watching its pane, and it reports `blocked` for a reason that has nothing to do with the work. How depends on the kind:

- `claude` — pass `-- --dangerously-skip-permissions`.
- `opencode` — no flag exists; permissions come from `opencode.json`. It can still block on paths that config marks `ask`, so read the pane instead of assuming the work itself stalled.

If you inherit a worker that blocks on an approval prompt, restart it with the bypass and re-send the brief; the fresh session remembers nothing.

Name for the layer, not the person — `l1-contract`, `mpcs`, `gpcs`. Names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live agents.

Never pass `--wait` on a spawn prompt. It holds your turn for the length of the worker's task, and the user cannot reach you while it holds. Confirm delivery with `agent get` instead.

Parallel workers need a **frozen interface** before any of them starts — the exact names, types, and signatures each layer exposes or consumes. Freeze it in the plan, restate it in every brief. Without it, siblings block on each other or invent conflicting versions of the same seam.

## The brief

A worker boots with zero context, so the brief is the entire handoff. Send it as the prompt text, and keep the text in your own scratchpad directory so a restarted worker can be re-briefed verbatim. Never write it as a file in the worker's worktree: `runbox sync` copies non-ignored untracked files into the managed runner, so a stray brief leaks into whatever is running.

```
Load the `herdr-managed-agent` skill now, before anything else.

You are worker `<worker-name>`, working in <worktree-path> on branch <branch>
(based on <ref>). Your orchestrator is `<orchestrator-name>` at pane
<orchestrator-pane-id>.

Task: <what to build, in enough detail that no clarifying question is needed
to start>

Frozen interface: <the names, types, and signatures this layer must expose or
consume, verbatim>

Boundaries: <files and directories owned by sibling workers — do not edit them.
Ask instead.>

Done means: <the commands that must pass, e.g. the exact test invocations>

Report by prompting me:
  herdr agent prompt <orchestrator-name> "<worker-name>: DONE|BLOCKED|QUESTION|SCOPE-CHANGE — one line"

The orchestrator owns phone notifications; report to it rather than sending duplicate alerts.
```

Every part filled, and the frozen interface concrete enough that a sibling could compile against it without talking to this worker.

## Fan-in

Workers push their state to you; you do not poll. A report arrives as input in your pane.

### Pre-commit review gate

Every worker brief requires both reviews once after implementation and focused verification,
before committing. Follow [the one-pass review and human-disposition policy](../code-review/REVIEW-HANDOFF.md):

1. **`hanif-agent-review` skill** — load it for the CLI review of the effective worktree,
   with the agreed base pinned explicitly. It owns command syntax and coverage interpretation.
2. **`code-review` skill** — the independent Standards and Spec axes. Load the skill,
   supply the same base and originating spec, and retain separate reports for both axes.

These reviews are complementary; neither substitutes for the other or for orchestrator
verification. Reviewers remain read-only. The worker may spawn the review-only agents
required by `code-review`; this does not authorize further implementation delegation.

Freeze edits while the reviews run. Both must inspect the same effective changes, including
staged, unstaged, and untracked files. The `code-review` skill's default three-dot HEAD diff
excludes uncommitted work: explicitly adapt its scope for this pre-commit gate using the
merge-base-to-worktree diff plus the untracked-file inventory and contents. An empty HEAD
diff is not a clean review. Record the base, reviewed file inventory, and any scope mismatch;
resolve mismatches before accepting the reports. Keep review artifacts outside the worktree.

The worker reports both outputs and proposed dispositions without starting fixes. You
analyze the evidence and present all findings to the human, including disputed and deferred
items. Human approval, not orchestrator arbitration alone, authorizes review-driven fixes.
Route approved fixes to their owner, then independently verify the resulting diff and
affected checks. No automatic post-fix review is required. Disclose incomplete coverage
and ask the human whether to retry or proceed; zero findings is not the completion criterion.
Report verified fixes and remaining risks before seeking any separate commit approval.

Verify rather than trust a `DONE`. Read the pane, then run your own read-only checks — the diff in that worktree, the tests the brief named:

```bash
herdr agent read <worker-name> --source recent-unwrapped --lines 200
```

Poll only when a worker has gone quiet: `herdr agent get <worker-name>`. Treat `unknown` as no information — it does not prove the work finished. On `blocked`, read the pane before deciding what to send, and surface it to the user:

```bash
herdr notification show "<worker-name> is blocked" --body "<what it needs>" --sound request
```

### Phone notifications: human handoff

Send a phone notification as well as the in-session message when:

- **Human intervention is needed:** a decision, approval, credential, permission, or manual action is required. Inspect worker reports first; resolve issues within your authority yourself and notify only when the human must act.
- **Findings are ready for human disposition:** requested review attempts have finished, coverage is disclosed, and your evidence analysis is ready. Notify before waiting for fix/disposition approval, not merely on a worker's `DONE` report. After approved fixes, report verified results without requiring another review round.

Send once per distinct handoff. Notify again only when the required action or review scope materially changes, or the user requests another alert. Workers report to you; you consolidate alerts across workers.

The user's native ntfy server runs on their Mac, starts at login, and caches messages for 24 hours. The phone subscribes to `desktop` through Tailscale. Publish from that Mac to `http://127.0.0.1:2586/desktop`; from another tailnet machine, use `https://macbook-pro-3.tail7aeb03.ts.net:9443/desktop`. Loopback on a remote machine is not the Mac. This endpoint relies on Tailscale access control, with no separate ntfy password; keep it private rather than switching to a public service or Funnel.

Use a bounded request, replacing the placeholders with a concise, non-sensitive summary:

```bash
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  -H 'Title: Herdr: human input needed' \
  -H 'Priority: high' \
  --data-raw '<repo>/<branch> (<worker>): <required action>. Return to orchestrator; workspace <workspace-id>.' \
  http://127.0.0.1:2586/desktop
```

For review handoffs, use title `Herdr: ready for review`, priority `default`, and a body naming the review scope and where to review it. Include no credentials, source code, or sensitive logs: notification text may appear on the phone's lock screen.

A successful publish confirms server acceptance, not phone delivery. Immediate delivery requires the Mac awake and Tailscale connected on both devices. If publishing fails, report the failure in-session and retain the Herdr desktop notification; continue independent work while leaving the human-gated action paused. Notifications never substitute for explicit approval.

## Route the user to a worker

The user talks to you, but may need a worker directly. After each spawn, hand over the coordinates unprompted — worker name, branch, workspace id, worktree path — and how to get there:

```bash
herdr workspace focus <workspace-id>   # go look
herdr agent attach <worker-name>       # take the pane
```

Once the user has talked to a worker directly, your model of that layer is stale. `herdr agent read` that worker before your next decision about it.

## The runbox lease

One managed runner and one watcher exist per repository, so worktrees compete for them. You hold the **lease** and grant it; workers never run `runbox dev`, `sync`, `switch`, or `stack` themselves.

Grant it by running the command from the target worktree — `sync` copies the *invoking* worktree's dirty state, so the cwd is the entire decision:

```bash
cd <target-worktree> && runbox dev -w --no-tui --json
```

Then tell the previous holder it lost the runner, or it will read a stale dev server as its own.

For a stack, test from the top branch. `runbox stack --no-tui --json dev` refuses while any layer is dirty or needs rebasing; that refusal is a work item for the layer's owner, not something to route around with `runbox switch` or a local script.

## Push, PR, and teardown

Workers commit on their own branch only after the pre-commit review gate and required approval.
You own push, `prepare-pr`, and every `gh stack` operation — otherwise parallel workers race on one stack.

Remove a worktree only after its branch is merged or explicitly abandoned, and only one you created:

```bash
herdr worktree remove --workspace <workspace-id>
```
