import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectMpv } from './mpv.js';
import { getProgress, saveProgress, completeEpisode } from './progress.js';
import { createStatus } from './playback-status.js';
import { streamAbyss } from './abyss-progressive.js';

const validTime = value => Number.isFinite(value) && value >= 0;
const stopped = () => Object.assign(new Error('Playback stopped'), { code: 'PLAYBACK_STOPPED' });

function launch(player, args) {
  const child = spawn(player, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  let done = false;
  const exit = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => { done = true; resolve({ code, signal }); });
  });
  const kill = signal => {
    try { if (child.pid) process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  return { child, exit, async close() {
    if (!done) {
      kill('SIGTERM');
      const timer = setTimeout(() => kill('SIGKILL'), 2000);
      await exit;
      clearTimeout(timer);
    }
    kill('SIGKILL');
    child.stdin.destroy();
  } };
}

// All asynchronous session work races a single terminal event. This also allows
// cancellation while loadfile/seek is waiting for a reply or cache growth.
export async function playEpisode({ streamUrl, animeUrl, episodeUrl, label,
  player = 'mpv', playerArgs = [], progressivePlayerArgs = [], jar,
  quality = 'h', progressive = true }) {
  let directory, playerProcess, client, connecting, source, saveTimer;
  let sourceResult, sourceError, terminal, loaded = false, playing = false;
  let starting = false, observedPlayback = false;
  let position, duration, ranges = [], saveQueue = Promise.resolve();
  const status = createStatus();
  const abort = new AbortController();
  let end;
  const ended = new Promise(resolve => { end = resolve; });
  const finish = event => { if (!terminal) { terminal = event; end(event); } };
  const onSignal = () => finish({ reason: 'stop' });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, onSignal);
  const guard = promise => Promise.race([promise, ended.then(event => { throw event.error || stopped(); })]);
  const waitFor = async (predicate, timeout, message) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeout) throw new Error(message);
      await guard(delay(40));
    }
  };
  const save = () => {
    if (!playing || !observedPlayback || !validTime(position)) return saveQueue;
    const snapshot = { positionSeconds: position, durationSeconds: duration };
    saveQueue = saveQueue.then(() => saveProgress(animeUrl, episodeUrl, snapshot));
    return saveQueue;
  };
  const startSource = output => {
    source = streamAbyss({ jar, id: abyssId, quality, output, signal: abort.signal })
      .then(result => { sourceResult = result; if (!output.destroyed) output.end(); return result; })
      .catch(error => { sourceError = error; finish({ reason: 'error', error }); output.destroy(); });
    return source;
  };
  const abyssId = /abyssplayer\.com\/([^/?#]+)/.exec(streamUrl)?.[1];
  const isAbyss = Boolean(abyssId && jar);
  let result;
  try {
    const previous = await getProgress(animeUrl, episodeUrl);
    const target = previous?.state === 'unfinished' ? previous.positionSeconds : 0;
    duration = previous?.state === 'unfinished' ? previous.durationSeconds : undefined;
    directory = await mkdtemp(path.join(os.tmpdir(), 'anime-playback-'));
    const socket = path.join(directory, 'mpv.sock');
    let media = streamUrl;
    if (isAbyss && !progressive) {
      status.update({ label, phase: 'downloading' });
      media = path.join(directory, 'episode.mp4');
      const output = createWriteStream(media);
      const flushed = new Promise((resolve, reject) => { output.once('finish', resolve); output.once('error', reject); });
      // Observe rejection immediately while the source is still running.
      flushed.catch(() => {});
      await guard(startSource(output));
      if (sourceResult?.completed !== true) throw sourceError || new Error('Incomplete Abyss source');
      await guard(flushed);
    }
    const streaming = isAbyss && progressive;
    const args = [...playerArgs, ...(streaming ? progressivePlayerArgs : []),
      '--idle=yes', '--pause=yes', `--input-ipc-server=${socket}`,
      ...(streaming ? ['--cache=yes', '--cache-on-disk=yes', `--demuxer-cache-dir=${directory}`,
        `--cache-secs=${Math.max(30, target + 5)}`, '--demuxer-max-bytes=2GiB', '--demuxer-max-back-bytes=64MiB'] : [])];
    playerProcess = launch(player, args);
    playerProcess.child.stdin.on('error', error => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') finish({ reason: 'error', error });
    });
    playerProcess.exit.then(({ code, error }) => finish(error || code || !client ?
      { reason: 'error', error: error || new Error(!client ? 'Player exited before IPC tracking was established' : `Player exited with status ${code}`) } : { reason: 'quit' }));
    // Connect itself has a bounded retry deadline; close a late connection when
    // cancellation wins the race so no socket is stranded.
    connecting = connectMpv(socket);
    connecting.then(connection => { if (terminal) connection.close(); }, () => {});
    client = await guard(connecting);
    client.on('disconnect', error => {
      // A normal window close tears down IPC just before the process exits.
      // Give the exit event a short opportunity to distinguish quit from a
      // broken IPC connection on a still-running player.
      Promise.race([playerProcess.exit, delay(100).then(() => ({ error }))])
        .then(({ code, error: exitError }) => finish(exitError || code ?
          { reason: 'error', error: exitError || error } : { reason: 'quit' }));
    });
    client.on('file-loaded', () => { loaded = true; });
    client.on('end-file', event => finish(event));
    client.on('property-change', event => {
      if (event.name === 'time-pos' && validTime(event.data)) {
        position = event.data;
        if (playing || starting) observedPlayback = true;
      }
      if (event.name === 'duration' && validTime(event.data) && event.data > 0) duration = event.data;
      if (event.name === 'demuxer-cache-state') ranges = event.data?.['seekable-ranges'] || [];
      status.update({ label, phase: playing ? 'playing' : 'preparing', position, duration, target,
        buffered: ranges.find(range => range.start <= 1 && range.end >= 0)?.end });
    });
    for (const [id, property] of ['time-pos', 'duration', 'demuxer-cache-state'].entries()) {
      await guard(client.command(['observe_property', id + 1, property]));
    }
    const loading = client.command(['loadfile', streaming ? '-' : media]);
    if (streaming) startSource(playerProcess.child.stdin);
    await guard(loading);
    await waitFor(() => loaded, 30000, 'mpv did not load media');
    if (target > 0) {
      if (streaming) {
        let highWater = -1, lastGrowth = Date.now();
        while (!ranges.some(range => validTime(range.start) && validTime(range.end) && range.start <= target && range.end >= target)) {
          const buffered = Math.max(-1, ...ranges.map(range => validTime(range.end) ? range.end : -1));
          if (buffered > highWater) { highWater = buffered; lastGrowth = Date.now(); }
          if (Date.now() - lastGrowth > 60000) throw new Error('Resume target unreachable: cache stopped growing for 60 seconds; try download-first playback');
          await guard(delay(40));
        }
      }
      await guard(client.command(['seek', target, 'absolute+exact']));
      const seekDeadline = Date.now() + 5000;
      while (true) {
        const actual = await guard(client.command(['get_property', 'time-pos']));
        if (validTime(actual) && Math.abs(actual - target) <= 2) { position = actual; break; }
        if (Date.now() >= seekDeadline) throw new Error('Resume seek could not be confirmed; saved progress preserved');
        await guard(delay(40));
      }
    }
    starting = true;
    await guard(client.command(['set_property', 'pause', false]));
    playing = true;
    starting = false;
    status.update({ label, phase: 'playing', position, duration });
    saveTimer = setInterval(() => { save().catch(error => finish({ reason: 'error', error })); }, 5000);
    const event = await ended;
    if (event.error || event.reason === 'error') throw event.error || new Error('mpv playback failed');
    if (event.reason === 'eof') {
      if (source && !sourceResult) { abort.abort(); await source; }
      if (isAbyss && sourceResult?.completed !== true) throw sourceError || new Error('Incomplete Abyss source at EOF');
      if (duration && (!validTime(position) || position < duration - 2)) throw new Error('Unexpected early EOF');
      clearInterval(saveTimer);
      await saveQueue;
      await completeEpisode(animeUrl, episodeUrl);
      result = { outcome: 'finished' };
    } else result = { outcome: 'stopped' };
  } catch (error) {
    result = error.code === 'PLAYBACK_STOPPED' ? { outcome: 'stopped' } : { outcome: 'failed', error };
  } finally {
    clearInterval(saveTimer);
    if (result?.outcome !== 'finished') {
      try { await save(); } catch (error) { result = { outcome: 'failed', error }; }
    }
    abort.abort();
    client?.close();
    await playerProcess?.close();
    // The existing IPC API has no cancellation input. Drain its bounded initial
    // connection attempt after terminating the player, including late sockets.
    await connecting?.then(connection => connection.close(), () => {});
    await source;
    status.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const signal of signals) process.off(signal, onSignal);
  }
  return result;
}
