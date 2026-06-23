#!/usr/bin/env bash
set -uo pipefail
[ -f "$(dirname "$0")/.env" ] && source "$(dirname "$0")/.env"

FZF_PREVIEW='
img=$(printf "%s" {} | cut -f3)
[ -n "$img" ] || exit 0
file="$POSTER_CACHE/$(basename "$img")"
[ -f "$file" ] || curl -Ls "$img" -o "$file" 2>/dev/null
if command -v chafa >/dev/null; then
  chafa --format symbols \
    --size="${FZF_PREVIEW_COLUMNS}x${FZF_PREVIEW_LINES}" "$file"
else
  printf "[ install chafa for poster preview ]\n\n%s\n" "$img"
fi
'

# ── config (override via env) ─────────────────────────────────────────────────
POSTER_CACHE="${HOME}/.cache/anime_tui/posters"
STATE_DIR="${HOME}/.cache/anime_tui"
MODE_FILE="${STATE_DIR}/source"

mkdir -p "$STATE_DIR"
echo search >"$MODE_FILE"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANIME_CLI="${ANIME_CLI:-node ${SCRIPT_DIR}/anime.js}"
PLAYER="${PLAYER:-mpv}"                      # any player command
PLAYER_OPTS="${PLAYER_OPTS:---really-quiet}" # extra flags for PLAYER
# Set ABYSS_DL_JAR=/path/to/abyss-dl.jar to download before playing
ABYSS_DL_JAR="${ABYSS_DL_JAR:-}"
ABYSS_QUALITY="${ABYSS_QUALITY:-h}"

mkdir -p "$POSTER_CACHE"
export SHELL="$(command -v bash)"
export ANIME_CLI POSTER_CACHE # needed inside fzf preview / reload shells

# ── helpers ───────────────────────────────────────────────────────────────────
_spinner() {
  local pid=$1 msg=$2
  local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf '\r%s %s' "${frames:i++%${#frames}:1}" "$msg" >&2
    sleep 0.1
  done
  printf '\r\033[K' >&2
}

_die() {
  printf '%s\n' "$*" >&2
  exit 1
}
_warn() { printf '%s\n' "$*" >&2; }

