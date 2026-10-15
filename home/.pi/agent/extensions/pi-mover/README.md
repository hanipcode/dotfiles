# Pi Mover

Move the current Pi conversation between ordinary Git worktrees, create checkouts from main, and open the same session in a native Herdr worktree workspace grouped under the source repository.

```text
/reload
/mover
```

## Picker

```text
worktree name: [                           ]

› …/project-worktrees/sandbox-perf     1h ago
  …/project                           today
  …/project-worktrees/topic           not visited
```

Search filters the current repository's paths and branches, preserving most-recent-first order. Paths shorten in the middle to keep checkout names visible. Recency means the last recorded Pi visit or successful Mover focus, not file modification time. Previously unvisited paths sort last.

- **Shift+Tab**: toggle **Move / Fork**. The active mode is shown below the search input; each picker opens in **Move** mode. Applies to keyboard and mouse selection, including creation.
- **Enter on a worktree**: in Herdr, focus its existing workspace if open; otherwise open a native worktree workspace, start the moved/forked session there, then focus it. Existing agents and conversations are left untouched. Outside Herdr, move/fork in the same pane.
- **No matching result**: display `Create <name>`.
- **Enter on Create**: create the Git worktree, then open/focus it using the same policy. No Shift+Enter is needed (it is accepted as an alias). The Move/Fork toggle applies only when starting a session, not when focusing an existing workspace.
- **Up/Down**: select a row and focus the list.
- **Tab**: toggle input/list focus.
- **d with list focus**: confirm deletion of the selected checkout. Typing `d` in the input types normally.
- **Mouse hover**: select a row; left-click chooses it. Clicking uses the same open/focus policy as Enter.
- **Escape**: close without changing anything.

## Creation policy

New branches always start from refreshed `refs/remotes/origin/main`. If origin is absent or has no main branch, use `refs/heads/main`. An origin fetch failure is an error, not permission to silently use a stale ref or feature branch. If neither main exists, nothing is created. Existing branch names are rejected rather than reused with an unintended base.

Checkouts are created beside the primary checkout under `<primary-name>-worktrees/<name>`, replacing `/` in branch names with `--` for the directory. For example `/projects/project-worktrees/feature--sandbox`. No `.bare` conversion, symlink layout, external skill, commit, or push is required. Herdr represents each managed worktree as a workspace grouped under its source repository in the sidebar. Mover uses Git for the exact main-base policy, then `herdr worktree open --workspace <source> --path <checkout>` to register it as a native Herdr worktree—not a plain tab.

## Moving or forking a session

**Move or create:** if the current session has not been saved yet (no user/assistant messages), Mover creates a session in the destination and preserves its in-memory setup, including model/thinking settings. This works in both toggle modes and in Herdr, without sending a prompt first. A missing file for a session that already contains conversation messages is treated as an error, never silently replaced with an empty session.

When Herdr already has a workspace for the selected checkout, Mover only focuses it: no session is prepared, archived, or replaced, and the source Pi remains running. If a workspace must be opened, **Move** archives the old session and exits the original Pi only after successful startup; **Fork** keeps the original instance running.

Forks receive a new session ID and retain a link to the source session, selected conversation branch, and destination cwd. The source is never archived when forking. In the same pane, Pi switches to the fork; in Herdr, both instances remain open.

Moves retain the session ID, full entry history, model/settings entries, and active conversation branch. If the source is already in the destination session directory (for example, opening the same cwd in a new Herdr workspace), Mover stages a uniquely named copy there instead of touching the running file. The destination JSONL header changes its cwd. A persisted checkpoint preserves the selected branch even if abandoned history was written more recently.

Pi's supported `ctx.switchSession()` rebuilds the runtime for the destination: tools, project resources, trust, and instructions are rediscovered there. Only after success does Mover change the Pi process cwd/PWD and, in Move mode, archive the old session file. A visible appended context message warns the agent to re-inspect destination files rather than reuse old absolute paths or remembered contents. Nothing starts an unsolicited model turn.

Original files are retained as `.bak` files under `~/.pi/agent/pi-mover/backups/`; new session files live in Pi's destination-cwd session directory. The shell that originally launched Pi is a parent process and keeps its own original directory when Pi eventually exits. Moving Pi does not magically change that shell's cwd.

Source sessions remain intact if preparing or cancelling a switch fails. A newly created checkout is retained if a later session move fails, so work is never removed to hide an error. Herdr startup failures retain the original instance and worktree workspace/session for recovery rather than killing a possibly live agent. Already-open worktree panes are focused without replacing their agents. A failed runtime replacement is reported by Pi; retain the original file and staged destination for recovery before retrying.

## Deletion safety

Requires confirmation, a clean status including untracked files, an unlocked worktree, and a non-current checkout. In Herdr, Mover also refuses deletion while any pane in any workspace has that directory or a subdirectory as its recorded cwd/foreground cwd. Git performs the removal without `--force`. Local branches are kept. Ignored-file protections and primary-checkout restrictions are left to Git's non-force removal.

Mover requires interactive mode, a persistent session, an idle agent, and no queued prompts. It rechecks idleness after picker/create operations. Pause unattended workflows such as Babysit before moving if they might wake the agent. Babysit's existing restoration policy pauses an active goal on session replacement.

## State and verification

Visit history is stored in append-only per-path files under `~/.pi/agent/pi-mover/visits/`, allowing multiple panes to record visits without overwriting one another. Runtime history and session backups stay outside the dotfiles repository.

- `mover-extension.ts`: Pi command and runtime replacement.
- `mover-picker.ts`: keyboard/mouse picker and bounded rendering.
- `mover-worktrees.ts`: Git operations and visit history.
- `mover-sessions.ts`: session relocation preparation and source archival.
- `mover-herdr.ts`: native Herdr worktree opening, session launch, and pane-use checks.
- `mover-domain.ts`: parsing, search, ordering, and relative times.

Tests exercise real temporary Git repositories and local remotes, real Pi session files, a real runtime replacement with a destination-relative read, picker events/Unicode widths, and recording Herdr CLI responses. They make no model API calls and do not move user panes. The Herdr session launch sequence is covered against its CLI contract, not a live full-screen startup.

With peer dependencies and development dependencies installed, run `npm test` and `npm run typecheck`. Pi itself loads TypeScript through its extension loader without compilation.
