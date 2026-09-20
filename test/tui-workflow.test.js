import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tui = path.resolve('tui_anime.sh');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const pty = ['script', 'fzf'].every(cmd => spawnSync(cmd, ['--version']).status === 0);
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'anime-workflow-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
async function run(home, body, { terminal = false, marker, key = '' } = {}) {
  const script = `export ANIME_TUI_ENV_FILE=/dev/null ANIME_TUI_TESTING=1 HOME=${quote(home)}; source ${quote(tui)}; ${body}`;
  const child = spawn(terminal ? 'script' : 'bash', terminal ? ['-q', '-e', '-c', `bash -c ${quote(script)}`, '/dev/null'] : ['-c', script], {
    env: { ...process.env, TERM: 'xterm-256color', FZF_DEFAULT_OPTS: '', FZF_DEFAULT_OPTS_FILE: '/dev/null' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', sent = false;
  const start = Date.now();
  const timer = setTimeout(() => child.kill('SIGTERM'), 12000);
  const collect = chunk => {
    output += chunk;
    if (marker && output.includes(marker) && !sent) { sent = true; child.stdin.write(key); }
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.stdin.on('error', () => {});
  const code = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timer);
  return { code, output, elapsed: Date.now() - start };
}

const rows = 'Tập 05 · Watched\thttps://new.test/ep-five\tTập 05\t0\nTập 09 · Resume 12:34\thttps://new.test/special-nine\tTập 09\t1\nOVA_READY\thttps://new.test/ova\tOVA\t0';

// Signal only the TUI PID: a terminal's process-group signal can hide orphaning.
for (const phase of ['playing', 'preparing', 'download-first']) {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129], ['SIGINT', 130]]) {
    test(`TUI ${signal} during ${phase} reaps owned CLI/player/downloader descendants and temporary data`, async t => {
      const home = await fixture(t);
      const tmp = path.join(home, 'tmp'); await mkdir(tmp);
      const pids = path.join(home, 'pids');
      const descendant = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
      const prelude = `import {spawn} from 'node:child_process'; import {appendFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});
appendFileSync(${JSON.stringify(pids)},process.pid+' '+child.pid+'\\n');\n`;
      await writeFile(path.join(home, 'java'), `#!/usr/bin/env node\n${prelude}setInterval(()=>{},1000);`, { mode: 0o755 });
      const player = path.join(home, 'player');
      await writeFile(player, `#!/usr/bin/env node\n${prelude}await import(${JSON.stringify(path.resolve('test/fixtures/playback-player.js'))});`, { mode: 0o755 });
      const cli = path.join(home, 'cli');
      await writeFile(cli, `#!/bin/bash
case "$1" in
 episodes-progress) printf 'Episode\\t/ep\\tEpisode\\t1\\n' ;;
 streams) echo https://abyssplayer.com/id ;;
 *) echo $$ >>${quote(pids)}; exec ${quote(process.execPath)} ${quote(path.resolve('anime.js'))} "$@" ;;
esac\n`, { mode: 0o755 });
      const body = `export ANIME_TUI_TESTING=1 ANIME_TUI_ENV_FILE=/dev/null; source ${quote(tui)}
ANIME_CLI=${quote(cli)}; PLAYER=${quote(player)}; PLAYER_OPTS=--fixture=periodic; ABYSS_DL_JAR=fixture.jar; ABYSS_PROGRESSIVE=${phase === 'download-first' ? 0 : 1}
_pick_episode() { printf 'Episode\\t/ep\\tEpisode\\t1\\n'; }
_next_countdown() { touch ${quote(path.join(home, 'advanced'))}; }
${phase === 'preparing' ? `${quote(process.execPath)} --input-type=module -e "import {saveProgress} from './lib/progress.js'; await saveProgress('/series','/ep',{positionSeconds:950,durationSeconds:1000});"` : ''}
_watch_anime Title /series poster`;
      const child = spawn('bash', ['-c', body], { env: { ...process.env, HOME: home, TMPDIR: tmp, PATH: `${home}:${process.env.PATH}` }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
      const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      let owned = [];
      t.after(async () => {
        child.kill('SIGKILL');
        for (const pid of owned) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        await exited;
      });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        owned = (await readFile(pids, 'utf8').catch(() => '')).trim().split(/\s+/).filter(Boolean).map(Number);
        if (owned.length >= (phase === 'download-first' ? 3 : 5)) break;
        await new Promise(r => setTimeout(r, 30));
      }
      assert.equal(owned.length, phase === 'download-first' ? 3 : 5, output);
      await new Promise(r => setTimeout(r, 200));
      child.kill(signal);
      const result = await Promise.race([exited, new Promise(resolve => { const timer = setTimeout(() => resolve('timeout'), 9000); timer.unref(); })]);
      assert.deepEqual(result, { code, signal: null }, output);
      for (const pid of owned) {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
        assert.ok(!stat || stat.split(' ')[2] === 'Z', `surviving process ${pid}: ${stat}`);
      }
      assert.deepEqual(await readdir(tmp), []);
      assert.equal(await readFile(path.join(home, 'advanced'), 'utf8').catch(() => null), null);
      if (phase === 'preparing') {
        const state = JSON.parse(await readFile(path.join(home, '.local/share/anime-tui/playback-state.json'), 'utf8'));
        assert.equal(state.anime['/series'].episodes['/ep'].positionSeconds, 950);
      }
    });
  }
}
for (const [key, expected] of [['\r', 'special-nine'], ['\x1b[A\r', 'ep-five']]) {
  test(`real fzf preferred focus remains navigable (${expected})`, { skip: !pty }, async t => {
    const home = await fixture(t);
    const result = await run(home, `stty rows 30 cols 120; _pick_episode /series Title ${quote(rows)} >${quote(path.join(home, 'selection'))}`, { terminal: true, marker: 'OVA_READY', key });
    assert.equal(result.code, 0, result.output);
    const selection = await readFile(path.join(home, 'selection'), 'utf8');
    assert.match(selection, new RegExp(`https://new.test/${expected}\\tTập (05|09)\\t[01]\\n$`));
    assert.match(result.output, /Resume 12:34/);
  });
}

for (const [name, key, expected] of [['Enter', '\r', 0], ['Escape', '\x1b', 1], ['expiry', '', 0], ['unrelated keys', 'xxxxx', 0], ['Ctrl-C', '\x03', 130]]) {
  test(`direct tty countdown ${name}`, { skip: !pty }, async t => {
    const home = await fixture(t);
    const result = await run(home, `stty rows 30 cols 120; _next_countdown 'Tập 05' 'Tập 09' </dev/null >${quote(path.join(home, 'stdout'))}; rc=$?; exit "$rc"`, { terminal: true, marker: 'Enter:', key });
    assert.equal(result.code, expected, result.output);
    assert.equal(await readFile(path.join(home, 'stdout'), 'utf8'), '');
    if (name === 'expiry' || name === 'unrelated keys') assert.ok(result.elapsed >= 4900 && result.elapsed < 8000, `elapsed ${result.elapsed}`);
    else assert.ok(result.elapsed < 4000, `elapsed ${result.elapsed}`);
  });
}

test('countdown without a controlling terminal cancels', async t => {
  const home = await fixture(t);
  const result = await run(home, `_next_countdown 'Tập 05' 'Tập 09'`);
  assert.equal(result.code, 1);
  assert.ok(result.elapsed < 1000);
});

// Real CLI/controller/history, with only the external player replaced by an IPC fixture.
test('enhanced helper retains original metadata and passes argument arrays literally', async t => {
  const home = await fixture(t);
  const player = path.join(home, 'player');
  await writeFile(player, `#!/bin/bash\nprintf '%s\\n' "$@" >${quote(path.join(home, 'args'))}\nexec ${quote(process.execPath)} ${quote(path.resolve('test/fixtures/playback-player.js'))} "$@"\n`, { mode: 0o755 });
  const result = await run(home, `
    PLAYER=${quote(player)}
    PLAYER_OPTS=('--fixture=quit' '--title=space value' '$(touch SHOULD_NOT_EXIST)' '*.mp4')
    PROGRESSIVE_PLAYER_OPTS=('--cache=yes')
    _play_and_record video 'Title [Tập 03]' /series poster 'Tập 05' /tap-05-501.html
  `);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Title \[Tập 05\]\tstopped/);
  assert.match(await readFile(path.join(home, 'args'), 'utf8'), /--title=space value\n\$\(touch SHOULD_NOT_EXIST\)\n\*\.mp4\n/);
  const history = JSON.parse(await readFile(path.join(home, '.local/share/anime-tui/history.json'), 'utf8'));
  assert.equal(history[0].title, 'Title');
  assert.equal(history[0].latestEpisode, 'Tập 05');
  assert.equal(history[0].completed, false);
});

