import fs from "fs";
import os from "os";
import path from "path";

const DATA_DIR = path.join(os.homedir(), ".local", "share", "anime-tui");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

function ensureFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, "[]");
  }
}

export function loadHistory() {
  ensureFile();

  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

export function saveHistory(history) {
  ensureFile();

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

export function addHistory({ title, url, poster, latestEpisode }) {
  const history = loadHistory();

  const idx = history.findIndex((a) => a.url === url);

  const entry = {
    title,
    url,
    poster,
    latestEpisode,
    updated: Date.now(),
  };

  if (idx >= 0) {
    history[idx] = entry;
  } else {
    history.push(entry);
  }

  history.sort((a, b) => b.updated - a.updated);

  saveHistory(history);
}

export function printHistory() {
  const history = loadHistory();

  for (const anime of history) {
    console.log(
      `${anime.title} [${anime.latestEpisode}]\t${anime.url}\t${anime.poster}`,
    );
  }
}
