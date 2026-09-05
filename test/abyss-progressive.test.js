import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-java.js", import.meta.url),
);
const outputFailureFixture = fileURLToPath(
  new URL("./fixtures/output-failure.js", import.meta.url),
);
const cli = fileURLToPath(new URL("../anime.js", import.meta.url));

async function setupFakeJava(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anime-fixture-"));
  const java = path.join(directory, "java");
  const marker = path.join(directory, "workdir");
  await chmod(fixture, 0o755);
  await symlink(fixture, java);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, marker };
}

async function runCli({ directory, marker, mode = "success", quality = "h" }) {
  const stdoutPath = path.join(directory, `stdout-${mode}`);
  const stderrPath = path.join(directory, `stderr-${mode}`);
  const stdoutFile = await open(stdoutPath, "w");
  const stderrFile = await open(stderrPath, "w");
  const child = spawn(
    process.execPath,
    [cli, "abyss-stream", "fixture.jar", "episode-id", quality],
    {
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_JAVA_MARKER: marker,
        FAKE_JAVA_MODE: mode,
      },
      stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
    },
  );
  const result = await new Promise((resolve) =>
    child.once("close", (code, signal) =>
      resolve({ code, signal }),
    ),
  );
  await Promise.all([stdoutFile.close(), stderrFile.close()]);
  return {
    ...result,
    stdout: await readFile(stdoutPath),
    stderr: await readFile(stderrPath, "utf8"),
  };
}

async function runPlayerClose({ directory, marker }, mode = "wait") {
  const stderrPath = path.join(directory, "stderr-player-close");
  const stderrFile = await open(stderrPath, "w");
  const child = spawn(
    "/bin/bash",
    [
      "-o",
      "pipefail",
      "-c",
      '"$1" "$2" abyss-stream fixture.jar episode-id h | head -c 1 >/dev/null',
      "bash",
      process.execPath,
      cli,
    ],
    {
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_JAVA_MARKER: marker,
        FAKE_JAVA_MODE: mode,
      },
      stdio: ["ignore", "ignore", stderrFile.fd],
    },
  );
  const result = await new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  await stderrFile.close();
  return { ...result, stderr: await readFile(stderrPath, "utf8") };
}

async function runOutputFailure({ directory, marker }) {
  const resultPath = path.join(directory, "output-failure-result.json");
  const child = spawn(process.execPath, [outputFailureFixture], {
    env: {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_JAVA_MARKER: marker,
      FAKE_JAVA_MODE: "wait",
      OUTPUT_FAILURE_RESULT: resultPath,
    },
    stdio: "ignore",
  });
  const close = await new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  return { ...close, result: JSON.parse(await readFile(resultPath, "utf8")) };
}

async function runForcedSignal({ directory, marker }, signal) {
  const child = spawn(
    process.execPath,
    [cli, "abyss-stream", "fixture.jar", "episode-id", "h"],
    {
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_JAVA_MARKER: marker,
        FAKE_JAVA_MODE: "wait",
      },
      stdio: "ignore",
    },
  );
  while (!await pathExists(marker)) await delay(10);
  const workDir = await readFile(marker, "utf8");
  child.kill(signal);
  const result = await new Promise((resolve) =>
    child.once("close", (code, closeSignal) =>
      resolve({ code, signal: closeSignal }),
    ),
  );
  return { ...result, workDir };
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test("T1 fake Java fixture implements downloader command shape", async (t) => {
  const { directory } = await setupFakeJava(t);
  const java = path.join(directory, "java");
  const output = path.join(directory, "episode.mp4");

  const child = spawn(java, ["-jar", "fixture.jar", "episode-id", "h", "-o", output]);
  const code = await new Promise((resolve) => child.once("close", resolve));

  assert.equal(code, 0);
  assert.equal((await readFile(output)).length, 2 * 1024 * 1024 + 4);
});

test("V1 emits contiguous byte-identical MP4", async (t) => {
  const setup = await setupFakeJava(t);
  const result = await runCli(setup);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.length, 2 * 1024 * 1024 + 4);
  assert.equal(result.stdout.subarray(0, -4).every((byte) => byte === 0x61), true);
  assert.equal(result.stdout.subarray(-4).toString(), "tail");
});

