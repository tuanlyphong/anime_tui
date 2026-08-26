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

if (marker) await fs.writeFile(marker, workDir);

const recordSignal = async () => {
  if (marker) await fs.appendFile(`${marker}.signals`, "SIGTERM\n");
  process.exit(0);
};
process.on("SIGTERM", recordSignal);

if (mode === "nonzero") {
  console.error("fake downloader failure");
  process.exit(7);
}

const segmentDir = path.join(workDir, "temp_fixture");
await fs.mkdir(segmentDir, { recursive: true });
await fs.writeFile(path.join(segmentDir, "segment_0"), segment);

if (mode === "wait") {
  setInterval(() => {}, 1000);
} else {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.writeFile(output, Buffer.concat([segment, tail]));
}
