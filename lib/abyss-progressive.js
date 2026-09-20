import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SEGMENT_SIZE = 2 * 1024 * 1024;
const POLL_MS = 40;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [100, 250, 500];
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const playerClosedError = () =>
  Object.assign(new Error("PLAYER_CLOSED"), { code: "PLAYER_CLOSED" });

export function createPlayerSink(output, onClose) {
  let closed = false;
  let failure;
  let closeRequested = false;

  const close = (error) => {
    closed = true;
    if (error.code !== "EPIPE") failure ??= error;
    if (!closeRequested) {
      closeRequested = true;
      onClose();
    }
  };
  const handleOutputError = (error) => close(error);
  const handleOutputClose = () => close(Object.assign(new Error('closed'), { code: 'EPIPE' }));
  output.on("error", handleOutputError);
  output.on("close", handleOutputClose);
  if (output.destroyed) handleOutputClose();

  return {
    get closed() {
      return closed;
    },
    get failure() {
      return failure;
    },
    async write(buffer) {
      if (failure) throw failure;
      if (closed) throw playerClosedError();
      await new Promise((resolve, reject) =>
        output.write(buffer, (error) => {
          if (!error) {
            resolve();
            return;
          }
          close(error);
          reject(error.code === "EPIPE" ? playerClosedError() : error);
        }),
      );
      if (failure) throw failure;
      if (closed) throw playerClosedError();
    },
    dispose() {
      output.off("error", handleOutputError);
      output.off("close", handleOutputClose);
    },
  };
}

