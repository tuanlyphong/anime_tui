import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const hasMpv = spawnSync('mpv', ['--version']).status === 0;

test('real mpv finishes tracked playback despite user keep-open configuration', { skip: !hasMpv }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'anime-real-eof-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // One second of silent PCM, avoiding external media/encoder dependencies.
  const wav = Buffer.alloc(44 + 16000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(16000, 40);
  const media = path.join(home, 'clip.wav');
  await writeFile(media, wav);
  const child = spawn(process.execPath, ['anime.js', 'play-episode', media, '/anime', '/episode', 'Test',
    '--player-arg', '--no-config', '--player-arg', '--ao=null', '--player-arg', '--vo=null',
    '--player-arg', '--keep-open=yes'], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 5000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timeout);
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), 'finished', 'EOF must reach the auto-next controller');
  const state = JSON.parse(await readFile(path.join(home, '.local/share/anime-tui/playback-state.json'), 'utf8'));
  assert.equal(state.anime['/anime'].episodes['/episode'].state, 'watched');
});