_check_deps() {
  local missing=()
  command -v fzf >/dev/null || missing+=(fzf)
  command -v node >/dev/null || missing+=(node)
  command -v "$PLAYER" >/dev/null || missing+=("$PLAYER")
  ((${#missing[@]} == 0)) || _die "Missing: ${missing[*]}"
}

# ── stage 1 – pick an anime ───────────────────────────────────────────────────
# stdout: the selected TSV line (title TAB url TAB poster)

_pick_anime() {
  local mode="$1"

  if [[ "$mode" == "history" ]]; then
    $ANIME_CLI history | fzf \
      --expect=ctrl-s \
      --delimiter=$'\t' \
      --layout=reverse \
      --border \
      --prompt 'History > ' \
      --header 'Enter to select · Ctrl-S Search' \
      --with-nth=1 \
      --preview "$FZF_PREVIEW" \
      --preview-window 'right:35%' \
      --bind 'resize:refresh-preview' \
      --bind 'ctrl-j:down,ctrl-k:up'
  else
    $ANIME_CLI search "" | fzf \
      --expect=ctrl-h \
      --delimiter=$'\t' \
      --layout=reverse \
      --border \
      --prompt 'Anime > ' \
      --header 'Type to search · Ctrl-H History' \
      --with-nth=1 \
      --bind "start:reload($ANIME_CLI search {q} 2>/dev/null || true)" \
      --bind "change:reload(sleep 0.3; $ANIME_CLI search {q} 2>/dev/null || true)" \
      --preview "$FZF_PREVIEW" \
      --preview-window 'right:35%' \
      --bind 'resize:refresh-preview' \
      --bind 'ctrl-j:down,ctrl-k:up'
  fi
}

# ── stage 2 – pick an episode ─────────────────────────────────────────────────
# stdout: the selected TSV line (label TAB url)
_pick_episode() {
  local anime_url="$1" anime_title="$2"

  _warn "Loading episodes for: $anime_title"

  local episodes
  episodes=$($ANIME_CLI episodes "$anime_url" 2>/dev/null) || {
    _warn "Failed to load episodes."
    sleep 2
    return 1
  }
  [ -n "$episodes" ] || {
    _warn "No episodes found."
    sleep 2
    return 1
  }

  local count
  count=$(printf '%s\n' "$episodes" | wc -l | tr -d ' ')

  printf '%s\n' "$episodes" | fzf \
    --delimiter=$'\t' \
    --layout=reverse \
    --border \
    --prompt 'Episode > ' \
    --header "${anime_title}  ·  ${count} episodes  ·  Enter to play  ·  Esc to go back" \
    --with-nth=1 \
    --bind 'ctrl-j:down,ctrl-k:up'
}

# ── stage 3 – play ────────────────────────────────────────────────────────────

_play() {
  local stream_url="$1"
  local notify=0
  command -v notify-send >/dev/null && notify=1

  if [[ "$stream_url" =~ ^https://abyssplayer\.com/(.+)$ ]]; then
    local id="${BASH_REMATCH[1]}"
    if [ -n "$ABYSS_DL_JAR" ] && command -v java >/dev/null; then
      local outdir outfile logfile
      outdir=$(mktemp -d "${TMPDIR:-/tmp}/anime_XXXXXX")
      outfile="$outdir/episode.mp4"
      logfile="$outdir/abyss-dl.log"
      _warn "Downloading via abyss-dl (id=$id) → $outfile (log: $logfile)"
      [ "$notify" -eq 1 ] && notify-send "Anime TUI" "Downloading episode…" -t 4000

      (
        if java -jar "$ABYSS_DL_JAR" "$id" "$ABYSS_QUALITY" -o "$outfile" >"$logfile" 2>&1; then
          [ "$notify" -eq 1 ] && notify-send "Anime TUI" "Download done — starting playback" -t 3000
          $PLAYER $PLAYER_OPTS "$outfile" >/dev/null 2>&1
          rm -rf "$outdir"
        else
          [ "$notify" -eq 1 ] && notify-send -u critical "Anime TUI" "Download failed — see $logfile"
          _warn "Download failed, see $logfile (kept at $outdir)"
        fi
      ) &
      return
    fi
    _warn "Tip: set ABYSS_DL_JAR=/path/to/abyss-dl.jar to download first"
  fi

  _warn "Playing: $stream_url"
  $PLAYER $PLAYER_OPTS "$stream_url" >/dev/null 2>&1 &
}
# ── main loop ─────────────────────────────────────────────────────────────────
run_tui() {
  _check_deps

  while true; do
    local anime_line
    local mode="search"

    while true; do
      local out key anime_line

      mapfile -t out < <(_pick_anime "$mode") || exit 0

      key="${out[0]}"
      anime_line="${out[1]}"

      case "$key" in
      ctrl-h)
        mode="history"
        continue
        ;;
      ctrl-s)
        mode="search"
        continue
        ;;
      esac

      [[ -n "$anime_line" ]] && break
    done
    [ -n "$anime_line" ] || exit 0

    tput smcup 2>/dev/null
    clear # <-- re-enter alt screen before any further output

    local anime_url anime_title
    anime_url=$(printf '%s' "$anime_line" | cut -f2)
    anime_title=$(printf '%s' "$anime_line" | cut -f1)
    poster=$(printf '%s' "$anime_line" | cut -f3)
    while true; do
      local ep_line
      ep_line=$(_pick_episode "$anime_url" "$anime_title") || break
      [ -n "$ep_line" ] || break

      tput smcup 2>/dev/null
      clear # <-- re-enter again, before "Fetching stream…"

      local ep_url stream
      ep_url=$(printf '%s' "$ep_line" | cut -f2)
      ep_label=$(printf '%s' "$ep_line" | cut -f1)
      local tmpfile rc
      tmpfile=$(mktemp)
      $ANIME_CLI streams "$ep_url" >"$tmpfile" 2>/dev/null &
      local pid=$!
      _spinner "$pid" "Fetching stream…"
      wait "$pid"
      rc=$?
      stream=$(<"$tmpfile")
      rm -f "$tmpfile"

      if [ "$rc" -ne 0 ]; then
        _warn "Stream fetch failed for: $ep_url"
        sleep 2
        continue
      fi
      [ -n "$stream" ] || {
        _warn "Empty stream URL."
        sleep 2
        continue
      }
      $ANIME_CLI history-add \
        "$anime_title" \
        "$anime_url" \
        "$poster" \
        "$ep_label" >/dev/null 2>&1
      _play "$stream"
    done
  done
}

run_tui
#TODO: create history tab
#TODO: optimize speed
#TODO: refractor project
