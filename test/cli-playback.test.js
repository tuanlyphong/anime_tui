import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const player = path.resolve('test/fixtures/playback-player.js');
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'anime-cli-play-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home };
  const run = (args) => exec(process.execPath, args, { env, timeout: 12000 }).catch(error => error);
  return { home, run, seed: code => run(['--input-type=module', '-e', code]) };
}

test('episodes-progress preserves original labels, order, and domain-independent preferred override', async t => {
  const { seed, run } = await fixture(t);
  await seed(`
    import { put } from './lib/cache.js';
    import { saveProgress, completeEpisode } from './lib/progress.js';
    await put('episodes:/series', [
      {title:'05', name:'Tập 05', url:'https://new.test/tap-05-501.html'},
      {title:'09', name:'Tập 09', url:'https://new.test/tap-09-509.html'},
      {title:'OVA', url:'https://new.test/ova'}]);
    await completeEpisode('/series', '/tap-05-501.html');
    await saveProgress('https://old.test/series', '/tap-09-509.html', {positionSeconds:754,durationSeconds:1420});
  `);
  const result = await run(['anime.js', 'episodes-progress', '/series']);
  assert.equal(result.code, undefined, result.stderr);
  assert.equal(result.stdout, 'Tập 05 · Watched\thttps://new.test/tap-05-501.html\tTập 05\t0\nTập 09 · Resume 12:34 / 23:40\thttps://new.test/tap-09-509.html\tTập 09\t1\nOVA\thttps://new.test/ova\tOVA\t0\n');
  const overridden = await run(['anime.js', 'episodes-progress', '/series', 'https://old.test/ova/']);
  assert.match(overridden.stdout, /OVA\thttps:\/\/new.test\/ova\tOVA\t1\n$/);
  assert.doesNotMatch(overridden.stdout, /Tập 09\t1/);
});

for (const [mode, outcome] of [['eof', 'finished'], ['quit', 'stopped'], ['early', 'failed'], ['self-kill', 'failed']]) {
  test(`play-episode CLI reports only ${outcome} for ${mode} and persists real IPC state`, async t => {
    const { run, home, seed } = await fixture(t);
    await seed(`import { saveProgress } from './lib/progress.js'; await saveProgress('/series', '/tap-05-501.html', {positionSeconds:20});`);
    const result = await run(['anime.js', 'play-episode', 'video', '/series', '/tap-05-501.html', 'Tập 05', '--player', player, '--player-arg', `--fixture=${mode}`]);
    assert.equal(result.stdout, `${outcome}\n`);
    assert.equal(result.code ?? 0, outcome === 'failed' ? 1 : 0);
    const state = JSON.parse(await readFile(path.join(home, '.local/share/anime-tui/playback-state.json'), 'utf8'));
    const record = state.anime['/series'].episodes['501'];
    if (outcome === 'finished') assert.deepEqual(Object.keys(record).sort(), ['completedAt', 'state']);
    else assert.equal(record.state, 'unfinished');
  });
}

test('play-episode invalid options still return a machine failure with stderr diagnostic', async t => {
  const { run } = await fixture(t);
  const result = await run(['anime.js', 'play-episode', 'video', '/series', '/episode', 'Tập 05', '--bogus']);
  assert.equal(result.stdout, 'failed\n');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /option/i);
});
