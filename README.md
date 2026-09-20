# anime-tui

`anime-tui` is a terminal interface for searching anime, browsing episodes, and playing streams with [mpv](https://mpv.io/). It uses `fzf` for navigation and stores search/history data under your user cache and data directories.

## Install on Arch Linux

The recommended installation is from the AUR:

```bash
 yay -S anime_tui
```

or:

```bash
 paru -S anime_tui
```

The package installs the `anime-tui` command and includes the Abyss downloader used for progressive playback.

Required runtime dependencies are installed by the package: Node.js, fzf, mpv, Java, and Chromium.

## Run

```bash
anime-tui
```

In the search screen:

- Type to search.
- Press Enter to select an anime or episode.
- Press `Ctrl-H` to open history.
- Press `Ctrl-E` to view completed anime.
- Press `Ctrl-J` / `Ctrl-K` to move down/up.
- Press Escape to go back or exit.

The selected episode is played with mpv. History is updated automatically.

## Resume and auto-next

Unfinished episodes save their playback position every five seconds and once
more when playback stops. Selecting one again resumes automatically. The episode
picker shows `Resume 12:34 / 23:40` (without a total when duration is unknown),
marks completed episodes `Watched`, and initially focuses the most recently
updated unfinished episode. Otherwise it prefers the episode after the most
recently completed one, or that completed episode if it is the last available.
All episodes remain visible and searchable.

Confirmed natural completion replaces the saved resume data with watched status:
the old position and duration are removed. Quitting, failed playback, and early
EOF do not count as completion. Completing an episode **never automatically marks
the entire series completed**; the history toggle remains manual.

After completion, the next episode in the displayed ordering starts after a
five-second countdown. Enter starts it immediately; Escape cancels and returns
to the picker focused on that next episode. Ctrl-C exits the TUI. The next stream
is resolved only after the countdown, and the final episode returns directly to
selection.

Playback shows timestamp progress in the terminal. Resuming progressive Abyss
playback first buffers to the saved timestamp while paused, using a temporary
disk-backed packet cache (up to 2 GiB forward and 64 MiB backward). Preparation
shows the seekable buffered range; playback begins after the resume seek is
confirmed, without requiring the whole download. Cancelling preparation preserves
the previous resume data. If the target cannot be reached, an error is shown
instead of silently restarting at zero; download-first mode can help.

The enhanced workflow requires **mpv JSON IPC**. A custom `PLAYER` must be an
mpv-compatible executable supporting its IPC options and protocol; an arbitrary
video player is not sufficient. Temporary player sockets, disk caches, and
downloader data are cleaned up on exit (downloader failure logs are retained).

## Progressive playback

When an Abyss stream is selected, anime-tui starts mpv as soon as the first contiguous segments are available instead of waiting for the entire episode to download. The downloader continues in the background and is stopped automatically when playback ends.

To disable progressive playback and restore full-download-first behavior:

```bash
ABYSS_PROGRESSIVE=0 anime-tui
```

The default quality is high (`h`). Progressive playback retries an incomplete download up to three times, then tries medium (`m`) and low (`l`) if no bytes have reached the player. Each quality starts with fresh segments. Once playback starts, retries stay at the same quality to avoid mixing video data. Downloader launch failures and nonzero exits remain errors. Full-download mode (`ABYSS_PROGRESSIVE=0`) uses only the selected quality.

Override the starting quality with `h`, `m`, or `l`:

```bash
ABYSS_QUALITY=m anime-tui
```

## Configuration

Configuration can be supplied through environment variables or a `.env` file beside the script.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLAYER` | `mpv` | Player executable supporting mpv JSON IPC |
| `PLAYER_OPTS` | `--really-quiet` | Additional player arguments |
| `PROGRESSIVE_PLAYER_OPTS` | `--cache=yes` | Additional arguments for progressive stdin playback |
| `ABYSS_DL_JAR` | packaged JAR | Override the downloader path |
| `ABYSS_QUALITY` | `h` | Abyss quality: `h`, `m`, or `l` |
| `ABYSS_PROGRESSIVE` | `1` | Set to `0` to wait for a complete file |
| `PLAYWRIGHT_EXECUTABLE_PATH` | system Chromium when available | Browser executable used for episode discovery |
| `ANIME_TUI_REQUEST_TIMEOUT_MS` | `15000` | Timeout per gateway/search HTTP request and stream API request, including response-body reads |

Example:

```bash
export PLAYER_OPTS='--really-quiet --no-resume-playback'
export ABYSS_QUALITY=h
anime-tui
```

## Install from source

```bash
git clone https://github.com/tuanlyphong/anime_tui.git
cd anime_tui
npm ci --omit=dev --ignore-scripts
ABYSS_DL_JAR="$PWD/abyss-dl.jar" ./tui_anime.sh
```

You need Node.js, npm, fzf, mpv, Java 21 or a compatible Java runtime, and Chromium. Playwright uses the system Chromium executable at `/usr/bin/chromium` when present.

## Data locations

- Search and episode response cache: `~/.cache/anime-tui/json`
- Poster cache: `~/.cache/anime_tui/posters`
- Live-domain cache: `~/.cache/anime-tui/live-domain.json`
- Watch history: `~/.local/share/anime-tui/history.json`
- Episode resume positions and watched status: `~/.local/share/anime-tui/playback-state.json`

Search results expire after one hour. Episode lists are cached for five minutes,
so returning to episode selection does not launch another browser each time.
Old cache entries without timestamps are refreshed automatically. Empty search
results and failed responses are not cached; cache write failures do not block
searching or episode discovery. To force a refresh, remove the response cache:

```bash
rm -rf ~/.cache/anime-tui/json
```

## Troubleshooting

Search errors appear in a non-selectable header above the results; episode and
stream lookup errors are shown in the terminal. HTTP errors
include their status code; stalled gateway/search and stream API requests time out
after 15 seconds by default. Browser navigation and episode-list discovery retain
their separate timeouts. For a slow connection, increase the API timeout:

```bash
ANIME_TUI_REQUEST_TIMEOUT_MS=30000 anime-tui
```

If episode loading fails, verify that Chromium is installed and executable:

```bash
command -v chromium
```

For a non-standard browser path:

```bash
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium anime-tui
```

If progressive playback is incompatible with a particular stream, use:

```bash
ABYSS_PROGRESSIVE=0 anime-tui
```

## License

The bundled `abyss-dl.jar` comes from [AbyssVideoDownloader](https://github.com/abdlhay/AbyssVideoDownloader), which is licensed under Apache-2.0. See [LICENSE](LICENSE) for attribution. The anime-tui project currently has no separately declared upstream license.
