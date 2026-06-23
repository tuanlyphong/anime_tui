import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import os from "os";

const dir = path.join(os.homedir(), ".cache/anime-tui/json");

await fs.mkdir(dir, { recursive: true });

function key(str) {
  return crypto.createHash("sha1").update(str).digest("hex");
}

export async function get(name) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, key(name)), "utf8"));
  } catch {
    return null;
  }
}

export async function put(name, value) {
  await fs.writeFile(path.join(dir, key(name)), JSON.stringify(value));
}