export function createSegmentReader(workDir) {
  let segmentDir;
  let index = 0;

  const discoverSegmentDir = async () => {
    if (segmentDir) return segmentDir;
    let entries;
    try {
      entries = await fs.readdir(workDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }

    const entry = entries.find(
      (candidate) => candidate.isDirectory() && candidate.name.startsWith("temp_"),
    );
    if (!entry) return null;
    segmentDir = path.join(workDir, entry.name);
    return segmentDir;
  };

  return {
    async readNext() {
      const directory = await discoverSegmentDir();
      if (!directory) return null;
      const candidate = path.join(directory, `segment_${index}`);
      try {
        if ((await fs.stat(candidate)).size !== SEGMENT_SIZE) return null;
        const data = await fs.readFile(candidate);
        if (data.length !== SEGMENT_SIZE) return null;
        index += 1;
        return data;
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

function startDownloader({ jar, id, quality, output, log }) {
  const child = spawn("java", ["-jar", jar, id, quality, "-o", output], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  let done = false;
  let error;
  let terminationRequested = false;
  let closed = false;
  let killTimer;
  const kill = signal => {
    try { if (child.pid) process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const terminate = () => {
    if (closed || terminationRequested) return;
    terminationRequested = true;
    kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), 2000);
  };
  child.once("error", (childError) => {
    error = childError;
    done = true;
  });
  child.once('exit', () => {
    done = true;
    // The leader can exit while descendants keep its stdio open. Start the
    // bounded group cleanup now; waiting for close first would deadlock.
    terminate();
  });
  const exit = new Promise((resolve) =>
    child.once("close", (code) => {
      done = true;
      closed = true;
      clearTimeout(killTimer);
      kill('SIGKILL');
      resolve(code);
    }),
  );

  return {
    get done() {
      return done;
    },
    get error() {
      return error;
    },
    exit,
    terminate,
  };
}

async function outputSize(output) {
  try {
    return (await fs.stat(output)).size;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const incompleteError = (attempts, logPath) =>
  Object.assign(
    new Error(
      `ABYSS_INCOMPLETE: abyss-dl produced no valid output after ${attempts} attempts; log kept at ${logPath}`,
    ),
    { code: "ABYSS_INCOMPLETE" },
  );

export async function streamAbyss({ jar, id, quality = "h", output: mediaOutput = process.stdout, signal }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "anime-abyss-"));
  const output = path.join(workDir, "episode.mp4");
  const logPath = path.join(workDir, "abyss-dl.log");
  const log = createWriteStream(logPath);
  let currentAttempt;
  const sink = createPlayerSink(mediaOutput, () => currentAttempt?.terminate());
  const abort = () => mediaOutput.destroy(Object.assign(new Error('cancelled'), { code: 'EPIPE' }));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let logClosePromise;
  let workDirCleanupPromise;

  const closeLog = () => {
    if (logClosePromise) return logClosePromise;
    logClosePromise = log.writableEnded
      ? Promise.resolve()
      : new Promise((resolve) => log.end(resolve));
    return logClosePromise;
  };
  const cleanupWorkDir = () => {
    workDirCleanupPromise ??= fs.rm(workDir, { recursive: true, force: true });
    return workDirCleanupPromise;
  };
  let forcedCleanup;
  const signalHandlers = mediaOutput !== process.stdout ? {} : Object.fromEntries(
    Object.entries(SIGNAL_EXIT_CODES).map(([signal, exitCode]) => [
      signal,
      () => {
        if (forcedCleanup) return;
        forcedCleanup = (async () => {
          currentAttempt?.terminate();
          if (currentAttempt) {
            await currentAttempt.exit;
          }
          sink.dispose();
          await closeLog();
          await cleanupWorkDir();
          process.exit(exitCode);
        })().catch(() => process.exit(exitCode));
      },
    ]),
  );
  for (const [signal, handler] of Object.entries(signalHandlers)) {
    process.on(signal, handler);
  }

  let segmentReader = createSegmentReader(workDir);
  let emitted = 0;

  try {
    let completed = false;
    let totalAttempts = 0;
    const maxAttempts = MAX_RETRIES + 1;
    const qualities = ["h", "m", "l"];
    const startQuality = qualities.indexOf(quality);
    if (startQuality < 0) throw new Error(`Invalid Abyss quality: ${quality}`);
    qualityAttempts: for (const nextQuality of qualities.slice(startQuality)) {
      if (nextQuality !== quality) {
        console.error(`Abyss quality ${quality} unavailable; falling back to ${nextQuality}`);
        // No bytes emitted: discard the old representation before changing quality.
        for (const entry of await fs.readdir(workDir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith("temp_")) {
            await fs.rm(path.join(workDir, entry.name), { recursive: true, force: true });
          }
        }
        await fs.rm(output, { force: true });
        segmentReader = createSegmentReader(workDir);
        quality = nextQuality;
      }
      for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
        if (attemptNumber > 1) {
          await fs.rm(output, { force: true });
          await delay(RETRY_BACKOFF_MS[attemptNumber - 2]);
          if (sink.failure) throw sink.failure;
          if (sink.closed) throw playerClosedError();
        }

        if (sink.failure) throw sink.failure;
        if (sink.closed) throw playerClosedError();
        totalAttempts += 1;
        currentAttempt = startDownloader({ jar, id, quality, output, log });

        // Segments except the last are exactly 2 MiB. Emit only a contiguous run;
        // mpv can demux the original MP4 byte stream from stdin as it arrives.
        while (!currentAttempt.done && !sink.closed) {
          const data = await segmentReader.readNext();
          if (!data) {
            await delay(POLL_MS);
            continue;
          }
          await sink.write(data);
          emitted += data.length;
        }

        if (sink.failure) throw sink.failure;
        if (sink.closed) throw playerClosedError();

        const code = await currentAttempt.exit;
        if (currentAttempt.error) throw currentAttempt.error;
        if (code !== 0) {
          throw new Error(`abyss-dl exited with status ${code}; log kept at ${logPath}`);
        }

        const size = await outputSize(output);
        if (size !== null && size > 0 && size >= emitted) {
          completed = true;
          break qualityAttempts;
        }
        if (attemptNumber === maxAttempts && (emitted > 0 || quality === qualities.at(-1))) {
          throw incompleteError(totalAttempts, logPath);
        }
      }
    }

    if (!completed) throw incompleteError(totalAttempts, logPath);

    // The JAR concatenates and validates all segments. Read from the first byte
    // not already sent, which also covers the short final segment and races.
    const file = await fs.open(output, "r");
    try {
      const buffer = Buffer.alloc(256 * 1024);
      let position = emitted;
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        await sink.write(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      await file.close();
    }

    await closeLog();
    await cleanupWorkDir();
    return { completed: true };
  } catch (error) {
    currentAttempt?.terminate();
    log.end();
    if (error.code === "PLAYER_CLOSED" || sink.closed && !sink.failure) {
      if (currentAttempt) await currentAttempt.exit;
      await cleanupWorkDir();
      return { completed: false };
    }
    if (sink.failure) {
      if (currentAttempt) await currentAttempt.exit;
      await cleanupWorkDir();
    }
    throw error;
  } finally {
    if (currentAttempt && !currentAttempt.done) {
      currentAttempt.terminate();
      await currentAttempt.exit;
    }
    await closeLog();
    signal?.removeEventListener('abort', abort);
    sink.dispose();
    for (const [signal, handler] of Object.entries(signalHandlers)) {
      process.off(signal, handler);
    }
  }
}
