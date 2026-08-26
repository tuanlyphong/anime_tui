import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SEGMENT_SIZE = 2 * 1024 * 1024;
const POLL_MS = 40;

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

export async function streamAbyss({ jar, id, quality = "h" }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "anime-abyss-"));
  const output = path.join(workDir, "episode.mp4");
  const logPath = path.join(workDir, "abyss-dl.log");
  const log = createWriteStream(logPath);
  const child = spawn("java", ["-jar", jar, id, quality, "-o", output], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  let childDone = false;
  let terminationRequested = false;
  const terminateChild = () => {
    if (childDone || terminationRequested) return;
    terminationRequested = true;
    child.kill("SIGTERM");
  };
  const sink = createPlayerSink(process.stdout, terminateChild);
  let childError;
  child.once("error", (error) => {
    childError = error;
    childDone = true;
  });
  const exit = new Promise((resolve) =>
    child.once("close", (code) => {
      childDone = true;
      resolve(code);
    }),
  );

  let index = 0;
  let emitted = 0;

  try {
    // Segments except the last are exactly 2 MiB. Emit only a contiguous run;
    // mpv can demux the original MP4 byte stream from stdin as it arrives.
    while (!childDone && !sink.closed) {
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

    const code = await exit;
    if (childError) throw childError;
    if (code !== 0) {
      throw new Error(`abyss-dl exited with status ${code}; log kept at ${logPath}`);
    }

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

    await new Promise((resolve) => log.end(resolve));
    await fs.rm(workDir, { recursive: true, force: true });
  } catch (error) {
    terminateChild();
    log.end();
    if (error.code === "PLAYER_CLOSED" || sink.closed && !sink.failure) {
      await Promise.race([exit, delay(2000)]);
      await fs.rm(workDir, { recursive: true, force: true });
      return;
    }
    if (sink.failure) {
      await Promise.race([exit, delay(2000)]);
      await fs.rm(workDir, { recursive: true, force: true });
    }
    throw error;
  } finally {
    sink.dispose();
  }
}
