# OpenCode session routing

## Identity before transport

Use the recipient's exact OpenCode `ses_...` ID for every brief, acknowledgement,
progress report, blocker, review handoff, and nudge. Herdr manages worktrees and terminal
layout; an agent name or pane ID does not identify the conversation currently displayed.
This rule applies whenever the recipient is OpenCode, even if the sender is another kind.

Load the `opencode` skill for API discovery. Verify commands against the installed CLI
and live OpenAPI contract. Use its authenticated API client and the same server context
as the recipient; never copy credentials into briefs.

- Obtain your own session ID from the current session context, not a pane's latest session.
- Before briefing, retain the worker's session ID with its branch, worktree, and server
  context in the orchestrator's scratchpad outside the worker worktree.
- Verify a destination with `opencode2 api get /api/session/<session-id>`. For a worker,
  confirm its returned ID and location match the intended worktree.
- A missing ID or API failure is a routing blocker. Preserve the unsent report and ask
  for the exact destination. Never fall back to a name, pane, latest session, or directory
  match. A changed session requires an explicit handoff, re-brief, and acknowledgement.

## Bootstrap a worker

Create an OpenCode session at the new worktree through `POST /api/session` before starting
its terminal. Send `location.directory`, a descriptive `title`, and the intended agent
and model when specified; read the returned `data.id` rather than inventing an ID.
For model/variant fields, inspect the current API schema rather than guessing.

Start Herdr's OpenCode worker with `--session <returned-id>`, then send the brief to
that ID through the API. Record both the orchestrator and worker IDs in the brief.
Require an ACK addressed back to the orchestrator session before implementation. The
ACK includes both IDs, branch, and worktree so misrouting is observable.

## Send a session-addressed message

For the current V2 API, serialize report text instead of hand-escaping JSON:

```bash
recipient='ses_REPLACE_WITH_VERIFIED_RECIPIENT'
message='worker-name: BLOCKED — concise summary, evidence, and requested decision'
body=$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1], "delivery": "queue"}))' "$message")
opencode2 api post "/api/session/$recipient/prompt" --data "$body"
```

`queue` avoids interrupting an active turn. Check that the response's `data.sessionID`
equals the intended recipient; retain the returned message ID. Enqueueing is not proof
of processing. For the initial brief or a changed routing target, require the recipient's
ACK, not merely HTTP success or a Herdr `working` status.

Inspect progress and evidence through that session's message API when needed. A Herdr
wait or pane-status change may wake a supervisor, but the supervisor must inspect and
address the recorded session before deciding it stopped or sending a nudge.

## Other agent kinds

For a non-OpenCode recipient, agree on an explicit session-bound transport before
delegating. These skills do not authorize a silent fallback to Herdr pane prompting.
If no stable transport is available, report the limitation and ask the human how to
proceed rather than sending work to a potentially different conversation.
