# ytmusic.nvim

Search YouTube Music and control playback from a Telescope picker without
leaving Neovim. Inspired by [jam.nvim](https://github.com/bautistaaa/jam.nvim),
but backed by YouTube Music instead of Spotify — no account, no OAuth, no
premium subscription.

## How it works

- **Search** — YouTube Music's InnerTube API (the same one the web client
  uses) via `curl`, debounced while you type. Returns real song metadata:
  artist, album, duration.
- **Playback** — a single headless `mpv --no-video --idle` process, remote
  controlled over its JSON IPC socket (pause/seek/volume/queue/progress).

## Requirements

- Neovim 0.10+
- [telescope.nvim](https://github.com/nvim-telescope/telescope.nvim)
- `curl` (search)
- `mpv` and `yt-dlp` on your `$PATH` for playback (`brew install mpv yt-dlp` —
  mpv shells out to yt-dlp to resolve the audio stream)

## Usage

`:YTMusic` (or `:YTMusic search [query]`) opens the live search picker:

| key | action |
| --- | --- |
| type | live search (min 2 chars, songs by default) |
| `v:` prefix | search videos instead (e.g. `v:get lucky live`) |
| `<CR>` | play now (replaces queue) |
| `<C-q>` | add to queue |
| `<C-p>` | toggle pause |

Other subcommands: `toggle`, `pause`, `resume`, `next`, `prev`, `stop`,
`queue`, `now`, `seek <±secs>`, `volume <n|+n|-n>`, `url <any yt url>`,
`autoplay` (toggle), `quit`.

### Autoplay (radio)

When the last queued track starts playing, the plugin fetches YouTube Music's
"up next" radio for it and appends `autoplay_batch` related tracks, so music
keeps flowing instead of stopping — with a session-wide de-dup so radio never
repeats a track you've already heard. Disable with `autoplay = false` in opts
or toggle at runtime with `:YTMusic autoplay`. `:YTMusic stop` always stops.

`:YTMusic now` opens a now-playing float with a progress bar and buffer-local
controls: `<space>` play/pause, `n`/`b` next/prev, `h`/`l` seek ±5s, `-`/`=`
volume, `e` queue picker, `/` search, `s` stop, `q` close.

`:YTMusic queue` opens the queue in Telescope: `<CR>` jumps to a track,
`<C-d>` removes it.

## Setup (lazy.nvim)

```lua
{
  dir = vim.fn.stdpath("config") .. "/ytmusic.nvim",
  name = "ytmusic.nvim",
  dependencies = { "nvim-telescope/telescope.nvim" },
  cmd = "YTMusic",
  opts = {
    search_limit = 25,   -- search result count
    autoplay = true,     -- continue with related tracks when queue ends
    autoplay_batch = 5,  -- radio tracks appended per fetch
    volume = 80,         -- initial volume
    debounce = 400,      -- ms of typing silence before searching
    audio_format = "bestaudio/best",
    mpv = { bin = "mpv", extra_args = {} },
    ytdlp = { bin = "yt-dlp" },
    ui = { width = 46, refresh = 500 },
  },
}
```

## Statusline

```lua
-- lualine
sections = { lualine_x = { require("ytmusic").statusline } }
```

Returns `♪ <title>` / `⏸ <title>` while something is playing, `""` otherwise.

## Notes

- mpv is spawned on first play and killed on `:qa` (VimLeavePre) or `:YTMusic quit`.
- `:YTMusic url <playlist url>` works, but mpv expands playlists internally so
  the queue picker only shows the single URL entry.
