import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const tui = path.join(root, "tui_anime.sh");
const hasPtyTools = ["script", "fzf"].every((cmd) => spawnSync(cmd, ["--version"]).status === 0);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anime-pty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// util-linux script gives fzf a real controlling terminal. Exit as soon as the
// expected screen content appears; the deadline also terminates a failed probe.
async function terminal(script, marker, key = "\x1b") {
  const child = spawn("script", ["-q", "-c", `bash -c ${quote(script)}`, "/dev/null"], {
    cwd: root,
    env: { ...process.env, TERM: "xterm-256color", FZF_DEFAULT_OPTS: "", FZF_DEFAULT_OPTS_FILE: "/dev/null" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    child.stdin.write(key);
  };
  const deadline = setTimeout(stop, 5000);
  const killDeadline = setTimeout(() => child.kill("SIGTERM"), 6500);
  const collect = (chunk) => {
    output += chunk.toString();
    if (output.includes(marker)) stop();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.stdin.on("error", () => {});
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => { clearTimeout(deadline); clearTimeout(killDeadline); });
  return output;
}

test("fzf reload displays search failures in a nonselectable header", { skip: !hasPtyTools }, async (t) => {
  const directory = await fixture(t);
  const cli = path.join(directory, "cli");
  await writeFile(cli, '#!/bin/bash\nif [ -n "${2:-}" ]; then printf "HTTP_403_TEST: access denied\\n" >&2; exit 1; fi\n');
  await chmod(cli, 0o755);
  const output = await terminal(`
    stty rows 30 cols 120
    export HOME=${quote(directory)} ANIME_TUI_TESTING=1 ANIME_CLI=${quote(cli)}
    source ${quote(tui)}
    _pick_anime search kimi >${quote(path.join(directory, "selection"))}
  `, "HTTP_403_TEST");
  assert.ok(output.includes("HTTP_403_TEST"), "search error must be visible in the real fzf screen");
  assert.doesNotMatch(await readFile(path.join(directory, "selection"), "utf8"), /HTTP_403_TEST/);
});

test("fzf search status header does not consume the first selectable result", { skip: !hasPtyTools }, async (t) => {
  const directory = await fixture(t);
  const cli = path.join(directory, "cli");
  await writeFile(cli, '#!/bin/bash\nprintf "Kimi_READY\\t/anime\\t\\n"\n');
  await chmod(cli, 0o755);
  const selection = path.join(directory, "selection");
  await terminal(`
    stty rows 30 cols 120
    export HOME=${quote(directory)} ANIME_TUI_TESTING=1 ANIME_CLI=${quote(cli)}
    source ${quote(tui)}
    _pick_anime search kimi >${quote(selection)}
  `, "READY", "\r");
  assert.equal(await readFile(selection, "utf8"), "kimi\n\nKimi_READY\t/anime\t\n");
});

test("playback terminal controls do not contaminate captured history headers", { skip: !hasPtyTools }, async (t) => {
  const directory = await fixture(t);
  const cli = path.join(directory, "cli");
  await writeFile(cli, `#!/bin/bash
if [ "$1" = history ]; then printf 'Title [Tập 05]\\t/anime\\tposter\\n'; fi
`);
  await chmod(cli, 0o755);
  const header = path.join(directory, "header");
  const output = await terminal(`
    stty rows 30 cols 120
    export HOME=${quote(directory)} ANIME_TUI_TESTING=1 ANIME_CLI=${quote(cli)} PLAYER=true
    source ${quote(tui)}
    _play_and_record https://example.test/video Title /anime poster 'Tập 05' >${quote(header)}
    printf 'TERMINAL_TEST_DONE\\n' >&2
  `, "TERMINAL_TEST_DONE");
  assert.match(output, /\x1b\[/, "terminal controls should still reach the terminal");
  assert.equal(await readFile(header, "utf8"), "Title [Tập 05]");
});
