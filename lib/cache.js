// File system operations (async)
import fs from "fs/promises";
// Cryptography utilities for hashing
import crypto from "crypto";
// Path utilities for file operations
import path from "path";
// Operating system utilities
import os from "os";

// Cache directory location in user's home directory
const dir = path.join(os.homedir(), ".cache/anime-tui/json");

// Ensure cache directory exists
await fs.mkdir(dir, { recursive: true });

// Convert cache name to SHA1 hash for use as filename
function key(str) {
  return crypto.createHash("sha1").update(str).digest("hex");
}

// Retrieves cached data by name, returns null if not found or on error
export async function get(name) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, key(name)), "utf8"));
  } catch {
    return null;
  }
}

// Stores data in cache with the given name
export async function put(name, value) {
  await fs.writeFile(path.join(dir, key(name)), JSON.stringify(value));
}
