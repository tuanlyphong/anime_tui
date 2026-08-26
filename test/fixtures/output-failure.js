#!/usr/bin/env node

import fs from "node:fs/promises";
import { streamAbyss } from "../../lib/abyss-progressive.js";

const failure = Object.assign(new Error("output failed"), { code: "EIO" });
process.stdout.write = (_buffer, callback) => {
  queueMicrotask(() => callback(failure));
  return false;
};

let result;
try {
  await streamAbyss({ jar: "fixture.jar", id: "episode-id", quality: "h" });
  result = { resolved: true };
} catch (error) {
  result = { code: error.code, message: error.message };
}
await fs.writeFile(process.env.OUTPUT_FAILURE_RESULT, JSON.stringify(result));
