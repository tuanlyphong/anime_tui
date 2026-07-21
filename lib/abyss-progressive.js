import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SEGMENT_SIZE = 2 * 1024 * 1024;
const POLL_MS = 40;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function write(buffer, isClosed) {
  if (isClosed()) throw new Error("PLAYER_CLOSED");
  await new Promise((resolve, reject) =>
    process.stdout.write(buffer, (error) => {
      if (error?.code === "EPIPE") reject(new Error("PLAYER_CLOSED"));
      else if (error) reject(error);
      else resolve();
    }),
  );
  if (isClosed()) throw new Error("PLAYER_CLOSED");
}

async function findSegment(directory, index) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("temp_")) continue;
    const candidate = path.join(directory, entry.name, `segment_${index}`);
    try {
      if ((await fs.stat(candidate)).size >= SEGMENT_SIZE) return candidate;
    } catch {
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

  let playerClosed = false;
  const handleOutputError = (error) => {
    if (error.code !== "EPIPE") throw error;
    playerClosed = true;
    child.kill("SIGTERM");
  };
  process.stdout.on("error", handleOutputError);

  let childDone = false;
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
    while (!childDone && !playerClosed) {
      const segment = await findSegment(workDir, index);
      if (!segment) {
        await delay(POLL_MS);
        continue;
      }
      try {
        const data = await fs.readFile(segment);
        if (data.length < SEGMENT_SIZE) continue;
        await write(data, () => playerClosed);
        emitted += data.length;
        index += 1;
      } catch {
        // If merging won the race, the completed output below supplies the rest.
      }
    }

    if (playerClosed) throw new Error("PLAYER_CLOSED");

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
        await write(buffer.subarray(0, bytesRead), () => playerClosed);
        position += bytesRead;
      }
    } finally {
      await file.close();
    }

    await new Promise((resolve) => log.end(resolve));
    await fs.rm(workDir, { recursive: true, force: true });
  } catch (error) {
    if (!childDone) child.kill("SIGTERM");
    log.end();
    if (error.message === "PLAYER_CLOSED" || playerClosed) {
      await Promise.race([exit, delay(2000)]);
      await fs.rm(workDir, { recursive: true, force: true });
      return;
    }
    throw error;
  } finally {
    process.stdout.off("error", handleOutputError);
  }
}
