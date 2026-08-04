# dotfiles

macOS development environment: **Ghostty + herdr + nvim + pi**, themed Catppuccin
Macchiato throughout. Managed with GNU Stow — `home/` mirrors `$HOME`, so the files
in this repo *are* the live configs.

```sh
git clone <this> ~/.dotfiles && cd ~/.dotfiles
./dot brew          # install packages
./dot stow          # symlink home/ into $HOME
./dot plugins       # link herdr plugins
./dot doctor        # verify
```

## How it works

`dot stow` runs `stow -R -d ~/.dotfiles -t ~ home`, creating symlinks in `$HOME` that
point back here. Editing `~/.config/nvim/init.lua` edits this repo — `git status` sees
it immediately. No sync step.

Stow **folds trees**: it links the highest directory it can. That gives two different
behaviours, both intentional:

| Target | Result | Why |
| --- | --- | --- |
| `~/.config/nvim`, `~/.config/sketchybar` | whole directory is one symlink | new files you add are tracked automatically |
| `~/.config/herdr`, `~/.config/opencode`, `~/.pi/agent`, `~/.claude` | individual files linked | those directories also hold **sockets, logs, `node_modules`, and credentials** — folding them would pull all of that into the repo |

The per-file behaviour only happens because those directories already exist as real
directories on this machine. On a **fresh machine they won't**, so stow will fold them
and the tools will start writing state into this repo. `.gitignore` covers that case,
and `dot doctor` fails loudly if a credential or a `.sock`/`.log` ever gets tracked.

## Layout

```
dot                          management CLI (stow + brew + doctor)
packages/Brewfile            brews, casks, taps, npm, vscode
home/                        stowed to $HOME
  .config/nvim/              lazy.nvim, Catppuccin Macchiato
  .config/sketchybar/        the bar (absorbed from its own repo)
  .config/ghostty/config
  .config/herdr/config.toml  tmux-style keys, ctrl+a prefix
  .config/btop/              conf + Macchiato theme
  .config/opencode/          opencode.json, tui.json, commands/
  .pi/agent/                 settings.json, themes/
  .claude/settings.json
  .local/bin/                tmux-sessionizer, tmux-windowizer (ssh fallback)
  .tmux.conf .zshrc .zshenv
heherdr/                     herdr plugin source — NOT stowed, see below
```

## heherdr is not stowed

`heherdr/` is a herdr **plugin source tree**, not a config. herdr links it by absolute
path, so it lives outside `home/` and is wired up with `dot plugins`:

```sh
herdr plugin link ~/.dotfiles/heherdr
```

That means moving this repo breaks the link until you re-run `dot plugins`. See
`heherdr/AGENTS.md` for its architecture.

## What is deliberately not here

Credentials and machine state stay outside the repo, as real files:
`~/.pi/agent/auth.json`, `~/.claude/.credentials.json`, `~/.codex/auth.json`,
`~/.local/share/opencode/auth.json`, `~/.config/opencode/node_modules`, and herdr's
sockets, logs, `session.json` and cloned plugins.

There is no secret management or per-machine templating — stow does not do that. If
this ever needs to cover a second machine with different values, that is the point to
consider chezmoi.

## Fonts

`Maple Mono NF` — ligatures, Nerd Font icons, real italics at every weight. Ghostty
and sketchybar both name it; everything else inherits from the terminal.

`design.sh` in sketchybar hardcodes an advance width of 8px/char for menu sizing.
Maple is 0.600em = 7.8px at 13px (Fira Code was 0.6154em = 8.0px), so the value now
over-estimates slightly, which widens menus harmlessly instead of truncating labels.
