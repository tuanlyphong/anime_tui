#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const outputFlag = process.argv.indexOf("-o");
const output = outputFlag >= 0 ? process.argv[outputFlag + 1] : null;

if (!output) {
  console.error("fake java: missing -o output");
  process.exit(2);
}

const workDir = path.dirname(output);
const mode = process.env.FAKE_JAVA_MODE ?? "success";
const marker = process.env.FAKE_JAVA_MARKER;
const segmentSize = 2 * 1024 * 1024;
const segment = Buffer.alloc(segmentSize, 0x61);
const tail = Buffer.from("tail");

let attempt = 1;
if (marker) {
  let attempts = 0;
  try {
    attempts = Number(await fs.readFile(`${marker}.attempts`, "utf8"));
  } catch {
    // First attempt.
  }
  attempt = attempts + 1;
  await fs.writeFile(`${marker}.attempts`, String(attempt));
}

const recordSignal = async () => {
  if (marker) await fs.appendFile(`${marker}.signals`, "SIGTERM\n");
  process.exit(0);
};
process.on("SIGTERM", recordSignal);
if (marker) await fs.writeFile(marker, workDir);

if (mode === "nonzero") {
  console.error("fake downloader failure");
  process.exit(7);
}

const quality = process.argv[5];
if (marker) await fs.appendFile(`${marker}.qualities`, `${quality}\n`);
if (mode.startsWith("fallback")) {
  const works = mode === "fallback-medium" || mode === "fallback-empty" ? "m" : mode === "fallback-low" ? "l" : null;
  if (quality !== works) {
    await fs.mkdir(path.join(workDir, "temp_stale"), { recursive: true });
    await fs.writeFile(path.join(workDir, "temp_stale", "segment_0"), "partial");
    if (mode === "fallback-empty") await fs.writeFile(output, "");
    process.exit(0);
  }
  try {
    await fs.access(path.join(workDir, "temp_stale"));
    console.error("stale quality segments survived fallback");
    process.exit(7);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const segmentDir = path.join(workDir, "temp_fixture");
await fs.mkdir(segmentDir, { recursive: true });
const firstSegment = path.join(segmentDir, "segment_0");
try {
  await fs.access(firstSegment);
} catch {
  await fs.writeFile(firstSegment, segment);
}

if (mode === "resume" && attempt > 1) {
  const secondSegment = Buffer.alloc(segmentSize, 0x62);
  await fs.writeFile(path.join(segmentDir, "segment_1"), secondSegment);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.writeFile(output, Buffer.concat([segment, secondSegment, tail]));
} else if (mode === "incomplete" || mode === "resume") {
  console.error("fake incomplete download");
} else if (mode === "wait") {
  setInterval(() => {}, 1000);
} else {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.writeFile(output, Buffer.concat([segment, tail]));
}
