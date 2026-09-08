# OpenCode V2 → Herdr activity

**Enabled in CLI configuration with user approval on 2026-09-06.** The plugin path
is present in both the dotfiles and live `cli.json`; existing settings are preserved.
The already-running worker CLI did not show the plugin in its Plugins menu after
the file edit, so reopen affected OpenCode CLIs to load it. Live pane arbitration
is not yet verified. No Herdr or shared OpenCode service was restarted.
The tests do not change configuration or contact the live Herdr process.

This CLI-only plugin reports the selected session's **root family**, including
background subagents and managed background shell jobs after the foreground turn ends:

1. Pending session permission or input form → `blocked`.
2. Any executing root/descendant session **or** running owned shell → `working`.
3. Otherwise → `idle`.

It does not change prompts, tools, permissions, or job execution. A failed execution
is not automatically `blocked`: that status is reserved for actual pending input.
Shell exit codes, timeout, cancellation, and deletion end the shell's activity;
a successful background *tool return* does not.

## Ownership and cleanup

- Pane/socket identity is captured from the **CLI process's** `HERDR_PANE_ID` and
  `HERDR_SOCKET_PATH`, gated by `HERDR_ENV=1`. Never use shared-server environment
  variables to assign a session to a pane.
- A Solid reactive effect observes `context.ui.router.current()`. It resolves a
  selected child back to its root, then tracks only that root and descendants.
- Subscribe before taking an API snapshot. Hydration includes pre-existing active
  sessions, running shells, and pending permission/form requests. Events received
  during hydration are replayed over the snapshot. Descendants are paginated;
  shells are read from each family member's location, including other workspaces.
- Lifecycle events update ID-keyed sets/maps, not counters. Duplicate terminal
  notifications are harmless. One child's completion cannot clear another job.
- Switching sessions/home aborts obsolete hydration, discards local state, and
  releases the previous report. A generation guard prevents old asynchronous
  results from reclaiming the pane. Returning to a session takes a fresh snapshot.
- Root deletion, plugin unload, renderer destruction, stream failure, and server
  disposal release ownership. Descendant deletion clears its tracked subtree.
- Snapshot reads have a 10-second I/O deadline; socket requests have a 500-ms
  deadline. On connection/report failure, release is best-effort and a toast asks
  for a CLI-plugin reload. There is no periodic polling, keep-alive prompt, busy
  heartbeat, or persistent force-working state.

Abrupt `SIGKILL` cannot run plugin cleanup; Herdr's foreground-process exit detection
is the remaining cleanup boundary. If the Herdr socket itself is unavailable, no
plugin can guarantee delivery of its final release. A broken event subscription
is not automatically reconnected by this plugin; reload it to establish a new
subscription and snapshot. A `server.connected` event on a functioning stream also
triggers a fresh snapshot.

## Verified API contract

Checked against **OpenCode `v0.0.0-beta-19151`** on 2026-09-06:

