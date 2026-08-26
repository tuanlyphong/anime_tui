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
  output.on("error", handleOutputError);

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
    },
  };
}

async function findSegment(directory, index) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("temp_")) continue;
    const candidate = path.join(directory, entry.name, `segment_${index}`);
    try {
      if ((await fs.stat(candidate)).size >= SEGMENT_SIZE) return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // The downloader may be creating or merging files while we inspect them.
    }
  }
  return null;
}

function startDownloader({ jar, id, quality, output, log }) {
  const child = spawn("java", ["-jar", jar, id, quality, "-o", output], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  let done = false;
  let error;
  let terminationRequested = false;
  child.once("error", (childError) => {
    error = childError;
    done = true;
  });
  const exit = new Promise((resolve) =>
    child.once("close", (code) => {
      done = true;
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
    terminate() {
      if (done || terminationRequested) return;
      terminationRequested = true;
      child.kill("SIGTERM");
    },
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

export async function streamAbyss({ jar, id, quality = "h" }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "anime-abyss-"));
  const output = path.join(workDir, "episode.mp4");
  const logPath = path.join(workDir, "abyss-dl.log");
  const log = createWriteStream(logPath);
  let currentAttempt;
  const sink = createPlayerSink(process.stdout, () => currentAttempt?.terminate());
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
  const signalHandlers = Object.fromEntries(
    Object.entries(SIGNAL_EXIT_CODES).map(([signal, exitCode]) => [
      signal,
      () => {
        if (forcedCleanup) return;
        forcedCleanup = (async () => {
          currentAttempt?.terminate();
          if (currentAttempt) {
            await Promise.race([currentAttempt.exit, delay(2000)]);
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

  let index = 0;
  let emitted = 0;

  try {
    let completed = false;
    const maxAttempts = MAX_RETRIES + 1;
    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      if (attemptNumber > 1) {
        await fs.rm(output, { force: true });
        await delay(RETRY_BACKOFF_MS[attemptNumber - 2]);
        if (sink.failure) throw sink.failure;
        if (sink.closed) throw playerClosedError();
      }

      currentAttempt = startDownloader({ jar, id, quality, output, log });

      // Segments except the last are exactly 2 MiB. Emit only a contiguous run;
      // mpv can demux the original MP4 byte stream from stdin as it arrives.
      while (!currentAttempt.done && !sink.closed) {
        const segment = await findSegment(workDir, index);
        if (!segment) {
          await delay(POLL_MS);
          continue;
        }
        let data;
        try {
          data = await fs.readFile(segment);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        if (data.length < SEGMENT_SIZE) continue;
        await sink.write(data);
        emitted += data.length;
        index += 1;
      }

      if (sink.failure) throw sink.failure;
      if (sink.closed) throw playerClosedError();

      const code = await currentAttempt.exit;
      if (currentAttempt.error) throw currentAttempt.error;
      if (code !== 0) {
        throw new Error(`abyss-dl exited with status ${code}; log kept at ${logPath}`);
      }

      const size = await outputSize(output);
      if (size !== null && size >= emitted) {
        completed = true;
        break;
      }
      if (attemptNumber === maxAttempts) {
        throw incompleteError(maxAttempts, logPath);
      }
    }

    if (!completed) throw incompleteError(MAX_RETRIES + 1, logPath);

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
  } catch (error) {
    currentAttempt?.terminate();
    log.end();
    if (error.code === "PLAYER_CLOSED" || sink.closed && !sink.failure) {
      if (currentAttempt) await Promise.race([currentAttempt.exit, delay(2000)]);
      await cleanupWorkDir();
      return;
    }
    if (sink.failure) {
      if (currentAttempt) await Promise.race([currentAttempt.exit, delay(2000)]);
      await cleanupWorkDir();
    }
    throw error;
  } finally {
    sink.dispose();
    for (const [signal, handler] of Object.entries(signalHandlers)) {
      process.off(signal, handler);
    }
  }
}
