import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tui = path.join(root, "tui_anime.sh");
const cli = path.join(root, "anime.js");

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return await new Promise((resolve) =>
    child.once("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    })),
  );
}

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anime-tui-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("V15 successful exit retains highest watched progress", async (t) => {
  const home = await setup(t);
  const env = { HOME: home };
  for (const episode of ["Tập 07", "Tập 03"]) {
    const result = await run(process.execPath, [cli, "history-add", "Title", "/anime", "poster", episode], { env });
    assert.equal(result.code, 0, result.stderr);
  }
  const history = JSON.parse(
    await readFile(path.join(home, ".local", "share", "anime-tui", "history.json"), "utf8"),
  );
  assert.equal(history[0].latestEpisode, "Tập 07");
});

test("V16 failed player does not record history", async (t) => {
  const directory = await setup(t);
  const log = path.join(directory, "calls");
  const script = `
    export ANIME_TUI_TESTING=1 HOME=${JSON.stringify(directory)}
    source ${JSON.stringify(tui)}
    _play() { printf 'play\\n' >>${JSON.stringify(log)}; return 1; }
    _play_and_record stream Title /anime poster 'Tập 02'
  `;
  const result = await run("/bin/bash", ["-c", script]);

  assert.equal(result.code, 1, result.stderr);
  assert.equal(await readFile(log, "utf8"), "play\n");
});

test("V17 V19 successful exit refreshes one canonical header suffix", async (t) => {
  const directory = await setup(t);
  const fakeCli = path.join(directory, "fake-cli");
  await writeFile(fakeCli, `#!/bin/bash
case "$1" in
  history-add) exit 0 ;;
  history) printf 'Title [Tập 07]\\t/anime\\tposter\\n' ;;
  completed) exit 0 ;;
esac
`);
  await chmod(fakeCli, 0o755);
  const script = `
    export ANIME_TUI_TESTING=1 HOME=${JSON.stringify(directory)} ANIME_CLI=${JSON.stringify(fakeCli)}
    source ${JSON.stringify(tui)}
    _play() { return 0; }
    _play_and_record stream 'Title [Tập 03]' /anime poster 'Tập 07'
  `;
  const result = await run("/bin/bash", ["-c", script]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "Title [Tập 07]");
});

test("V18 progressive history requires both pipeline statuses", async (t) => {
  const directory = await setup(t);
  const fakeCli = path.join(directory, "fake-cli");
  const fakePlayer = path.join(directory, "fake-player");
  await writeFile(fakeCli, "#!/bin/bash\nprintf video\nexit 1\n");
  await writeFile(fakePlayer, "#!/bin/bash\ncat >/dev/null\nexit 0\n");
  await Promise.all([chmod(fakeCli, 0o755), chmod(fakePlayer, 0o755)]);
  const script = `
    export ANIME_TUI_TESTING=1 HOME=${JSON.stringify(directory)}
    export ANIME_CLI=${JSON.stringify(fakeCli)} PLAYER=${JSON.stringify(fakePlayer)}
    export ABYSS_DL_JAR=fake.jar ABYSS_PROGRESSIVE=1
    source ${JSON.stringify(tui)}
    tput() { :; }; clear() { :; }; _warn() { :; }; notify-send() { :; }
    _play https://abyssplayer.com/id
  `;
  const result = await run("/bin/bash", ["-c", script]);

  assert.equal(result.code, 1, result.stderr);
});

test("V21 progressive stdin playback enables mpv cache", async (t) => {
  const directory = await setup(t);
  const argsLog = path.join(directory, "player-args");
  const fakeCli = path.join(directory, "fake-cli");
  const fakePlayer = path.join(directory, "fake-player");
  await writeFile(fakeCli, "#!/bin/bash\nprintf video\n");
  await writeFile(fakePlayer, `#!/bin/bash
printf '%s\\n' "$@" >${JSON.stringify(argsLog)}
cat >/dev/null
`);
  await Promise.all([chmod(fakeCli, 0o755), chmod(fakePlayer, 0o755)]);
  const script = `
    export ANIME_TUI_TESTING=1 HOME=${JSON.stringify(directory)}
    export ANIME_CLI=${JSON.stringify(fakeCli)} PLAYER=${JSON.stringify(fakePlayer)}
    export ABYSS_DL_JAR=fake.jar ABYSS_PROGRESSIVE=1
    source ${JSON.stringify(tui)}
    tput() { :; }; clear() { :; }; _warn() { :; }; notify-send() { :; }
    _play https://abyssplayer.com/id
  `;
  const result = await run("/bin/bash", ["-c", script]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(argsLog, "utf8"), /^--cache=yes$/m);
});
