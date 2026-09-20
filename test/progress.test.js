import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function setup(t) {
  const home = await mkdtemp("/tmp/opencode/anime-progress-");
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  const api = await import("../lib/progress.js");
  const file = path.join(home, ".local/share/anime-tui/playback-state.json");
  return { ...api, file };
}

test("stable path and site ID identities survive domain and episode slug changes", async (t) => {
  const api = await setup(t);
  assert.equal(await api.getProgress("/phim/a", "/tap-05-123.html"), null);
  await api.saveProgress("https://old.test/phim//a/?q=1", "/phim/a/tap-05-123.html", { positionSeconds: 754, durationSeconds: 1420 });
  assert.equal((await api.getProgress("https://new.test/phim/a", "/renamed/tap-06-123.html?x=2")).positionSeconds, 754);
  await api.saveProgress("/phim/a", "https://old.test/special//ova/", { positionSeconds: 10 });
  assert.equal((await api.getProgress("/phim/a/", "https://new.test/special/ova#x")).positionSeconds, 10);
  assert.equal(await api.getProgress("/phim/b", "/tap-05-123.html"), null);
});

test("save preserves missing duration and completion removes all resume data", async (t) => {
  const api = await setup(t);
  await api.saveProgress("/a", "/tap-05-123.html", { positionSeconds: 20, durationSeconds: 100 });
  await api.saveProgress("/a", "/tap-05-123.html", { positionSeconds: 25 });
  const saved = await api.getProgress("/a", "/tap-05-123.html");
  assert.equal(saved.durationSeconds, 100);
  assert.equal(saved.state, "unfinished");
  assert.ok(Number.isFinite(saved.updatedAt));
  await api.completeEpisode("/a", "/tap-05-123.html");
  const watched = await api.getProgress("/a", "/tap-05-123.html");
  assert.deepEqual(Object.keys(watched).sort(), ["completedAt", "state"]);
  assert.equal(watched.state, "watched");
  assert.ok(Number.isFinite(watched.completedAt));
  await api.saveProgress("/a", "/tap-05-123.html", { positionSeconds: 0 });
  const replay = await api.getProgress("/a", "/tap-05-123.html");
  assert.deepEqual(Object.keys(replay).sort(), ["positionSeconds", "state", "updatedAt"]);
});

test("invalid numeric observations reject without replacing existing state", async (t) => {
  const api = await setup(t);
  await api.saveProgress("/a", "/episode", { positionSeconds: 1, durationSeconds: 2 });
  const before = await readFile(api.file, "utf8");
  for (const positionSeconds of [-1, NaN, Infinity, -Infinity, "3", null, undefined]) {
    await assert.rejects(api.saveProgress("/a", "/episode", { positionSeconds }), /positionSeconds/);
  }
  for (const durationSeconds of [-1, 0, NaN, Infinity, "3", null]) {
    await assert.rejects(api.saveProgress("/a", "/episode", { positionSeconds: 1, durationSeconds }), /durationSeconds/);
  }
  assert.equal(await readFile(api.file, "utf8"), before);
});

test("atomic replacement leaves open readers intact and concurrent writes keep every record", async (t) => {
  const api = await setup(t);
  await api.saveProgress("/a", "/first", { positionSeconds: 1 });
  const before = await readFile(api.file, "utf8");
  const reader = await open(api.file, "r");
  try {
    await Promise.all(Array.from({ length: 30 }, (_, i) => api.saveProgress("/a", `/episode-${i}`, { positionSeconds: i })));
    assert.equal(await reader.readFile("utf8"), before);
  } finally {
    await reader.close();
  }
  const document = JSON.parse(await readFile(api.file, "utf8"));
  assert.equal(document.version, 1);
  assert.equal(Object.keys(document.anime["/a"].episodes).length, 31);
  for (let i = 0; i < 30; i++) assert.equal((await api.getProgress("/a", `/episode-${i}`)).positionSeconds, i);
  assert.deepEqual(await readdir(path.dirname(api.file)), ["playback-state.json"]);
});

test("malformed documents are reported and preserved, then later writes can recover", async (t) => {
  const api = await setup(t);
  await mkdir(path.dirname(api.file), { recursive: true });
  for (const contents of ["{broken", "null", '{"version":2,"anime":{}}', '{"version":1,"anime":{"/a":{"episodes":{"bad":{"state":"unfinished","positionSeconds":-1,"updatedAt":1}}}}}']) {
    await writeFile(api.file, contents);
    await assert.rejects(api.getProgress("/a", "/episode"), /playback state/i);
    await assert.rejects(api.saveProgress("/a", "/episode", { positionSeconds: 1 }), /playback state/i);
    await assert.rejects(api.completeEpisode("/a", "/episode"), /playback state/i);
    assert.equal(await readFile(api.file, "utf8"), contents);
  }
  await rm(api.file);
  await api.saveProgress("/a", "/episode", { positionSeconds: 2 });
  assert.equal((await api.getProgress("/a", "/episode")).positionSeconds, 2);
});

test("picker prefers latest available unfinished, then next after latest completed in list order", async (t) => {
  const api = await setup(t);
  const rows = [
    { title: "05", url: "/tap-05-123.html", id: "123", hash: "keep" },
    { title: "09", url: "/tap-09-456.html", source: "keep" },
    { title: "Special", url: "/special" },
  ];
  assert.equal(await api.preferredEpisode("/a", rows), null);
  assert.deepEqual(await api.decorateEpisodes("/a", rows), rows.map(row => ({ ...row, display: row.title, preferred: false })));
  await mkdir(path.dirname(api.file), { recursive: true });
  const episodes = {
    "123": { state: "unfinished", positionSeconds: 754, durationSeconds: 1420, updatedAt: 10 },
    "456": { state: "unfinished", positionSeconds: 65, updatedAt: 20 },
    "/missing": { state: "unfinished", positionSeconds: 3, updatedAt: 100 },
  };
  const write = () => writeFile(api.file, JSON.stringify({ version: 1, anime: { "/a": { episodes } } }));
  await write();
  assert.equal(await api.preferredEpisode("/a", rows), rows[1]);
  const decorated = await api.decorateEpisodes("/a", rows);
  assert.match(decorated[0].display, /Resume 12:34 \/ 23:40/);
  assert.match(decorated[1].display, /Resume 01:05/);
  assert.equal(decorated[1].display.includes(" / "), false);
  assert.deepEqual(decorated.map(row => row.preferred), [false, true, false]);
  for (let i = 0; i < rows.length; i++) {
    assert.notEqual(decorated[i], rows[i]);
    const { display, preferred, ...original } = decorated[i];
    assert.deepEqual(original, rows[i]);
  }
  episodes["123"] = { state: "watched", completedAt: 30 };
  episodes["456"] = { state: "watched", completedAt: 20 };
  await write();
  assert.equal(await api.preferredEpisode("/a", rows), rows[1]);
  assert.match((await api.decorateEpisodes("/a", rows))[0].display, /watched/i);
  episodes["/special"] = { state: "watched", completedAt: 40 };
  await write();
  assert.equal(await api.preferredEpisode("/a", rows), rows[2]);
  assert.equal(await api.preferredEpisode("/a", []), null);
});
