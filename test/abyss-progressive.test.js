import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  chmod,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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

async function runCli({ directory, marker, mode = "success" }) {
  const stdoutPath = path.join(directory, `stdout-${mode}`);
  const stderrPath = path.join(directory, `stderr-${mode}`);
  const stdoutFile = await open(stdoutPath, "w");
  const stderrFile = await open(stderrPath, "w");
  const child = spawn(
    process.execPath,
    [cli, "abyss-stream", "fixture.jar", "episode-id", "h"],
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

async function runPlayerClose({ directory, marker }) {
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
        FAKE_JAVA_MODE: "wait",
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

test("V2 EPIPE terminates downloader and cleans workdir", async (t) => {
  const setup = await setupFakeJava(t);
  const result = await runPlayerClose(setup);
  const workDir = await readFile(setup.marker, "utf8");
  const signals = await readFile(`${setup.marker}.signals`, "utf8");

  assert.equal(result.code, 0, result.stderr);
  assert.equal(signals, "SIGTERM\n");
  assert.equal(await pathExists(workDir), false);
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
