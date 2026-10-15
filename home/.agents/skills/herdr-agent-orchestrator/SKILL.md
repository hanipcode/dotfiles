---
name: herdr-agent-orchestrator
description: "Orchestrate work across herdr worktree agents — spawn a worker per branch or stack layer, brief it, fan in results, coordinate verification, and route the user to a worker. Use when the user asks you to orchestrate or delegate work across herdr worktrees or to act as orchestrator over worktree agents. Requires HERDR_ENV=1."
---

# Herdr agent orchestrator

You manage **workers**: coding agents, one per branch, each in its own herdr worktree. You plan, brief, arbitrate, and verify. You do not write the code.

## Preflight

```bash
test "${HERDR_ENV:-}" = 1
```

If that fails, say you are not running inside Herdr and stop.

The `herdr` skill is the authority on CLI syntax. Read it for flags and semantics; this skill covers only what orchestration adds.

Name yourself for Herdr navigation (choose a unique name if `orchestrator` is taken):

```bash
herdr agent rename "$HERDR_PANE_ID" orchestrator
```

**Session-addressed coordination:** read [OpenCode session routing](SESSION-ROUTING.md)
before spawning or messaging a worker. Record your current OpenCode session ID from the
session environment/context, and each worker's session ID before sending its brief.
Herdr names and pane IDs locate terminals, not conversations; their active session can change.
Every brief carries the orchestrator and worker session IDs. Pane IDs are navigation only.

## You do not code

Read anything, plan, verify, review. Never edit a file inside a worker's worktree — a one-line fix still goes to the worker that owns that **boundary**, or two writers race on one branch. Your own worktree holds planning artifacts only.

## Spawn one worker per branch

```bash
herdr worktree create --workspace <repo-parent-workspace> --branch <branch> --base <ref> --no-focus
# read .result.workspace, .result.tab, .result.root_pane, and the worktree path
# Create and verify an OpenCode session at that worktree using SESSION-ROUTING.md.
herdr agent start <worker-name> --kind opencode --pane <root_pane_id> -- --session <worker-session-id>
# Send the brief through the OpenCode API to <worker-session-id>, not the pane.
# Require a session-addressed acknowledgement carrying both session IDs.
```

`worktree create` runs only from the repo's parent workspace. Called from inside a linked worktree it fails with `linked_worktree_source`, so pass the parent's `--workspace` — read it from `herdr worktree list` as `source_workspace_id`.

**Spawn your own kind.** A `claude` orchestrator spawns `claude` workers, an `opencode` orchestrator spawns `opencode` workers. Read your kind off yourself rather than assuming it — `herdr agent get "$HERDR_PANE_ID"` returns it as `.result.agent.agent`. Only a kind the user explicitly names overrides this.

**Bypass the worker's permission prompts.** A worker that stops to approve its own tool calls is a stalled worker: nobody is watching its pane, and it reports `blocked` for a reason that has nothing to do with the work. How depends on the kind:

- `claude` — pass `-- --dangerously-skip-permissions`.
- `opencode` — inspect the installed CLI's help for `--auto` and its semantics; when supported, append it to the launch arguments. It does not override explicit denials or the task's approval gates.

If you inherit a worker that blocks on an approval prompt, restart it with the bypass and re-send the brief; the fresh session remembers nothing.

Name for the layer, not the person — `l1-contract`, `mpcs`, `gpcs`. Names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live agents.

Submit the brief without waiting for the whole implementation. API acceptance proves enqueueing,
not that the worker read it; require its acknowledgement in your exact OpenCode session.
Use session-addressed nudges for unexpected stops, never input to whichever session a pane displays.

Parallel workers need a **frozen interface** before any of them starts — the exact names, types, and signatures each layer exposes or consumes. Freeze it in the plan, restate it in every brief. Without it, siblings block on each other or invent conflicting versions of the same seam.

## The brief

A worker boots with zero context, so the brief is the entire handoff. Send it as the prompt text, and keep the text in your own scratchpad directory so a restarted worker can be re-briefed verbatim. Never write it as a file in the worker's worktree; planning artifacts do not belong on the worker's branch.

