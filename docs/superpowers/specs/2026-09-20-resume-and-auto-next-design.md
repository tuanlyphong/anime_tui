# Episode Resume, Progress Display, and Auto-Next

## Approval and objective

The user approved this behavior in chat:

- Remember the playback position and duration of unfinished episodes.
- Resume an episode automatically when it is selected again.
- Focus the most recently watched unfinished episode in the episode picker.
- Resume Abyss streams progressively, buffering to the saved timestamp rather
  than requiring a complete download first.
- Display visual progress during resume preparation and playback.
- Advance to the next episode after a cancellable five-second countdown.
- On completion, clear position, duration, and all other resume-only data.

This document records the approved design and its implementation boundaries.

## Current behavior and constraints

`tui_anime.sh` owns search, episode selection, stream resolution, and player
launching. `anime.js` exposes the Node CLI. `lib/history.js` records an anime's
highest watched episode label and manually managed series-completed flag; it
does not record episode playback positions.

Abyss progressive playback runs `anime.js abyss-stream ... | mpv -`.
`lib/abyss-progressive.js` emits contiguous video segments and stops the Java
downloader when the player closes its input. A successful process exit alone
does not distinguish a user quitting from an episode finishing.

The workspace already contains uncommitted, verified search/cache/error-handling
improvements and user dependency edits. Preserve those changes during this work.

### Global constraints

- Use Node.js ES modules, Bash, existing mpv, and the bundled Abyss downloader.
- Add no runtime npm dependencies.
- Keep fzf navigation in Bash; use Node for player IPC and playback state.
- Keep stdout reserved for CLI data; send progress and diagnostics to stderr.
- The enhanced playback workflow requires an mpv-compatible player with JSON IPC.
- Preserve existing search, episode-cache, history, quality-fallback, and cleanup behavior.
- Do not automatically mark an entire anime series completed.
- Do not use player exit code zero alone as evidence of episode completion.
- Progress save interval: 5 seconds.
- Auto-next countdown: 5 seconds.

## Architecture

### Persistent episode state

Add `lib/progress.js` to own episode identity, state validation, atomic persistence,
completion transitions, and preferred-episode selection.

Store the new data in
`~/.local/share/anime-tui/playback-state.json`, independently of existing history.
Use a versioned document containing anime records and their episode records.
Identify anime by normalized URL pathname, not hostname. Identify episodes by
their stable site ID, falling back to normalized pathname when an ID is absent.
This preserves progress across live-domain changes and stream URL refreshes.

An unfinished record contains:

- `state: "unfinished"`
- `positionSeconds`: last valid played position
- `durationSeconds`: total duration, only when known and valid
- `updatedAt`: time of the last observed playback update

A completed record contains only:

- `state: "watched"`
- `completedAt`: completion time

Completion replaces the unfinished record. It must not leave a zeroed position,
old duration, resume timestamp, or hidden copy of resume data in another record.
Replaying a watched episode does not recreate unfinished state until actual
playback has begun.

Accept only finite, nonnegative positions and finite, positive durations. Missing
IPC properties must not overwrite valid values. Write a temporary file beside
the destination, then rename it atomically. If a state file is malformed, report
the problem and preserve it rather than silently replacing all stored progress.

Existing `history.json` remains compatible. An old episode label does not imply
a saved position or a confirmed episode-completed event. Its highest-episode
tracking and manually toggled series-completed flag remain available.

### Player controller

Add a focused `lib/mpv.js` module for JSON IPC connections, request/reply matching,
property observations, and player-event delivery. Use a unique temporary socket
for every playback session.

Add `lib/playback.js` to coordinate the player, media source, saved state,
progress display, completion classification, and cleanup. It reports one of
three outcomes to the TUI: `finished`, `stopped`, or `failed`.

Observe mpv's playback position, duration, seekable cache ranges, and `end-file`
reason. Save progress every five seconds while playing and flush the most recent
valid observation when playback stops. Keep observations in memory between writes.

For direct streams and completed local files, use normal seeking and verify the
seek before considering the resume operation successful. For progressive Abyss,
use the resume preparation described below. The TUI passes anime/episode identity
and presentation metadata to the controller rather than attempting to infer them
from a temporary stream URL or stdin filename.

