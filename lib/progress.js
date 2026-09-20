import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

// Serialize the entire read/modify/rename transaction, not just the final write.
let pendingWrite = Promise.resolve();

function stateFile() {
  return path.join(os.homedir(), ".local", "share", "anime-tui", "playback-state.json");
}

function pathname(url) {
  return new URL(url, "https://anime.invalid/").pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}

function episodeKey(url) {
  const normalized = pathname(url);
  return normalized.match(/\/tap-[^/]+-(\d+)\.html$/i)?.[1] ?? normalized;
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonnegative = (value) => Number.isFinite(value) && value >= 0;
const positive = (value) => Number.isFinite(value) && value > 0;

function validRecord(record) {
  if (!object(record)) return false;
  if (record.state === "watched") {
    return nonnegative(record.completedAt) && Object.keys(record).every(key => ["state", "completedAt"].includes(key));
  }
  return record.state === "unfinished" && nonnegative(record.positionSeconds) &&
    nonnegative(record.updatedAt) &&
    (!Object.hasOwn(record, "durationSeconds") || positive(record.durationSeconds)) &&
    Object.keys(record).every(key => ["state", "positionSeconds", "durationSeconds", "updatedAt"].includes(key));
}

async function load(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, anime: {} };
    throw error;
  }
  try {
    const document = JSON.parse(text);
    if (!object(document) || document.version !== 1 || !object(document.anime) ||
        !Object.values(document.anime).every(anime => object(anime) && object(anime.episodes) && Object.values(anime.episodes).every(validRecord))) {
      throw new Error("Invalid version or records");
    }
    return document;
  } catch (cause) {
    throw new Error(`Invalid playback state in ${file}; preserve or repair the file before retrying.`, { cause });
  }
}

async function snapshot() {
  const file = stateFile();
  await pendingWrite;
  return load(file);
}

function recordFor(document, animeUrl, episodeUrl) {
  return document.anime[pathname(animeUrl)]?.episodes[episodeKey(episodeUrl)] ?? null;
}

function update(animeUrl, episodeUrl, replacement) {
  const file = stateFile();
  const transaction = pendingWrite.then(async () => {
    const document = await load(file);
    const anime = pathname(animeUrl);
    const episode = episodeKey(episodeUrl);
    document.anime[anime] ??= { episodes: {} };
    const record = replacement(document.anime[anime].episodes[episode]);
    document.anime[anime].episodes[episode] = record;
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    return record;
  });
  // A failed operation is reported to its caller without poisoning the queue.
  pendingWrite = transaction.catch(() => {});
  return transaction;
}

export async function getProgress(animeUrl, episodeUrl) {
  return recordFor(await snapshot(), animeUrl, episodeUrl);
}

export async function saveProgress(animeUrl, episodeUrl, { positionSeconds, durationSeconds }) {
  if (!nonnegative(positionSeconds)) throw new TypeError("positionSeconds must be finite and nonnegative");
  if (durationSeconds !== undefined && !positive(durationSeconds)) throw new TypeError("durationSeconds must be finite and positive");
  return update(animeUrl, episodeUrl, previous => {
    const duration = durationSeconds ?? (previous?.state === "unfinished" ? previous.durationSeconds : undefined);
    return {
      state: "unfinished",
      positionSeconds,
      ...(duration === undefined ? {} : { durationSeconds: duration }),
      updatedAt: Date.now(),
    };
  });
}

export async function completeEpisode(animeUrl, episodeUrl) {
  return update(animeUrl, episodeUrl, () => ({ state: "watched", completedAt: Date.now() }));
}

function preferredIndex(records) {
  let unfinished = -1;
  let watched = -1;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record?.state === "unfinished" && (unfinished < 0 || record.updatedAt > records[unfinished].updatedAt)) unfinished = i;
    if (record?.state === "watched" && (watched < 0 || record.completedAt > records[watched].completedAt)) watched = i;
  }
  if (unfinished >= 0) return unfinished;
  return watched < 0 ? -1 : Math.min(watched + 1, records.length - 1);
}

export async function preferredEpisode(animeUrl, rows) {
  const document = await snapshot();
  return rows[preferredIndex(rows.map(row => recordFor(document, animeUrl, row.url)))] ?? null;
}

function timestamp(seconds) {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

export async function decorateEpisodes(animeUrl, rows) {
  const document = await snapshot();
  const records = rows.map(row => recordFor(document, animeUrl, row.url));
  const preferred = preferredIndex(records);
  return rows.map((row, index) => {
    const record = records[index];
    let display = String(row.title ?? row.name ?? "");
    if (record?.state === "watched") display += " · Watched";
    if (record?.state === "unfinished") {
      display += ` · Resume ${timestamp(record.positionSeconds)}`;
      if (record.durationSeconds !== undefined) display += ` / ${timestamp(record.durationSeconds)}`;
    }
    return { ...row, display, preferred: index === preferred };
  });
}
