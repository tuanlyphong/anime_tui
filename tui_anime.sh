#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ANIME_TUI_ENV_FILE:-${SCRIPT_DIR}/.env}"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

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
ANIME_CLI="${ANIME_CLI:-node ${SCRIPT_DIR}/anime.js}"
PLAYER="${PLAYER:-mpv}" # executable supporting mpv JSON IPC
declare -p PLAYER_OPTS >/dev/null 2>&1 || PLAYER_OPTS='--really-quiet'
declare -p PROGRESSIVE_PLAYER_OPTS >/dev/null 2>&1 || PROGRESSIVE_PLAYER_OPTS='--cache=yes'
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

# UI controls belong on the terminal, never in captured TSV/header output.
_terminal() {
  if [[ -t 2 ]]; then
    "$@" >&2 2>/dev/null || true
  fi
}

_restore_terminal() {
  trap - EXIT INT TERM HUP
  _terminal tput rmcup
  _terminal tput cnorm
  [[ -t 0 ]] && stty sane 2>/dev/null || true
  _terminal clear
}

_playback_pid=''
_playback_output=''
_shutdown() {
  local signal="$1" code="$2" attempt
  trap '' INT TERM HUP
  if [ -n "$_playback_pid" ]; then
    # Bash wait is interruptible; foreground commands/substitutions defer traps.
    kill -s "$signal" "$_playback_pid" 2>/dev/null || true
    # Allow the controller's two-second child grace periods and bounded IPC
    # connection cleanup to finish before forcing an unresponsive CLI to exit.
    for ((attempt=0; attempt<80; attempt++)); do
      kill -0 "$_playback_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$_playback_pid" 2>/dev/null || true
    wait "$_playback_pid" 2>/dev/null || true
    _playback_pid=''
  fi
  [ -z "$_playback_output" ] || rm -f "$_playback_output"
  exit "$code"
}
trap '_restore_terminal' EXIT
trap '_shutdown INT 130' INT
trap '_shutdown TERM 143' TERM
trap '_shutdown HUP 129' HUP