An mpv IPC connection failure is a visible playback error. Do not fabricate
progress, mark completion, or auto-advance when tracking could not be established.

### Progressive resume

For an unfinished Abyss episode:

1. Load the saved position before launching the player.
2. Start mpv paused with disk-backed packet caching and cache-based seeking enabled.
3. Start the existing progressive downloader and feed its contiguous output to mpv.
4. Increase read-ahead sufficiently to buffer the resume target and a five-second
   playback margin; ensure byte limits do not silently stop preparation early.
5. Observe actual seekable cache ranges. The target must lie inside a valid
   range; a downloaded byte count alone does not prove it is seekable.
6. Seek to the saved timestamp and confirm the resulting playback position.
7. Begin playback, then enable normal progress persistence.

Preparing resume must never overwrite the saved position with mpv's initial
position of zero. If the user closes the player before resume succeeds, keep the
original unfinished record unchanged.

Packet caching uses temporary disk storage, not an unbounded in-memory episode
buffer. Resume preparation uses a maximum forward packet-cache budget of 2 GiB
and a back-buffer budget of 64 MiB. Abort preparation if the target remains
unreachable with no seekable-range growth for 60 seconds; a growing cache may
continue preparing. If cache limits, source failure, or unsupported media prevent
resuming, show an actionable error and preserve the saved position. Do not silently
restart at zero or label a failed seek as resumed.

A first-time episode retains progressive startup. `ABYSS_PROGRESSIVE=0` retains
download-first operation but gains the same position tracking and resume behavior
once its local file is ready.

The first implementation checkpoint must verify paused buffering and cache seeking
against real mpv, including a timestamp beyond the current default read-ahead cache.
If that mechanism cannot satisfy the design, stop and report the evidence before
substituting a different media transport.

### Completion classification

Treat an episode as finished only after confirmed natural completion:

- mpv reports `end-file` with reason `eof`;
- the player did not fail or receive an intentional user-stop request;
- the progressive source did not fail or terminate with incomplete media;
- available position/duration evidence is consistent with reaching the end.

The progressive source currently treats player-closed cancellation as a normal
exit. Its interface therefore needs an explicit distinction between complete
media delivery and cancellation; a zero exit code cannot establish that distinction.

Unexpected early EOF, decoder errors, failed downloads, `quit`, and `stop` do not
clear resume data and do not trigger auto-next. When no reliable duration is
available, do not invent one; require the remaining completion evidence.

On confirmed completion, atomically replace the progress record with the watched
record before returning `finished` to the TUI. A persistence failure prevents
auto-next and is shown to the user instead of claiming the record was cleared.

### Visual progress

Add `lib/playback-status.js` for time formatting and terminal rendering. Keep
rendering separate from state persistence and player orchestration.

During resume preparation, show progress toward the saved timestamp based on
the contiguous seekable range containing the start of the episode:

```text
Preparing episode 05 · Resume at 12:34
[████████████░░░░░░░░] 60% · Buffered to 07:32
```

During playback, show played position against known duration:

```text
Episode 05  [███████████░░░░░░░░░] 12:34 / 23:40
```

When no reliable target, duration, or cache range is available, show an
indeterminate indicator and the available timestamp rather than a guessed
percentage. mpv keeps its normal on-screen controls.

Render only to a terminal-backed stderr, throttle redraws, and fit the available
width. Noninteractive use receives concise state-transition messages without
cursor-control sequences. Clear the status display before errors and on exit.

### Episode picker

Annotate unfinished rows with `Resume 12:34 / 23:40`; omit the total when unknown.
Annotate completed rows with a watched marker. Preserve the URL and other machine
fields used by the TUI rather than parsing them from decorated display labels.

On entry, focus the most recently updated unfinished episode that still exists
in the available episode list. Keep all episodes visible and searchable; do not
filter the list to the preferred episode.

If no unfinished episode exists, prefer the next available episode after the
most recently completed one. If there is no next episode, focus that completed
episode. With no usable progress state, retain the existing initial selection.

