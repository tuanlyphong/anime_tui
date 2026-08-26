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
PROGRESSIVE_PLAYER_OPTS="${PROGRESSIVE_PLAYER_OPTS:---cache=yes}" # stdin needs seekable cache for all tracks
# Set ABYSS_DL_JAR=/path/to/abyss-dl.jar to download before playing
ABYSS_DL_JAR="${ABYSS_DL_JAR:-}"
ABYSS_QUALITY="${ABYSS_QUALITY:-h}"
ABYSS_PROGRESSIVE="${ABYSS_PROGRESSIVE:-1}"

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

_restore_terminal() {
  trap - EXIT INT TERM HUP
  tput rmcup 2>/dev/null || true
  tput cnorm 2>/dev/null || true
  stty sane 2>/dev/null || true
  clear 2>/dev/null || true
}

trap '_restore_terminal' EXIT
trap '_restore_terminal; exit 130' INT
trap '_restore_terminal; exit 143' TERM
trap '_restore_terminal; exit 129' HUP

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
  local query="${2:-}"
  if [[ "$mode" == "history" || "$mode" == "completed" ]]; then
    local completed_flag=""
    local header='Enter to select · Ctrl-S Search · Ctrl-E Toggle View · Alt-m Toggle'
    if [[ "$mode" == "completed" ]]; then
      completed_flag=" completed"
    fi

    # toggle command depends on whether we're viewing completed or not
    local toggle_cmd
    if [[ "$mode" == "completed" ]]; then
      toggle_cmd="$ANIME_CLI history-uncomplete {2}"
    else
      toggle_cmd="$ANIME_CLI history-complete {2}"
    fi

    $ANIME_CLI history${completed_flag} | fzf \
      --print-query \
      --query "$query" \
      --expect=ctrl-s,ctrl-e \
      --delimiter=$'\t' \
      --layout=reverse \
      --border \
      --prompt 'History > ' \
      --header "$header" \
      --with-nth=1 \
      --preview "$FZF_PREVIEW" \
      --preview-window 'right:35%' \
      --bind 'resize:refresh-preview' \
      --bind 'ctrl-j:down,ctrl-k:up' \
      --bind "alt-m:execute-silent($toggle_cmd >/dev/null 2>&1)+reload($ANIME_CLI history${completed_flag} 2>/dev/null || true)"
  else
    $ANIME_CLI search "" | fzf \
      --print-query \
      --query "$query" \
      --expect=ctrl-h,ctrl-e \
      --delimiter=$'\t' \
      --layout=reverse \
      --border \
      --prompt 'Anime > ' \
      --header 'Type to search · Ctrl-H History · Ctrl-E Completed' \
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

  # Clean the string of any hidden carriage returns or spaces passed from JS stdout
  stream_url=$(echo "$stream_url" | tr -d '\r\n ')

  # We use ([^/?#]+) instead of (.+) to strictly grab ONLY the ID.
  # This stops capturing if it hits a slash, question mark, or end of string.
  if [[ "$stream_url" =~ abyssplayer\.com/([^/?#]+) ]]; then
    local id="${BASH_REMATCH[1]}"

    if [ -n "$ABYSS_DL_JAR" ] && command -v java >/dev/null; then
      if [ "$ABYSS_PROGRESSIVE" != "0" ]; then
        _warn "Progressive Abyss playback (id=$id, quality=$ABYSS_QUALITY)"
        [ "$notify" -eq 1 ] && notify-send "Anime TUI" "Buffering episode…" -t 3000
        # Exit alternate screen so player can use the main terminal, run in
        # foreground so we can restore the TUI afterward.
        tput rmcup 2>/dev/null || true
        $ANIME_CLI abyss-stream "$ABYSS_DL_JAR" "$id" "$ABYSS_QUALITY" | $PLAYER $PLAYER_OPTS $PROGRESSIVE_PLAYER_OPTS - >/dev/null 2>&1
        local pipeline_status=("${PIPESTATUS[@]}")
        local play_rc=0
        if [ "${pipeline_status[0]}" -ne 0 ] || [ "${pipeline_status[1]}" -ne 0 ]; then
          [ "$notify" -eq 1 ] && notify-send -u critical "Anime TUI" "Progressive playback failed"
          _warn "Progressive Abyss playback failed"
          play_rc=1
        fi
        # Re-enter alternate screen and redraw TUI
        tput smcup 2>/dev/null || true
        clear
        return "$play_rc"
      fi

      local outdir outfile logfile
      outdir=$(mktemp -d "${TMPDIR:-/tmp}/anime_XXXXXX")
      outfile="$outdir/episode.mp4"
      logfile="$outdir/abyss-dl.log"

      _warn "Downloading via abyss-dl (id=$id) → $outfile"
      [ "$notify" -eq 1 ] && notify-send "Anime TUI" "Downloading episode…" -t 4000

      if java -jar "$ABYSS_DL_JAR" "$id" "$ABYSS_QUALITY" -o "$outfile" >"$logfile" 2>&1; then
        [ "$notify" -eq 1 ] && notify-send "Anime TUI" "Download done — starting playback" -t 3000
        tput rmcup 2>/dev/null || true
        $PLAYER $PLAYER_OPTS "$outfile" >/dev/null 2>&1
        local play_rc=$?
        rm -rf "$outdir"
        tput smcup 2>/dev/null || true
        clear
        return "$play_rc"
      else
        [ "$notify" -eq 1 ] && notify-send -u critical "Anime TUI" "Download failed — see $logfile"
        _warn "Download failed, see $logfile (kept at $outdir)"
      fi
      return 1
    fi
    _warn "Tip: set ABYSS_DL_JAR=/path/to/abyss-dl.jar to download first"
  fi

  _warn "Playing direct stream: $stream_url"
  # Exit alternate screen for the player, run in foreground, then restore TUI.
  tput rmcup 2>/dev/null || true
  $PLAYER $PLAYER_OPTS "$stream_url" >/dev/null 2>&1
  local play_rc=$?
  tput smcup 2>/dev/null || true
  clear
  return "$play_rc"
}

_canonical_title() {
  local title="$1"
  local suffix_re='^(.*)[[:space:]]+\[((Tập|Episode|Ep)[^]]*)\][[:space:]]*$'
  while [[ "$title" =~ $suffix_re ]]; do
    title="${BASH_REMATCH[1]}"
  done
  printf '%s' "$title"
}

_latest_history_episode() {
  local anime_url="$1"
  local fallback="$2"
  local label candidate _ latest=""
  local suffix_re='\[((Tập|Episode|Ep)[^]]*)\][[:space:]]*$'

  while IFS=$'\t' read -r label candidate _; do
    if [ "$candidate" = "$anime_url" ] && [[ "$label" =~ $suffix_re ]]; then
      latest="${BASH_REMATCH[1]}"
    fi
  done < <(
    $ANIME_CLI history 2>/dev/null
    $ANIME_CLI history completed 2>/dev/null
  )
  printf '%s' "${latest:-$fallback}"
}

_episode_header_title() {
  local title latest
  title=$(_canonical_title "$1")
  latest="$2"
  if [ -n "$latest" ]; then
    printf '%s [%s]' "$title" "$latest"
  else
    printf '%s' "$title"
  fi
}

_play_and_record() {
  local stream="$1" anime_title="$2" anime_url="$3" poster="$4" ep_label="$5"
  local rc latest

  _play "$stream"
  rc=$?
  [ "$rc" -eq 0 ] || return "$rc"

  $ANIME_CLI history-add \
    "$anime_title" \
    "$anime_url" \
    "$poster" \
    "$ep_label" >/dev/null 2>&1 || return 1

  latest=$(_latest_history_episode "$anime_url" "$ep_label")
  _episode_header_title "$anime_title" "$latest"
}

# ── main loop ─────────────────────────────────────────────────────────────────
run_tui() {
  _check_deps

  while true; do
    local mode="search"
    local query=""

    while true; do
      local out key anime_line

      # With --print-query and --expect, fzf outputs 3 lines:
      #   out[0] = the current query string
      #   out[1] = the key that exited fzf (ctrl-h / ctrl-s / "" for Enter)
      #   out[2] = the selected item
      # If fzf exits via Escape/Ctrl-C it outputs nothing → array is empty.
      # Capture fzf's exit code via the process substitution fd trick so
      # an Escape (exit 130) still lets us exit cleanly.
      local fzf_status
      mapfile -t out < <(
        _pick_anime "$mode" "$query"
        printf '%d' $?
      )
      fzf_status="${out[-1]}"
      unset 'out[-1]'
      [[ "$fzf_status" -le 1 ]] || exit 0 # 0=ok 1=no match; 2+=error/abort

      query="${out[0]:-}"
      key="${out[1]:-}"
      anime_line="${out[2]:-}"

      case "$key" in
      ctrl-h)
        mode="history"
        continue
        ;;
      ctrl-s)
        mode="search"
        continue
        ;;
      ctrl-e)
        mode="completed"
        continue
        ;;
      esac

      [[ -n "$anime_line" ]] && break
    done
    [ -n "$anime_line" ] || exit 0

    tput smcup 2>/dev/null
    clear # <-- re-enter alt screen before any further output

    local anime_url anime_title poster episode_title
    IFS=$'\t' read -r anime_title anime_url poster <<<"$anime_line"
    episode_title="$anime_title"

    while true; do
      local ep_line
      ep_line=$(_pick_episode "$anime_url" "$episode_title") || break
      [ -n "$ep_line" ] || break

      tput smcup 2>/dev/null
      clear # <-- re-enter again, before "Fetching stream…"

      local ep_url ep_label stream
      IFS=$'\t' read -r ep_label ep_url _ <<<"$ep_line"
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
      local refreshed_title
      if refreshed_title=$(_play_and_record \
        "$stream" \
        "$anime_title" \
        "$anime_url" \
        "$poster" \
        "$ep_label"); then
        episode_title="$refreshed_title"
      fi
    done
  done
}

if [ "${ANIME_TUI_TESTING:-0}" != "1" ]; then
  run_tui
fi
#TODO: optimize speed
#TODO: refractor project
