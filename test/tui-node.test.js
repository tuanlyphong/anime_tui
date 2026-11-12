import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tui = path.join(root, 'tui_anime.sh');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test('unusable default node falls back to a working per-user node', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'anime-node-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const broken = path.join(home, 'broken-bin');
  const fallback = path.join(home, '.local', 'bin');
  await mkdir(broken, { recursive: true });
  await mkdir(fallback, { recursive: true });
  await writeFile(path.join(broken, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(path.join(fallback, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const script = [
    `export ANIME_TUI_ENV_FILE=/dev/null ANIME_TUI_TESTING=1 HOME=${quote(home)}`,
    `PATH=${quote(`${broken}:${process.env.PATH}`)}`,
    `source ${quote(tui)}`,
    '_select_node',
    'command -v node',
  ].join('; ');

  const result = spawnSync('bash', ['-c', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(fallback, 'node'));
});