Following countdown cancellation, explicitly focus the proposed next episode,
even if another unfinished episode would normally be preferred.

### Auto-next

Only the `finished` outcome starts auto-next. Determine the next episode from the
same displayed episode ordering; do not manufacture a URL by incrementing a number.
Resolve its stream freshly when the countdown completes.

```text
Episode 05 finished · Episode 06 starts in 5s
Enter: play now · Esc: cancel
```

- Five elapsed seconds or Enter starts the next episode.
- Escape cancels and returns to the picker, focused on that next episode.
- Ctrl-C follows the normal TUI shutdown path without launching another player.
- With no next available episode, return to the picker immediately.
- Failure to resolve or play the next episode returns to selection with an error.
- Read countdown input from the controlling terminal, not video stdin or captured stdout.
- Start no background next-episode download during the countdown.

### Cleanup and lifecycle

Every session owns its player, downloader, IPC socket, observers, timers, and
temporary disk cache. Clean them up on normal finish, manual stop, failure, and
handled termination signals. Give terminated children a two-second grace period
before escalating to forced termination; do not leave a player or downloader orphaned.

Preserve diagnostic downloader logs on failure according to the existing behavior.
Normal completion and cancellation remove temporary media/cache data. Persistent
progress is not stored in those temporary directories.

## Files and responsibilities

| File | Responsibility |
| --- | --- |
| `lib/progress.js` | Stable identity, persistence, completion clearing, preferred selection |
| `lib/mpv.js` | mpv JSON IPC connection, commands, properties, events |
| `lib/playback.js` | Media/player lifecycle, progressive resume, outcome classification |
| `lib/playback-status.js` | Time formatting and visual progress rendering |
| `lib/abyss-progressive.js` | Preserve segment/retry behavior; expose reliable completion versus cancellation |
| `anime.js` | Playback and progress-aware episode CLI entry points |
| `tui_anime.sh` | Focused episode selection, tracked playback invocation, countdown and next selection |
| `lib/history.js` | Compatibility with existing anime history and domain-independent matching where needed |
| `README.md` | Resume behavior, progress display, countdown controls, mpv requirement |
| `test/` | State, IPC, lifecycle, completion, picker, countdown, and terminal regressions |

## Verification and acceptance criteria

1. Save an unfinished position, restart the CLI, and resume that episode at the
   saved timestamp, with the first confirmed position within two seconds of the target.
2. Resume a progressive Abyss episode beyond the default mpv cache window without
   requiring the entire file to finish downloading first.
3. Cancel preparation and verify that the prior saved position and duration remain unchanged.
4. Verify periodic saves and a final save after manual player closure.
5. Complete an episode and verify that its stored record contains no position,
   duration, or other resume-only fields, while retaining watched status.
6. Simulate quit, failed seek, downloader failure, and premature EOF; verify that
   none clears unfinished progress or launches the next episode.
7. Verify stable progress lookup after a hostname change and compatibility with
   existing history records lacking playback data.
8. In a real fzf terminal, verify preferred focus, visible annotations, ordinary
   search/navigation, and clean machine-readable selection output.
9. Verify countdown expiry, Enter, Escape, Ctrl-C, next-stream failure, and the
   final available episode without accidentally marking the series completed.
10. Verify progress bars against actual timestamps/cache ranges, unknown-duration
    display, narrow terminal behavior, and noninteractive output cleanliness.
11. Verify source completion versus cancellation and cleanup of player, downloader,
    sockets, timers, and disk caches on every exit path.
12. Run the complete existing test suite, shell syntax checks, and a live episode-5
    stop/reopen/resume probe. Use isolated playback-state data for automated/live
    validation so the user's actual watch progress is not overwritten.

## Implementation sequence

1. Validate the selected progressive-resume mechanism with a disposable mpv probe.
2. Implement and test stable episode state and completion clearing.
3. Implement and test IPC, tracked playback, resume preparation, and status display.
4. Integrate progress-aware selection and the five-second countdown in the TUI.
5. Run regressions, code review, and live resume verification; document results.

The next artifact is a task-by-task implementation plan derived from this spec.
