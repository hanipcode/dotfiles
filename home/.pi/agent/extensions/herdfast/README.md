# Herdfast — Herdr Focus

Run `/reload`, then `/hf`.

Search the **open worktrees in the calling Herdr workspace's repository group**, including the primary checkout when it has an open workspace. The current workspace is marked **[active]**. Selecting a row focuses its Herdr workspace; it never moves/forks the Pi conversation, creates a checkout, or starts/replaces an agent.

- Type to search by branch, label, checkout path, or workspace ID (case-insensitive substring).
- Up/Down select; Enter focuses; Escape/Ctrl+C cancel. Mouse selection is supported in fullscreen mode.
- Lists are always ordered by recorded recency, including while searching. Equal/unvisited entries use path order.
- Herdr's CLI does not expose global focus timestamps. Recency records the caller whenever `/hf` is opened, and the target after successful focus. Visits through unrelated sidebar/CLI navigation are not tracked automatically.
- History is shared across Pi instances in append-only repository-scoped JSONL files under `~/.pi/agent/herdfast/visits/`. Checkout paths, rather than workspace IDs, preserve history when workspaces reopen.
- A target is rechecked before focus; closed targets return an error, never reopen automatically.
- Requires interactive Pi inside Herdr with `HERDR_ENV=1` and `HERDR_WORKSPACE_ID`.

Use `/mover` instead to open unopened worktrees or create new Git checkouts and start a session there.

## Verification

`npm test` and `npm run typecheck` with dependencies installed. Tests use recording CLI responses, real temporary history files, and the actual Pi TUI picker components. No live user workspaces are focused during tests.
