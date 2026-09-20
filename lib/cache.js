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

const DEFAULT_TTL = 60 * 60 * 1000;

// Convert cache name to SHA1 hash for use as filename
function key(str) {
  return crypto.createHash("sha1").update(str).digest("hex");
}

// Retrieves cached data by name, returns null if not found or on error
export async function get(name, ttl = DEFAULT_TTL) {
  try {
    const entry = JSON.parse(await fs.readFile(path.join(dir, key(name)), "utf8"));
    const age = Date.now() - entry?.updated;
    // Legacy entries have no timestamp and must be refreshed once.
    if (!Number.isFinite(entry?.updated) || age < 0 || age >= ttl) return null;
    return entry.value ?? null;
  } catch {
    return null;
  }
}

// Stores data in cache with the given name
export async function put(name, value) {
  const destination = path.join(dir, key(name));
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(temporary, JSON.stringify({ updated: Date.now(), value }));
    await fs.rename(temporary, destination);
  } catch {
    // Cache failures must not turn a successful lookup into an error.
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}