_check_deps() {
  local missing=()
  command -v fzf >/dev/null || missing+=(fzf)
  command -v node >/dev/null || missing+=(node)
  command -v "$PLAYER" >/dev/null || missing+=("$PLAYER")
  ((${#missing[@]} == 0)) || _die "Missing: ${missing[*]}"
}

# ── stage 1 – pick an anime ───────────────────────────────────────────────────
# stdout: the selected TSV line (title TAB url TAB poster)

# fzf discards reload stderr. Reserve its first input line for a nonselectable
# status header, followed only by real result rows. Each reload owns its log.
_search_rows() (
  local error_file rows
  error_file=$(mktemp) || return 1
  trap 'rm -f "$error_file"' EXIT
  if rows=$($ANIME_CLI search "$@" 2>"$error_file"); then
    printf '\n'
    [ -z "$rows" ] || printf '%s\n' "$rows"
  else
    printf 'Search failed: %s\n' "$(tr '\r\n\t' '   ' <"$error_file")"
  fi
)
export -f _search_rows

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
    printf '\n' | fzf \
      --print-query \
      --query "$query" \
      --expect=ctrl-h,ctrl-e \
      --delimiter=$'\t' \
      --layout=reverse \
      --border \
      --prompt 'Anime > ' \
      --header 'Type to search · Ctrl-H History · Ctrl-E Completed' \
      --header-lines=1 \
      --with-nth=1 \
      --bind 'start:reload(_search_rows {q})' \
      --bind 'change:reload(sleep 0.3; _search_rows {q})' \
      --preview "$FZF_PREVIEW" \
      --preview-window 'right:35%' \
      --bind 'resize:refresh-preview' \
      --bind 'ctrl-j:down,ctrl-k:up'
  fi
}

# ── stage 2 – pick an episode ─────────────────────────────────────────────────
# stdout: display TAB url TAB original label TAB preferred marker
_pick_episode() {
  local anime_url="$1" anime_title="$2"
  local episodes="${3-}"
  if [ "$#" -lt 3 ]; then
    _warn "Loading episodes for: $anime_title"
    episodes=$($ANIME_CLI episodes-progress "$anime_url") || {
    _warn "Failed to load episodes."
    sleep 2
    return 1
    }
  fi
  [ -n "$episodes" ] || {
    _warn "No episodes found."
    sleep 2
    return 1
  }

  local count position=1 index=0 display url label preferred
  count=$(printf '%s\n' "$episodes" | wc -l | tr -d ' ')
  while IFS=$'\t' read -r display url label preferred; do
    ((index+=1))
    [ "$preferred" = 1 ] && position=$index
  done <<<"$episodes"

  printf '%s\n' "$episodes" | fzf \
    --sync --bind "start:pos($position)" \
    --delimiter=$'\t' \
    --layout=reverse \
    --border \
    --prompt 'Episode > ' \
    --header "${anime_title}  ·  ${count} episodes  ·  Enter to play  ·  Esc to go back" \
    --with-nth=1 \
    --bind 'ctrl-j:down,ctrl-k:up'
}

# ── stage 3 – play ────────────────────────────────────────────────────────────

# Scalar environment options retain whitespace splitting, without globbing or
# evaluation. Bash arrays in .env preserve spaces within individual arguments.
_player_options() {
  if [[ $(declare -p PLAYER_OPTS) == 'declare -a '* ]]; then
    player_args=("${PLAYER_OPTS[@]}")
  else
    IFS=$' \t\n' read -r -a player_args <<<"$PLAYER_OPTS"
  fi
  if [[ $(declare -p PROGRESSIVE_PLAYER_OPTS) == 'declare -a '* ]]; then
    progressive_args=("${PROGRESSIVE_PLAYER_OPTS[@]}")
  else
    IFS=$' \t\n' read -r -a progressive_args <<<"$PROGRESSIVE_PLAYER_OPTS"
  fi
}

_tracked_play() {
  local stream="$1" anime_url="$2" ep_url="$3" label="$4" arg rc
  local player_args=() progressive_args=() options=()
  _player_options
  for arg in "${player_args[@]}"; do options+=(--player-arg "$arg"); done
  for arg in "${progressive_args[@]}"; do options+=(--progressive-player-arg "$arg"); done
  _terminal tput rmcup
  $ANIME_CLI play-episode "$stream" "$anime_url" "$ep_url" "$label" \
    --player "$PLAYER" --jar "$ABYSS_DL_JAR" --quality "$ABYSS_QUALITY" \
    --progressive "$ABYSS_PROGRESSIVE" "${options[@]}" &
  _playback_pid=$!
  wait "$_playback_pid"
  rc=$?
  _playback_pid=''
  _terminal tput smcup
  _terminal clear
  return "$rc"
}

_play() {
  local stream_url="$1"
  local player_args=() progressive_args=()
  _player_options
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
        _terminal tput rmcup
        $ANIME_CLI abyss-stream "$ABYSS_DL_JAR" "$id" "$ABYSS_QUALITY" | "$PLAYER" "${player_args[@]}" "${progressive_args[@]}" - >/dev/null 2>&1
        local pipeline_status=("${PIPESTATUS[@]}")
        local play_rc=0
        if [ "${pipeline_status[0]}" -ne 0 ] || [ "${pipeline_status[1]}" -ne 0 ]; then
          [ "$notify" -eq 1 ] && notify-send -u critical "Anime TUI" "Progressive playback failed"
          _warn "Progressive Abyss playback failed"
          play_rc=1
        fi
        # Re-enter alternate screen and redraw TUI
        _terminal tput smcup
        _terminal clear
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
        _terminal tput rmcup
        "$PLAYER" "${player_args[@]}" "$outfile" >/dev/null 2>&1
        local play_rc=$?
        rm -rf "$outdir"
        _terminal tput smcup
        _terminal clear
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
  _terminal tput rmcup
  "$PLAYER" "${player_args[@]}" "$stream_url" >/dev/null 2>&1
  local play_rc=$?
  _terminal tput smcup
  _terminal clear
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
  local rc latest outcome ep_url="${6:-}"

  if [ -n "$ep_url" ]; then
    _playback_output=$(mktemp) || return 1
    _tracked_play "$stream" "$anime_url" "$ep_url" "$ep_label" >"$_playback_output"
    rc=$?
    outcome=$(<"$_playback_output")
    rm -f "$_playback_output"
    _playback_output=''
    [ "$rc" -eq 0 ] || return 1
    case "$outcome" in
      finished|stopped) ;;
      *) _warn "Playback failed or returned an unknown outcome: $outcome"; return 1 ;;
    esac
  else
    _play "$stream"
    rc=$?
    [ "$rc" -eq 0 ] || return "$rc"
  fi

  $ANIME_CLI history-add \
    "$anime_title" \
    "$anime_url" \
    "$poster" \
    "$ep_label" >/dev/null 2>&1 || return 1

  latest=$(_latest_history_episode "$anime_url" "$ep_label")
  PLAYBACK_RESULT=$(_episode_header_title "$anime_title" "$latest")
  [ -z "$ep_url" ] || PLAYBACK_RESULT+=$'\t'"$outcome"
  [ "${7:-}" = quiet ] || printf '%s' "$PLAYBACK_RESULT"
  return 0
}

