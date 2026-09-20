import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { formatTime, formatStatus, createStatus } from '../lib/playback-status.js';

function output(isTTY = false, columns = 80) {
  const chunks = [];
  const stream = new Writable({ write(chunk, encoding, done) { chunks.push(chunk.toString()); done(); } });
  stream.isTTY = isTTY;
  stream.columns = columns;
  return { stream, chunks };
}

test('formats valid times without inventing invalid timestamps', () => {
  for (const [input, expected] of [[0, '00:00'], [754, '12:34'], [3661.9, '1:01:01'], [undefined, '--:--'], [null, '--:--'], [-1, '--:--'], [NaN, '--:--'], [Infinity, '--:--']]) {
    assert.equal(formatTime(input), expected);
  }
});

test('playing status uses known duration and clamps progress', () => {
  assert.match(formatStatus({ label: 'Episode 05', phase: 'playing', position: 754, duration: 1420 }, 80), /12:34.*23:40/);
  const finished = formatStatus({ phase: 'playing', position: 200, duration: 100 }, 80);
  assert.match(finished, /100%/);
  assert.doesNotMatch(finished, /200%/);
});

test('preparing status derives percentage from verified buffered timestamp and target', () => {
  const line = formatStatus({ label: 'Episode 05', phase: 'preparing', target: 754, buffered: 452 }, 120);
  assert.match(line, /Resume at 12:34/);
  assert.match(line, /60%/);
  assert.match(line, /Buffered to 07:32/);
});

test('unknown duration, position, target, or buffer remains indeterminate', () => {
  for (const state of [
    { phase: 'playing', position: 754 },
    { phase: 'playing', duration: 1420 },
    { phase: 'playing', position: 0, duration: 0 },
    { phase: 'preparing', target: 754 },
    { phase: 'preparing', buffered: 452 },
  ]) {
    const line = formatStatus(state, 120);
    assert.doesNotMatch(line, /\d+%/);
    assert.match(line, /\.\.\./);
  }
});

test('fits narrow terminal widths and removes label control sequences', () => {
  for (const width of [0, 1, 5, 20, 40, 80]) {
    const line = formatStatus({ label: '日本語 📺 Episode\n\x1b[31m05', phase: 'playing', position: 754, duration: 1420 }, width);
    assert.ok([...line].reduce((n, char) => n + (char.codePointAt(0) > 0xff ? 2 : 1), 0) <= width);
    assert.doesNotMatch(line, /[\n\r\x1b]/);
  }
});

test('non-TTY emits state transitions rather than per-position updates without escapes', () => {
  const { stream, chunks } = output();
  const status = createStatus(stream);
  status.update({ label: 'Episode 05', phase: 'preparing', target: 754 });
  status.update({ label: 'Episode 05', phase: 'preparing', target: 754, buffered: 100 });
  status.update({ label: 'Episode 05', phase: 'playing', position: 754 });
  status.update({ label: 'Episode 05', phase: 'playing', position: 755 });
  status.close();
  status.update({ phase: 'stopped' });
  assert.equal(chunks.length, 2);
  assert.match(chunks[0], /prepar/i);
  assert.match(chunks[1], /playing/i);
  assert.doesNotMatch(chunks.join(''), /[\x1b\r]/);
});

test('TTY throttles to latest update, fits width, and clears on close without delayed writes', async () => {
  const { stream, chunks } = output(true, 40);
  const status = createStatus(stream);
  status.update({ phase: 'playing', position: 1, duration: 60 });
  status.update({ phase: 'playing', position: 2, duration: 60 });
  status.update({ phase: 'playing', position: 3, duration: 60 });
  assert.equal(chunks.length, 1);
  await delay(150);
  assert.equal(chunks.length, 2);
  assert.match(chunks[1], /00:03/);
  status.update({ phase: 'playing', position: 4, duration: 60 });
  status.close();
  const count = chunks.length;
  await delay(150);
  assert.equal(chunks.length, count);
  assert.match(chunks.at(-1), /\x1b\[2K/);
  status.close();
  assert.equal(chunks.length, count);
});
