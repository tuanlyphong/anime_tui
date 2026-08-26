# SPEC

## §G GOAL
Resume incomplete progressive downloads without duplicate bytes; advance latest watched only after successful player exit.

## §C CONSTRAINTS
- Node.js ESM; existing dependencies only.
- Refactor + recovery fixes; ⊥ byte | CLI behavior change.
- Existing characterization tests green before refactor; new regression tests fail before fix & green after.
- Progressive recovery scope: `lib/abyss-progressive.js`; watched-header scope: `tui_anime.sh` + tests.
- Automatic recovery ≤3 retries; same work directory/output path; existing dependencies only.
- Latest watched advances after normal player exit, including intentional close; ⊥ advance on launch/playback failure.
- Production dependencies → 0 high/critical `npm audit` findings.

## §I INTERFACES
- cmd: `node anime.js abyss-stream <jar> <id> [h|m|l]` → MP4 bytes on stdout; diagnostics on stderr.
- module: `streamAbyss({ jar, id, quality = "h" })` → resolve on complete | player close; reject on downloader/output failure.
- internal: `createPlayerSink(output, onClose)` → `{ write(buffer), closed, dispose() }`.
- internal: `createSegmentReader(workDir)` → `{ readNext(): Buffer | null }`; owns temp-dir discovery, contiguous index, completeness + transient-race policy.
- history: `run_tui` → `_play(stream)` status 0 → `history-add <anime> <url> <poster> <episode>` → next `_pick_episode` header `<canonicalTitle> [<latestEpisode>]`.

## §R RESEARCH
id|topic|finding|src
R1|resume|same `-o` parent → same `temp_<slug>_<resolution>`; complete segments reused, partial segments deleted|https://github.com/abdlhay/AbyssVideoDownloader/blob/master/src/main/kotlin/com/abmo/services/VideoDownloader.kt
R2|retry|automatic retry absent; README TODO unchecked|https://github.com/abdlhay/AbyssVideoDownloader/blob/master/README.md
R3|exit code|download exception caught + logged without nonzero exit → process exits 0|https://github.com/abdlhay/AbyssVideoDownloader/blob/master/src/main/kotlin/com/abmo/Application.kt
R4|merge safety|merge uses `output.appendBytes`; stale partial output before retry → duplicate bytes|https://github.com/abdlhay/AbyssVideoDownloader/blob/master/src/main/kotlin/com/abmo/services/VideoDownloader.kt

## §V INVARIANTS
V1: emitted bytes ! contiguous, ordered, byte-identical to completed MP4.
V2: stdout `EPIPE` → downloader `SIGTERM`, temp cleanup, successful resolve.
V3: non-`EPIPE` output error → reject with original error.
V4: downloader spawn/error/nonzero semantics ≠ changed; nonzero error retains log path.
V5: player sink alone owns output error listener, closed state, `EPIPE` translation, listener removal.
V6: success | player close → work directory removed; downloader failure → log retained.
V7: segment polling ignores only transient `ENOENT`; sink/output errors ! propagate.
V8: non-`EPIPE` output failure → downloader termination, work directory removal, rejection with original error.
V9: ∀ exit path → stdout error-listener count restored; child termination requested ≤1 time.
V10: downloader exit 0 → completed output exists & size ≥ emitted bytes; else incomplete attempt.
V11: incomplete attempt → delete stale output only, preserve segment directory, retry identical `-o` path.
V12: retry resumes from next unsent segment; ⊥ emitted byte duplication | reordering.
V13: incomplete recovery ≤3 retries with bounded backoff; player close cancels recovery.
V14: retries exhausted → reject `ABYSS_INCOMPLETE`, retain work directory + log path.
V15: normal | intentional player exit → `latestEpisode` becomes max(current, selected) after `_play` returns.
V16: stream resolution | player launch | playback failure → ⊥ `latestEpisode` advance.
V17: successful player exit → reloaded episode-picker header shows `<canonicalTitle> [<latestEpisode>]`.
V18: progressive history advance → downloader status 0 & player status 0.
V19: episode-picker header → canonical title + exactly one `[latestEpisode]` suffix.
V20: each downloader attempt owns one child; termination requested ≤1 per child; sink listener survives attempt replacement.
V21: progressive stdin playback → player launched with cache enabled.
V22: `SIGINT` | `SIGTERM` | `SIGHUP` → active downloader terminated, work directory removed, exit status `128 + signal`.
V23: first successful `temp_*` discovery → cache path; subsequent polls perform 0 parent-directory scans; retries preserve cached path + next unsent index.
V24: segment reader advances only after exact `SEGMENT_SIZE` read; `ENOENT` | short read → null without index advance; other fs errors propagate.

## §T TASKS
id|status|task|cites
T1|x|configure `node --test`; add fake-Java subprocess fixture|I.cmd,I.module
T2|x|add green byte-order, player-close, downloader-failure characterization tests|V1,V2,V4,V6
T3|x|add failing output-error, listener, termination regression tests|V3,V7,V8,V9
T4|x|extract `createPlayerSink`; narrow segment race catch; normalize output failures|V2,V3,V5,V7,V8,V9,I.internal
T5|x|run focused + full suite; confirm public surfaces unchanged|V1,V2,V3,V4,V5,V6,V7,V8,V9,I.cmd,I.module
T6|x|add false-success + incomplete-output regression fixture|V10,V14,R3
T7|x|add resume, no-duplicate, retry-limit, player-close tests|V1,V2,V11,V12,V13,V20,R1,R4
T8|x|implement bounded same-workdir downloader retry lifecycle|V10,V11,V12,V13,V14,V20,I.module
T9|x|run full suite + live early-close smoke test|V1,V2,V3,V4,V5,V6,V7,V8,V9,V10,V11,V12,V13,V14,I.cmd,I.module
T10|x|add player-exit, pipeline-status, highest-progress, header regression tests|V15,V16,V17,V18,V19,I.history
T11|x|return `_play` status; move `history-add`; refresh canonical header suffix|V15,V16,V17,V18,V19,I.history
T12|x|run shell syntax + full suite; smoke intentional close|V15,V16,V17,V18,V19,I.history
T13|x|add progressive player-args regression; enable stdin cache|V21,I.history
T14|x|add forced-signal cleanup lifecycle + regression|V22,I.cmd,I.module
T15|x|extract cached segment reader; add scan-count + byte/retry regression tests|V1,V7,V11,V12,V23,V24,I.internal

## §B BUGS
id|date|cause|fix
B1|2026-08-26|truncated segment logged error but downloader exited 0; wrapper opened absent output|V10,V11,V12,V13,V14
B2|2026-08-26|`cheerio@1.2.0` locked vulnerable `undici@7.28.0`|§C dependency audit
B3|2026-08-26|progressive MP4 stdin lacked forced player cache → audio track unavailable|V21
B4|2026-08-26|forced shell signal bypassed async work-directory cleanup|V22
B5|2026-08-26|fake downloader ready marker preceded signal-handler install → V22 test race|V22
