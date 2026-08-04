# heherdr — agent context

## What this is

`heherdr` is a **framework plus a set of plugins for [herdr](https://herdr.dev)**, a
terminal workspace manager for AI coding agents. herdr is the tmux replacement in
this setup: `session → workspace → tab → pane`, with one workspace per project.

Every plugin here is a **modal, vim-style terminal UI** — normal mode where `j/k`
move, `/` for filter, `d` to act, `Esc` back. That constraint is the reason the
framework exists: herdr's own overlays are filter-first (every printable key goes
to a search box, so `j` types `j`), and this repo exists to build overlays that
behave like vim instead.

Stack: **OpenTUI + React**, **Effect**, `@effect/cli`, `@effect-atom/atom-react`,
**Bun**.

## Shape

One binary, one subcommand per plugin. One herdr plugin id (`heherdr`) with many
entrypoints:

```sh
heherdr worktree          # run a plugin UI directly — also the dev loop
heherdr open worktree     # ask herdr to open it as a pane — what a keybinding fires
```

herdr distinguishes **actions** (plain processes) from **panes** (terminals herdr
owns). A keybinding can only fire an action, so the action calls
`herdr plugin pane open` to open the pane. `src/framework/herdr/openPane.ts` is that
bridge, shared by all plugins — do not reimplement it per plugin.

```
bin/heherdr.ts              Effect CLI root — the subcommand registry
src/framework/
  modal/keymap.ts           pure modal core: key normalisation, sequence matching
  modal/keymap.test.ts      the vim semantics under test, no terminal needed
  modal/useModal.ts         React binding; mode state in an Atom
  herdr/Client.ts           typed Effect wrapper over the `herdr` CLI
  herdr/PluginContext.ts    HERDR_PLUGIN_CONTEXT_JSON + env → typed context
  herdr/openPane.ts         `heherdr open <entrypoint>` action→pane bridge
  git/Client.ts             what herdr does not expose: locks, dirt, reachability
  ui/runApp.tsx             renderer lifecycle, Kitty keyboard, alt screen
  ui/theme.ts               Catppuccin Macchiato (matches every other tool here)
src/plugins/<name>/
  command.tsx               Effect CLI command: gather data, run UI, apply result
  Ui.tsx                    keymap + render, plain data in, callbacks out
```

## Architecture rules

1. **Effect stays out of the React tree.** `command.tsx` owns the Effect runtime and
   hands the UI plain data plus `async` callbacks. Service methods are closures with
   no remaining requirements, so they can be `Effect.runPromise`d straight from a
   callback.
2. **UIs are a function of props.** No herdr or git calls inside components — that is
   what keeps them testable without a terminal.
3. **Plugins never import each other.** Shared behaviour goes in `src/framework`.
4. **Destructive actions need a confirm mode**, and the confirm panel must state what
   would be lost. See the safety gate in `worktree`.
5. **Modal state belongs to `useModal`.** Do not add ad-hoc `useKeyboard` handlers in
   a plugin; declare a `ModeSpec` so hints, pending sequences and mode switching stay
   consistent.

## Hard-won constraints — do not rediscover these

**Bun is required, not a preference.** `createCliRenderer()` needs FFI. Node would
need 26.4.0 with `--experimental-ffi` and `--allow-ffi`.

**Every error in an Effect channel must be tagged.** A plain `Error` anywhere makes
`Effect.catchTags` unusable (its expected key type collapses to `never`). This is why
`runApp` fails with `RenderError` rather than `Error`. Same rule for any new failure.

**Chaining two `Effect.provide` calls** trips a variance error against `@effect/cli`'s
environment type under `exactOptionalPropertyTypes`. Merge layers and provide once —
see `bin/heherdr.ts`.

**Ternaries over two Effects with different error types need an explicit annotation.**
TypeScript will not widen the union on its own.

**These chords never reach a pane** — herdr claims them globally, per
`~/.config/herdr/config.toml`:

| Chord | Claimed by |
| --- | --- |
| `ctrl+a` | prefix |
| `ctrl+h/j/k/l` | vim-herdr-navigation plugin |
| `ctrl+q` | `close_pane` — would kill the overlay |
| `ctrl+1..9` | `switch_workspace` |

`HERDR_NAV_PASSTHROUGH_RE` (set in `~/.zshenv`, currently `^fzf$`) reclaims
`ctrl+j/k` for a named process.

**`workspace.worktree` from herdr is unreliably populated.** Observed absent on a
workspace that is definitely a git repo with worktrees. Never treat its absence as
"not a git project" — resolve the project from `workspace_cwd` (see
`PluginContext.projectDir`) or ask git.

**herdr's `worktree remove` requires `--workspace <id>`**, so it only works on
worktrees currently open as workspaces. Anything else must go through
`git worktree remove`. The worktree plugin routes on `open_workspace_id`.

**`git worktree remove` refuses locked worktrees, and `--force` does not override
it.** You must `git worktree unlock` first.

**`git rev-list --exclude=refs/heads/<b> --branches` did not take effect on git
2.39.5** — it subtracted the branch from itself and always returned 0. To ask "do
these commits exist anywhere else", use
`git for-each-ref --contains <branch> --count=1 refs/remotes`. Enumerating refs by
hand is also slow on repos with hundreds of branches.

**Unmerged-vs-default-branch is not a danger signal.** A worktree cut from a feature
branch inherits that branch's commits, so it reads non-zero with nothing of its own.
Danger is uncommitted files, or a tip no remote contains.

**Kitty keyboard is negotiated by `runApp`** with `disambiguate: true`, which is why
`Esc` is instant instead of timeout-guessed. It also means `ctrl+c` arrives as a key
event rather than SIGINT, so `exitOnCtrlC` is off — a half-finished git operation must
not die mid-flight. Handle it yourself if a UI needs it.

**The plugin `id` in `herdr-plugin.toml` is load-bearing.** It keys the config dir
(`~/.config/herdr/plugins/config/heherdr`), the state dir
(`~/.local/state/herdr/plugins/heherdr`) and every `heherdr.<action>` binding.
Renaming it orphans all three.

## Adding a plugin

1. `src/plugins/<name>/{command.tsx,Ui.tsx}`.
2. Register the command in `bin/heherdr.ts`'s `withSubcommands`.
3. Add an `[[actions]]` + `[[panes]]` pair in `herdr-plugin.toml`, both pointing at
   `bun run bin/heherdr.ts …`.
4. Relink (manifest changed): `bun run link:herdr`.
5. Bind it in `~/.config/herdr/config.toml` with
   `type = "plugin_action"`, `command = "heherdr.<action>"`.

## Verify

```sh
bun run typecheck                    # must be clean
bun test                             # modal core
bun run bin/heherdr.ts <plugin>      # run outside herdr; no pane required
herdr plugin action list --plugin heherdr
herdr plugin log heherdr             # a crashing overlay just closes — look here
herdr server reload-config           # after editing herdr config; check diagnostics
```

Script edits are picked up on the next invoke (each one spawns a fresh `bun run`).
**Manifest edits require a relink.**

`bun install` warns about `@effect/rpc`, `@effect/experimental` and
`@effect/platform` peers — `@effect-atom/atom` over-declares them (it wants
`@effect/platform ^0.94`, `@effect/cli` wants `^0.97`). Harmless; nothing imports the
mismatched modules. Do not "fix" it by downgrading `@effect/cli`.

## Status

The framework is real and used. `src/plugins/worktree` has a working safety gate and
live herdr data, but **its layout is still provisional** — the owner is still
designing how it should look and operate. Prefer changing the render body over
changing the framework when iterating on it.