- [V2 plugin guide](https://opencode.ai/v2/docs/build/plugins)
- [V2 CLI plugin guide](https://opencode.ai/v2/docs/build/plugins/cli)
- Installed service's `/openapi.json`, generated client implementation and event
  schemas embedded in the installed `opencode2` binary. The local OpenCode checkout
  was older and was **not** treated as the installed event/API contract.
- Read-only live snapshot smoke check: this worker session hydrated as one active
  session plus one owned running shell, projecting `working`. No pane reports
  were sent by that check.

| Signal | Verified V2 payload / use |
| --- | --- |
| `session.created` | `data.sessionID`, `parentID`, `location`; child membership |
| `session.execution.started` | `data.sessionID`; turn starts |
| `session.execution.succeeded` / `.failed` / `.interrupted` | `data.sessionID`; that turn ends, not its independent jobs |
| `session.deleted` | `data.sessionID`; subtree cleanup |
| `shell.created` | `data.info.{id,status,metadata.sessionID}`; actual managed process ownership |
| `shell.exited` | `data.{id,status,exit?}`; `exited`, `timeout`, or `killed` |
| `shell.deleted` | `data.id`; removal/cancellation cleanup |
| `permission.asked` / `permission.replied` | `data.{id,sessionID}` / `data.{requestID,sessionID}` |
| `form.created` / `form.replied` / `form.cancelled` | `data.form.{id,sessionID}` / `data.{id,sessionID}` |

The installed shell tool creates shells with `metadata.sessionID` before returning
a background result; shell terminal events outlive that return. No guessed
`job.started` event or `tool.execute.after` lifetime is used. Session API records
use `location.workspaceID`; shell query inputs use `location.workspace`.

The reporter uses the installed **Herdr 0.8.0** socket schema and built-in integration's
ownership semantics:

- Source/agent: **`herdr:opencode` / `opencode`**. This exact pair has full-lifecycle
  authority over spinner/screen fallback. An arbitrary custom source does not.
- `pane.report_agent_session` with `session_start_source: "select"` and **no seq**
  is Herdr's explicit foreground selection anchor (also used by its stock TUI
  integration). This field is present in `herdr api schema`; the CLI help does not
  expose it as a flag, so the plugin uses the local socket protocol.
- State/release requests use strictly increasing `seq` values and a serialized
  request queue. Herdr drops stale sequences per source. Report acknowledgments
  confirm transport acceptance, not that arbitration necessarily changed state.
- `pane.release_agent` clears this source's authority; it does not close the pane
  or stop any process.

## Scope limits

Only OpenCode-managed shells and its own descendant sessions are observable here.
Use the shell tool's `background: true` for a long `hanif-agent review` command;
the integration follows the enclosing managed shell process until it exits.
A command that daemonizes/untracks itself (`nohup … &`, a remote detached job), an
unrelated Herdr pane, or a shell created without `metadata.sessionID` is not claimed.
Location-global forms are deliberately not assigned to one session/pane; the
plugin aggregates session-owned approval/input requests only. Generic plugin UI
dialogs are not treated as approval requests.

## Tests

From the dotfiles root, with Node 22+ (no dependency install):

```sh
node --test opencode-herdr/*.test.mjs
```

Tests exercise real reducer/controller/snapshot/reporter and CLI lifecycle-wiring modules, with a private
Unix socket for framing/error tests. They do not contact live Herdr, start an
agent, or restart OpenCode. Covered cases include parallel jobs completing in
either order, root idle with remaining jobs, nested children, blocked precedence,
failure/cancel, duplicate completion, pre-existing activity, paginated hydration,
cross-workspace shells, stale async work, disconnect/reconnect, and session exit.

## Activation / installation on another CLI

Do **not** run `herdr integration install opencode` alongside this plugin. The
stock server/TUI reporters and this plugin share a source and would race. Stock
integration status currently says OpenCode is not installed; that command will
continue to say so for this custom integration.

This path was added with user approval to the existing `plugins` array in
`~/.config/opencode/cli.json`, preserving the existing keybind plugin and settings:

```json
"/Users/hanifmuhammad/.dotfiles/opencode-herdr/herdr-activity-plugin.mjs"
```

The CLI resolves `solid-js` from its own runtime; no local dependency installation
is needed. Do not place this in the server's `opencode.json` plugins array or in an
auto-loaded server plugin directory.

**Caution:** Do not assume a file edit hot-loads into an already running CLI.
Coordinate a quiet activation window or an isolated test CLI before editing that
shared file. No global OpenCode service restart or main Herdr restart is needed.
The plugin has not yet been confirmed loaded in a real CLI or used to change a live pane;
an activation smoke test remains necessary to validate UI loading and
Herdr arbitration end-to-end, beyond the unit/socket/API checks.

Suggested approved smoke test: start two finite managed background shell jobs,
let the foreground turn end, check `herdr agent get <explicit-pane-id>` stays
working until both finish; repeat with a background subagent, an actual approval,
session switch, and CLI exit. Do not use fake prompts to hold the indicator busy.

To deactivate, remove only this path from `cli.json` and allow plugin cleanup (or
close/reopen the affected CLI after it is safe). Do not reset shared services.