```
Load the `herdr-managed-agent` skill now, before anything else.

You are worker `<worker-name>`, working in <worktree-path> on branch <branch>
(based on <ref>). Your OpenCode session is <worker-session-id>.
Your orchestrator's OpenCode session is <orchestrator-session-id>.
Herdr name <orchestrator-name> and pane <orchestrator-pane-id> are navigation only.

Task: <what to build, in enough detail that no clarifying question is needed
to start>

Frozen interface: <the names, types, and signatures this layer must expose or
consume, verbatim>

Boundaries: <files and directories owned by sibling workers — do not edit them.
Ask instead.>

Done means: <the commands that must pass, e.g. the exact test invocations>

Work independently on this non-main branch: implement, fix issues, run checks,
and make local commits without waiting for human or orchestrator approval.
Do not add review gates or milestone approval pauses. Coordinate changes to
sibling-owned files or frozen interfaces with the orchestrator.

Test deployment target: <exact user-confirmed test environment and deployment
target, or none>. When the user has confirmed this target is a test environment,
deploy there, verify the deployed behavior, fix failures, and redeploy until the
task's checks pass without asking for approval at each step.

Read SESSION-ROUTING.md via the managed-agent skill. Before implementation, send ACK
to <orchestrator-session-id> with both session IDs and your worktree/branch.
Send all progress, DONE, BLOCKED, QUESTION, and SCOPE-CHANGE reports to that same
OpenCode session through the API. Never fall back to a Herdr name or pane occupant.

The orchestrator owns phone notifications; report to it rather than sending duplicate alerts.
```

Every part filled, and the frozen interface concrete enough that a sibling could compile against it without talking to this worker.

## Fan-in

Workers push their state to your exact OpenCode session; you do not routinely poll.
Reports reach the session even when its pane displays another conversation.

### Independent branch work

Workers on non-main branches implement, fix issues, run focused checks, and make
local commits independently. Do not require human or orchestrator approval for
those actions, add review gates, or pause them at intermediate milestones.
Report progress and results without turning reports into permission requests.

Coordinate shared boundaries and frozen interfaces to avoid conflicting writes.
Changes to main, merges into main, production actions, and operations outside the
authorized task are not covered by this branch-local autonomy.

### Confirmed test-environment deployments

When the user designates a deployment target and confirms it is a test environment,
record the exact environment and target in the worker brief. That confirmation
authorizes the worker to deploy its assigned work there, verify deployed behavior,
fix failures, and redeploy as needed without further human or orchestrator approval.
Do not introduce deployment, verification, or fix approval pauses within this loop.

Before each deployment, verify that the configured account, project, environment,
and resources match the recorded test target. A test label does not authorize using
production resources. If the target is ambiguous, conflicts with configuration,
or would affect production or resources outside the authorized test environment,
stop that action and ask for clarification while continuing independent local work.
Report deployments, verification evidence, fixes, and genuine blockers through the
recorded session route. Credentials and unrelated destructive operations remain
outside this authorization.

Verify rather than trust a `DONE`: inspect the recorded worker session's messages and
evidence, then independently check its worktree diff and the tests named in the brief.

Inspect session state only when a worker has gone quiet or a requested supervisor catches
a stop. Herdr status and pane reads are supplemental UI diagnostics, not proof about the
recorded OpenCode session. Check that session before nudging it through the API. On
`blocked`, inspect its evidence before deciding what to send, and surface human blockers:

```bash
herdr notification show "<worker-name> is blocked" --body "<what it needs>" --sound request
```

### Phone notifications: human handoff

Send a phone notification as well as the in-session message when:

- **Human intervention is needed:** a decision, approval, credential, permission, or manual action is required. Inspect worker reports first; resolve issues within your authority yourself and notify only when the human must act.
- **Work is ready for the human:** implementation and verification are complete, with results and remaining risks available. This notification does not gate branch-local fixes or commits.

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

The user talks to you, but may need a worker directly. After each spawn, hand over the coordinates unprompted — worker session ID, worker name, branch, workspace id, worktree path — and how to get there:

```bash
herdr workspace focus <workspace-id>   # go look
herdr agent attach <worker-name>       # take the pane
```

Once the user has talked to a worker directly, your model of that layer is stale. Read
the recorded worker session's messages before your next decision about it. If the user
replaced the session, explicitly confirm the new session ID and re-brief it first.

## Push, PR, and teardown

Workers commit on their own non-main branch after focused verification without
human or orchestrator approval. Do not introduce a pre-commit review gate.
You own push, `prepare-pr`, and every `gh stack` operation — otherwise parallel workers race on one stack.
Workers own deployments and verification/fix loops for their exact user-confirmed
test targets; they do not need to hand those actions back to you for approval.

Remove a worktree only after its branch is merged or explicitly abandoned, and only one you created:

```bash
herdr worktree remove --workspace <workspace-id>
```
