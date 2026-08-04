# heherdr

Framework and plugins for [herdr](https://herdr.dev), built around one idea: **every
plugin here is a modal, vim-style terminal UI**. The framework owns the parts that
would otherwise be copy-pasted per plugin — mode state machine, key normalisation,
herdr access, renderer lifecycle, theme — so a plugin is a keymap plus a render
function.

## Shape

One binary, one subcommand per plugin:

```sh
heherdr worktree            # run the overlay directly (this is also how you dev)
heherdr open worktree       # ask herdr to open it as a pane (what a keybinding fires)
```

One herdr plugin id (`heherdr`) with many entrypoints, so adding a plugin means a
`Command` in `bin/heherdr.ts` plus an `[[actions]]`/`[[panes]]` pair in
`herdr-plugin.toml`. No second install, no second config dir.

```
bin/heherdr.ts              Effect CLI root — subcommand registry
src/framework/
  modal/keymap.ts           pure modal core: KeyId normalisation, sequence matching
  modal/keymap.test.ts      vim semantics under test, no terminal required
  modal/useModal.ts         React binding, mode state in an Atom
  herdr/Client.ts           typed Effect wrapper over the `herdr` CLI
  herdr/PluginContext.ts    HERDR_PLUGIN_CONTEXT_JSON + env → typed context
  herdr/openPane.ts         `heherdr open <entrypoint>` action→pane bridge
  ui/runApp.tsx             renderer lifecycle, Kitty keyboard, alt screen
  ui/theme.ts               Catppuccin Macchiato
src/plugins/
  worktree/                 project-wise worktree management
```

## Stack

OpenTUI + React (`@opentui/react`), Effect, `@effect/cli`, `@effect-atom/atom-react`,
Bun.

Two things to know about the dependency graph:

- **Bun is required**, not optional. `createCliRenderer()` needs FFI; Node would
  need 26.4.0 with `--experimental-ffi`.
- `bun install` prints peer warnings for `@effect/rpc`, `@effect/experimental` and
  `@effect/platform`. They come from `@effect-atom/atom` over-declaring peers
  (it wants `@effect/platform ^0.94`, `@effect/cli` wants `^0.97`). Harmless —
  nothing imports the mismatched modules.

## Modal keymaps

A plugin declares one `ModeSpec` per mode. Bindings are single keys (`"j"`),
modified keys (`"ctrl+u"`), or space-separated sequences (`"g g"`, `"d d"`) matched
progressively with a pending buffer.

```ts
const modes = {
  normal: {
    bindings: {
      j: { description: "down", run: () => move(1) },
      "g g": { description: "top", run: () => setCursor(0) },
      "/": { description: "filter", run: () => setMode("filter") },
    },
  },
  filter: {
    onText: (char) => setQuery((q) => q + char),
    onBackspace: () => setQuery((q) => q.slice(0, -1)),
    bindings: { escape: { description: "cancel", run: () => setMode("normal") } },
  },
} satisfies Record<Mode, ModeSpec>

const modal = useModal({ initial: "normal", modes })
```

Presence of `onText` is what makes a mode insert-like. Bindings always win over
text capture, and a pending sequence never leaks into a text buffer.

`Esc` is instant rather than timeout-guessed because `runApp` negotiates the Kitty
keyboard protocol (`disambiguate: true`), which herdr supports. That also means
`ctrl+c` arrives as a key event — `exitOnCtrlC` is off so a half-finished git
operation can't be killed mid-flight.

## Chords you cannot use

herdr claims these globally before a pane sees them:

| Chord | Claimed by |
| --- | --- |
| `ctrl+a` | prefix |
| `ctrl+h/j/k/l` | vim-herdr-navigation |
| `ctrl+q` | `close_pane` — would kill the overlay |
| `ctrl+1..9` | `switch_workspace` |

`HERDR_NAV_PASSTHROUGH_RE` can reclaim `ctrl+j/k` by process name.

## Development

```sh
bun install
herdr plugin link .
bun run typecheck && bun test

bun run bin/heherdr.ts worktree      # run outside herdr, no pane needed
herdr plugin log heherdr             # a crashing overlay just closes; look here
```

Manifest changes need a relink (`bun run link:herdr`). Script edits do not — each
invoke spawns a fresh `bun run`.

Bound in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "heherdr.worktree"
```

This *replaces* herdr's native `open_worktree` overlay (`open_worktree = ""`), and
pushes `open_notification_target` from its `prefix+o` default to `prefix+shift+o`.

## Status

The framework is real. `src/plugins/worktree` is **a pipeline proof, not the final
UX** — modal keys, live herdr data, one action round-trip. The layout is still
being designed; replace the render body freely.
