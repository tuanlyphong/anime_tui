# SPEC

## §G GOAL
Deepen Abyss progressive playback: hide player-output lifecycle behind one sink; preserve bytes, exits, cleanup.

## §C CONSTRAINTS
- Node.js ESM; existing dependencies only.
- Refactor + output-error fix; ⊥ byte, CLI, downloader-failure behavior change.
- Existing characterization tests green before refactor; new regression tests fail before fix & green after.
- One module pass: `lib/abyss-progressive.js` player-output boundary.

## §I INTERFACES
- cmd: `node anime.js abyss-stream <jar> <id> [h|m|l]` → MP4 bytes on stdout; diagnostics on stderr.
- module: `streamAbyss({ jar, id, quality = "h" })` → resolve on complete | player close; reject on downloader/output failure.
- internal: `createPlayerSink(output, onClose)` → `{ write(buffer), closed, dispose() }`.

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

## §T TASKS
id|status|task|cites
T1|x|configure `node --test`; add fake-Java subprocess fixture|I.cmd,I.module
T2|.|add green byte-order, player-close, downloader-failure characterization tests|V1,V2,V4,V6
T3|.|add failing output-error, listener, termination regression tests|V3,V7,V8,V9
T4|.|extract `createPlayerSink`; narrow segment race catch; normalize output failures|V2,V3,V5,V7,V8,V9,I.internal
T5|.|run focused + full suite; confirm public surfaces unchanged|V1,V2,V3,V4,V5,V6,V7,V8,V9,I.cmd,I.module

## §B BUGS
id|date|cause|fix
