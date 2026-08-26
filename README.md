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

## Progressive playback

When an Abyss stream is selected, anime-tui starts mpv as soon as the first contiguous segments are available instead of waiting for the entire episode to download. The downloader continues in the background and is stopped automatically when playback ends.

To disable progressive playback and restore full-download-first behavior:

```bash
ABYSS_PROGRESSIVE=0 anime-tui
```

The default quality is high (`h`). Override it with `h`, `m`, or `l`:

```bash
ABYSS_QUALITY=m anime-tui
```

## Configuration

Configuration can be supplied through environment variables or a `.env` file beside the script.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLAYER` | `mpv` | Player command |
| `PLAYER_OPTS` | `--really-quiet` | Additional player arguments |
| `PROGRESSIVE_PLAYER_OPTS` | `--cache=yes` | Additional arguments for progressive stdin playback |
| `ABYSS_DL_JAR` | packaged JAR | Override the downloader path |
| `ABYSS_QUALITY` | `h` | Abyss quality: `h`, `m`, or `l` |
| `ABYSS_PROGRESSIVE` | `1` | Set to `0` to wait for a complete file |
| `PLAYWRIGHT_EXECUTABLE_PATH` | system Chromium when available | Browser executable used for episode discovery |

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

- Search response cache: `~/.cache/anime-tui/json`
- Poster cache: `~/.cache/anime_tui/posters`
- Live-domain cache: `~/.cache/anime-tui/live-domain.json`
- Watch history: `~/.local/share/anime-tui/history.json`

## Troubleshooting

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