test("V23 V24 cached segment reader avoids rescans and preserves index", async (t) => {
  const { createSegmentReader } = await import("../lib/abyss-progressive.js");
  assert.equal(typeof createSegmentReader, "function");

  const workDir = await mkdtemp(path.join(os.tmpdir(), "anime-reader-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const originalReaddir = fs.readdir.bind(fs);
  let parentScans = 0;
  t.mock.method(fs, "readdir", async (...args) => {
    if (args[0] === workDir) parentScans += 1;
    return originalReaddir(...args);
  });

  const reader = createSegmentReader(workDir);
  assert.equal(await reader.readNext(), null);
  assert.equal(parentScans, 1);

  const segmentDir = path.join(workDir, "temp_fixture");
  const segment0 = path.join(segmentDir, "segment_0");
  await mkdir(segmentDir);
  await writeFile(segment0, Buffer.from("short"));
  assert.equal(await reader.readNext(), null);
  assert.equal(parentScans, 2);

  const full = Buffer.alloc(2 * 1024 * 1024, 0x61);
  await writeFile(segment0, full);
  assert.deepEqual(await reader.readNext(), full);
  assert.equal(await reader.readNext(), null);
  assert.equal(parentScans, 2);

  const segment1 = path.join(segmentDir, "segment_1");
  await writeFile(segment1, full);
  assert.deepEqual(await reader.readNext(), full);
  assert.equal(parentScans, 2);

  const notDirectory = path.join(workDir, "not-directory");
  await writeFile(notDirectory, "file");
  await assert.rejects(
    createSegmentReader(notDirectory).readNext(),
    { code: "ENOTDIR" },
  );
});

test("V2 EPIPE terminates downloader and cleans workdir", async (t) => {
  const setup = await setupFakeJava(t);
  const result = await runPlayerClose(setup);
  const workDir = await readFile(setup.marker, "utf8");
  const signals = await readFile(`${setup.marker}.signals`, "utf8");

  assert.equal(result.code, 0, result.stderr);
  assert.equal(signals, "SIGTERM\n");
  assert.equal(await pathExists(workDir), false);
});

test("V22 forced termination cleans workdir", async (t) => {
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    await t.test(signal, async (t) => {
      const setup = await setupFakeJava(t);
      const result = await runForcedSignal(setup, signal);
      t.after(() => rm(result.workDir, { recursive: true, force: true }));

      assert.equal(result.code, exitCode);
      assert.equal(result.signal, null);
      assert.equal(await pathExists(result.workDir), false);
      assert.equal(await readFile(`${setup.marker}.signals`, "utf8"), "SIGTERM\n");
    });
  }
});

test("V4 nonzero downloader retains log path", async (t) => {
  const setup = await setupFakeJava(t);
  const result = await runCli({ ...setup, mode: "nonzero" });
  const workDir = await readFile(setup.marker, "utf8");
  const logPath = path.join(workDir, "abyss-dl.log");

  assert.equal(result.code, 1);
  assert.match(result.stderr, /abyss-dl exited with status 7; log kept at /);
  assert.equal(await pathExists(logPath), true);
  await rm(workDir, { recursive: true, force: true });
});

test("V3 non-EPIPE output failure rejects original error", async () => {
  const { createPlayerSink } = await import("../lib/abyss-progressive.js");
  assert.equal(typeof createPlayerSink, "function");

  const failure = Object.assign(new Error("output failed"), { code: "EIO" });
  const output = new EventEmitter();
  output.write = (_buffer, callback) => queueMicrotask(() => callback(failure));
  let closes = 0;
  const sink = createPlayerSink(output, () => closes += 1);

  await assert.rejects(sink.write(Buffer.from("video")), (error) => error === failure);
  assert.equal(closes, 1);
  sink.dispose();
});

test("V9 sink restores listener count and closes at most once", async () => {
  const { createPlayerSink } = await import("../lib/abyss-progressive.js");
  assert.equal(typeof createPlayerSink, "function");

  const output = new EventEmitter();
  output.write = (_buffer, callback) => {
    const failure = Object.assign(new Error("player closed"), { code: "EPIPE" });
    output.emit("error", failure);
    queueMicrotask(() => callback(failure));
  };
  const baseline = output.listenerCount("error");
  let closes = 0;
  const sink = createPlayerSink(output, () => closes += 1);

  await assert.rejects(sink.write(Buffer.from("video")), /PLAYER_CLOSED/);
  sink.dispose();
  assert.equal(output.listenerCount("error"), baseline);
  assert.equal(closes, 1);
});

test("V7 V8 segment output failure propagates and cleans workdir", async (t) => {
  const setup = await setupFakeJava(t);
  const result = await runOutputFailure(setup);
  const workDir = await readFile(setup.marker, "utf8");
  const signals = await readFile(`${setup.marker}.signals`, "utf8");

  assert.equal(result.code, 0);
  assert.deepEqual(result.result, { code: "EIO", message: "output failed" });
  assert.equal(signals, "SIGTERM\n");
  assert.equal(await pathExists(workDir), false);
});

test("V10 V14 zero-exit missing output is classified incomplete", async (t) => {
  const setup = await setupFakeJava(t);
  const result = await runCli({ ...setup, mode: "incomplete" });
  const workDir = await readFile(setup.marker, "utf8");
  const attempts = Number(await readFile(`${setup.marker}.attempts`, "utf8"));

  assert.equal(result.code, 1);
  assert.match(result.stderr, /ABYSS_INCOMPLETE: .*log kept at /);
  assert.equal(attempts, 4);
  assert.equal(await pathExists(path.join(workDir, "abyss-dl.log")), true);
  assert.equal(await pathExists(workDir), true);
  await rm(workDir, { recursive: true, force: true });
});

test("V11 V12 V20 retry resumes without duplicate bytes", async (t) => {
  const setup = await setupFakeJava(t);
  const result = await runCli({ ...setup, mode: "resume" });
  const attempts = Number(await readFile(`${setup.marker}.attempts`, "utf8"));

  assert.equal(result.code, 0, result.stderr);
  assert.equal(attempts, 2);
  assert.equal(result.stdout.length, 4 * 1024 * 1024 + 4);
  assert.equal(result.stdout.subarray(0, 2 * 1024 * 1024).every((x) => x === 0x61), true);
  assert.equal(result.stdout.subarray(2 * 1024 * 1024, -4).every((x) => x === 0x62), true);
  assert.equal(result.stdout.subarray(-4).toString(), "tail");
});

test("V13 V26 emitted bytes prevent quality fallback", async (t) => {
  const setup = await setupFakeJava(t);
  const result = await runCli({ ...setup, mode: "incomplete" });
  const attempts = Number(await readFile(`${setup.marker}.attempts`, "utf8"));
  const workDir = await readFile(setup.marker, "utf8");

  assert.equal(result.code, 1);
  assert.equal(attempts, 4);
  assert.ok(result.stdout.length > 0);
  assert.equal(await readFile(`${setup.marker}.qualities`, "utf8"), "h\nh\nh\nh\n");
  await rm(workDir, { recursive: true, force: true });
});

test("V13 player close cancels pending retry", async (t) => {
  const setup = await setupFakeJava(t);
  const result = await runPlayerClose(setup, "incomplete");
  const attempts = Number(await readFile(`${setup.marker}.attempts`, "utf8"));
  const workDir = await readFile(setup.marker, "utf8");

  assert.equal(result.code, 0, result.stderr);
  assert.equal(attempts, 1);
  assert.equal(await pathExists(workDir), false);
});

for (const [quality, mode, expected, success] of [
  ["h", "fallback-medium", "hhhhm", true],
  ["h", "fallback-empty", "hhhhm", true],
  ["h", "fallback-low", "hhhhmmmml", true],
  ["m", "fallback-low", "mmmml", true],
  ["l", "fallback-none", "llll", false],
  ["h", "fallback-none", "hhhhmmmmllll", false],
]) {
  test(`V25 V26 fallback ${quality} ${mode}`, async (t) => {
    const setup = await setupFakeJava(t);
    const result = await runCli({ ...setup, mode, quality });
    assert.equal(result.code, success ? 0 : 1, result.stderr);
    assert.equal((await readFile(`${setup.marker}.qualities`, "utf8")).replaceAll("\n", ""), expected);
    if (success) {
      assert.deepEqual(result.stdout, Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 0x61), Buffer.from("tail")]));
      assert.match(result.stderr, /falling back/);
    } else {
      assert.equal(result.stdout.length, 0);
      assert.match(result.stderr, /ABYSS_INCOMPLETE/);
    }
    const workDir = await readFile(setup.marker, "utf8");
    await rm(workDir, { recursive: true, force: true });
  });
}
