import * as cheerio from "cheerio";

const PLAYER_LOAD = "https://animevietsub.pl/ajax/player";

export async function streams(epUrl) {
  // tap-01-111206.html -> 111206
  const episodeId = epUrl.match(/-(\d+)\.html$/)?.[1];

  if (!episodeId) {
    throw new Error("episodeId not found");
  }

  // Load backup server list
  const r1 = await fetch(PLAYER_LOAD, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: new URLSearchParams({
      episodeId,
      backup: "1",
    }),
  });

  const j1 = await r1.json();

  if (!j1.success) {
    throw new Error("failed to load backup servers");
  }

  const $ = cheerio.load(j1.html);

  // Find HDX server button
  const hdx = [...$(".btn3dsv")]
    .map((x) => $(x))
    .find((x) => x.text().includes("HDX"));

  if (!hdx) {
    throw new Error("HDX server not found");
  }

  const link = hdx.attr("data-href");
  const play = hdx.attr("data-play");
  const id = hdx.attr("data-id");

  // Resolve to real stream link
  const r2 = await fetch(PLAYER_LOAD, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: new URLSearchParams({
      link,
      play,
      id,
      backuplinks: "1",
    }),
  });

  const j2 = await r2.json();

  if (!j2.success) {
    throw new Error("failed to load stream");
  }

  return j2.link;
}