# Read the controlling terminal directly; captured stdout and video stdin never
# carry countdown input. A fixed elapsed deadline prevents keys shortening it.
_next_countdown() {
  local finished="$1" next="$2" tty key rc now deadline remaining timeout
  { exec {tty}<>/dev/tty; } 2>/dev/null || return 1
  now=${EPOCHREALTIME/./}
  deadline=$((now + 5000000))
  while true; do
    now=${EPOCHREALTIME/./}
    remaining=$((deadline - now))
    if ((remaining <= 0)); then
      printf '\r\033[K\n' >&"$tty"
      exec {tty}>&-
      return 0
    fi
    printf '\r%s finished · %s starts in %ss · Enter: play now · Esc: cancel\033[K' \
      "$finished" "$next" "$(((remaining + 999999) / 1000000))" >&"$tty"
    if ((remaining > 1000000)); then timeout=1; else printf -v timeout '0.%06d' "$remaining"; fi
    key=''
    IFS= read -r -s -n 1 -t "$timeout" key <&"$tty"
    rc=$?
    if [ "$rc" -eq 0 ] && { [ -z "$key" ] || [ "$key" = $'\e' ]; }; then
      printf '\r\033[K\n' >&"$tty"
      exec {tty}>&-
      [ -z "$key" ] && return 0 || return 1
    fi
    # EOF/closed terminal must cancel, rather than spin until auto-start.
    if [ "$rc" -ne 0 ] && [ "$rc" -le 128 ]; then
      exec {tty}>&-
      return 1
    fi
  done
}

_watch_anime() {
  local anime_title="$1" anime_url="$2" poster="$3" episode_title="$1"
  local rows ep_line='' focus='' ep_url ep_label display preferred
  local tmpfile rc stream stream_error pid result outcome next_line next_url next_label row found
  while true; do
    if [ -z "$ep_line" ]; then
      _warn "Loading episodes for: $episode_title"
      rows=$($ANIME_CLI episodes-progress "$anime_url" "$focus") || { _warn 'Failed to load episodes.'; sleep 2; break; }
      ep_line=$(_pick_episode "$anime_url" "$episode_title" "$rows") || break
      focus=''
      [ -n "$ep_line" ] || break
    fi
    IFS=$'\t' read -r display ep_url ep_label preferred <<<"$ep_line"
    ep_label="${ep_label:-$display}"
    ep_line=''
    _terminal tput smcup
    _terminal clear
    tmpfile=$(mktemp) || return 1
    $ANIME_CLI streams "$ep_url" >"$tmpfile" 2>"$tmpfile.err" &
    pid=$!
    _spinner "$pid" 'Fetching stream…'
    wait "$pid"
    rc=$?
    stream=$(<"$tmpfile")
    stream_error=$(<"$tmpfile.err")
    rm -f "$tmpfile" "$tmpfile.err"
    if [ "$rc" -ne 0 ] || [ -z "$stream" ]; then
      [ -z "$stream_error" ] || _warn "$stream_error"
      _warn "Stream fetch failed for: $ep_url"
      sleep 2
      continue
    fi
    _play_and_record "$stream" "$anime_title" "$anime_url" "$poster" "$ep_label" "$ep_url" quiet || { sleep 2; continue; }
    result="$PLAYBACK_RESULT"
    IFS=$'\t' read -r episode_title outcome <<<"$result"
    [ "$outcome" = finished ] || continue
    next_line='' found=0
    while IFS= read -r row; do
      if [ "$found" -eq 1 ]; then next_line="$row"; break; fi
      IFS=$'\t' read -r display next_url next_label preferred <<<"$row"
      [ "$next_url" != "$ep_url" ] || found=1
    done <<<"$rows"
    [ -n "$next_line" ] || continue
    IFS=$'\t' read -r display next_url next_label preferred <<<"$next_line"
    if _next_countdown "$ep_label" "${next_label:-$display}"; then
      ep_line="$next_line"
    else
      focus="$next_url"
    fi
  done
  return 0
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

    _terminal tput smcup
    _terminal clear

    local anime_url anime_title poster
    IFS=$'\t' read -r anime_title anime_url poster <<<"$anime_line"
    _watch_anime "$anime_title" "$anime_url" "$poster"
  done
}

if [ "${ANIME_TUI_TESTING:-0}" != "1" ]; then
  run_tui
fi
#TODO: optimize speed
#TODO: refractor project