for (const scenario of ['finished', 'stopped', 'failed', 'unknown', 'cancel', 'stream-error', 'final']) {
  test(`episode session ${scenario} uses only finished, list order, and fresh stream resolution`, async t => {
    const home = await fixture(t);
    const log = path.join(home, 'calls');
    const cli = path.join(home, 'cli');
    const initial = scenario === 'final' ? 'https://new.test/ova' : 'https://new.test/ep-five';
    await writeFile(cli, `#!/bin/bash
printf '%s\\t' "$@" >>${quote(log)}; printf '\\n' >>${quote(log)}
case "$1" in
 episodes-progress) printf '%s\\n' ${quote(rows)} ;;
 streams)
   if [ "$2" = https://new.test/special-nine ] && [ ${quote(scenario)} = stream-error ]; then echo NEXT_SOURCE_ERROR >&2; exit 1; fi
   printf 'fresh:%s\\n' "$2" ;;
 play-episode)
   if [ "$4" = ${quote(initial)} ]; then printf '%s\\n' ${quote(['stopped', 'failed', 'unknown'].includes(scenario) ? scenario : 'finished')}; else printf 'stopped\\n'; fi ;;
 history) printf 'Title [Tập 09]\\t/series\\tposter\\n' ;;
esac
`, { mode: 0o755 });
    const result = await run(home, `
      ANIME_CLI=${quote(cli)}; _spinner() { :; }; sleep() { :; }; _terminal() { :; }
      _pick_episode() {
        if [ -e ${quote(path.join(home, 'picked'))} ]; then return 1; fi
        touch ${quote(path.join(home, 'picked'))}
        printf '%s\n' "$3" | grep ${quote(initial)}
      }
      _next_countdown() { echo countdown >>${quote(log)}; return ${scenario === 'cancel' ? 1 : 0}; }
      _watch_anime Title /series poster
    `);
    assert.equal(result.code, 0, result.output);
    const calls = await readFile(log, 'utf8');
    const advances = ['finished', 'stream-error'].includes(scenario);
    assert.equal((calls.match(/^streams\t/gm) || []).length, advances ? 2 : 1, calls);
    assert.equal((calls.match(/^countdown$/gm) || []).length, ['finished', 'cancel', 'stream-error'].includes(scenario) ? 1 : 0, calls);
    if (advances) assert.match(calls, /streams\thttps:\/\/new.test\/special-nine/);
    if (scenario === 'finished') assert.match(calls, /play-episode\tfresh:https:\/\/new.test\/special-nine\t\/series\thttps:\/\/new.test\/special-nine\tTập 09\t/);
    if (scenario === 'cancel') assert.match(calls, /episodes-progress\t\/series\thttps:\/\/new.test\/special-nine/);
    if (scenario === 'stream-error') assert.match(result.output, /NEXT_SOURCE_ERROR/);
    assert.doesNotMatch(calls, /history-complete/);
    if (['failed', 'unknown'].includes(scenario)) assert.doesNotMatch(calls, /history-add/);
  });
}
