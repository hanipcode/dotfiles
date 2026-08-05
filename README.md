# dotfiles

macOS development environment: **Ghostty + herdr + nvim + pi**, themed Catppuccin
Macchiato throughout. Managed with GNU Stow — `home/` mirrors `$HOME`, so the files
in this repo *are* the live configs.

```sh
git clone <this> ~/.dotfiles && cd ~/.dotfiles
./dot brew          # install packages
./dot stow          # symlink home/ into $HOME
./dot plugins       # link herdr plugins
./dot tools         # install and link personal CLIs (runbox)
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
| `~/.config/herdr`, `~/.config/opencode`, `~/.pi/agent`, `~/.agents`, `~/.claude` | individual files linked | those directories also hold **sockets, logs, `node_modules`, credentials, or externally installed content** — folding them would pull all of that into the repo |

The per-file behaviour only happens because those directories already exist as real
directories on this machine. On a **fresh machine they won't**, so stow will fold them
and the tools will start writing state into this repo. `.gitignore` covers that case,
and `dot doctor` fails loudly if a credential or a `.sock`/`.log` ever gets tracked.

## Layout

```
dot                          management CLI (stow + brew + skills + doctor)
packages/Brewfile            brews, casks, taps, npm, vscode
archive/skills/              disabled skills, outside agent discovery paths
home/                        stowed to $HOME
  .config/nvim/              lazy.nvim, Catppuccin Macchiato
  .config/sketchybar/        the bar (absorbed from its own repo)
  .config/ghostty/config
  .config/herdr/config.toml  tmux-style keys, ctrl+a prefix
  .config/btop/              conf + Macchiato theme
  .config/opencode/          opencode.json, tui.json, commands/
  .pi/agent/                 settings.json, themes/
  .agents/skills/            canonical personal Agent Skills
  .claude/settings.json      Claude settings
  .claude/skills/            compatibility links into .agents/skills
  skills-lock.json           Skills CLI project lock (tracked, not stowed)
  .local/bin/                tmux-sessionizer, tmux-windowizer (ssh fallback)
  .tmux.conf .zshrc .zshenv
heherdr/                     herdr plugin source — NOT stowed, see below
runbox/                      Git-aware managed runner for agent worktrees
```

## Agent skills

Personal skills live once under `~/.agents/skills`. OpenCode, Codex, and pi load
that Agent Skills standard location directly. Claude Code only scans
`~/.claude/skills`, so each entry there is a relative symlink back to the canonical
skill. Plugin-managed skills remain in each tool's own plugin cache.

Manage sourced skills through the wrapper so the CLI runs against the tracked
collection, updates `home/skills-lock.json`, creates any missing Claude links, and
restows the result:

```sh
./dot skills add mattpocock/skills -y
./dot skills update -p -y
```

Temporarily disable a skill without deleting it, then enable it again later:

```sh
./dot skills disable my-skill
./dot skills enable my-skill
```

Disabled skills move to `archive/skills`, outside every agent discovery path. The
wrapper removes or restores the Claude compatibility link and restows automatically.
Project-wide updates only include enabled skills, so an archived sourced skill is not
silently reinstalled from `home/skills-lock.json`. Git-backed skills such as the
`img2threejs` submodule cannot be disabled this way because moving them would invalidate
their repository metadata.

If `npx skills` is run directly from `home/`, run `./dot stow` afterward. The lock
file is intentionally excluded from Stow; it belongs to this repository, not
`~/skills-lock.json`.

To create a personal skill, initialize it through the same wrapper:

```sh
./dot skills init my-skill
$EDITOR home/.agents/skills/my-skill/SKILL.md
./dot doctor
```

`init` writes into `home/.agents/skills/my-skill` and restows automatically. This exposes
it as `~/.agents/skills/my-skill` and creates the Claude compatibility link at
`~/.claude/skills/my-skill`. A skill only needs valid frontmatter and its body:

```md
---
name: my-skill
description: Explain what this skill does and when an agent should use it.
---

# My Skill

Instructions for the agent.
```

If linking manually, the tracked compatibility link is relative to
`home/.claude/skills`:

```sh
ln -s ../../.agents/skills/my-skill home/.claude/skills/my-skill
./dot stow
```

Normally this manual step is unnecessary because `dot stow` creates and prunes
those Claude links automatically.

`img2threejs` is pinned as a Git submodule because it is maintained as its own
repository. `dot stow` initializes submodules before creating the home-directory
links, so the normal setup command works on a fresh clone.

## This repo in the sessionizer

Both pickers list the **children** of `~/Projects` and `~/.config`; a root is never
itself an entry. So this repo, at `~/.dotfiles`, needs help to show up:

- `tmux-sessionizer` names `~/.dotfiles` directly — no filesystem trick needed.
- herdr's sessionizer plugin only takes `[projects].roots`, with no way to name one
  path, so `dot stow` creates `~/.config/dotfiles -> ~/.dotfiles` and the picker
  finds it as a child of `~/.config`. `dot unstow` removes it; `dot doctor` checks it.

Working inside `~/.config/dotfiles` is the same as working in `~/.dotfiles` — git
resolves the link, so `--show-toplevel`, commits and pushes all land on the real
repo. `dot` itself uses `pwd -P` so running it through the link still stows from the
real path.

`~/Projects/dotfiles` is a stale 2024 repo, unrelated to this one.

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
