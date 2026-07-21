import * as cheerio from "cheerio";
import { client } from "./http.js"; // Import the smart client, not BASE_URL!

export async function streams(epUrl) {
  // tap-01-111206.html -> 111206
  const episodeId = epUrl.match(/-(\d+)\.html$/)?.[1];

  if (!episodeId) {
    throw new Error("episodeId not found");
  }

  // Load backup server list using the smart client
  // Passing a relative path triggers the auto-domain resolution
  const { data: d1 } = await client.post(
    "/ajax/player",
    new URLSearchParams({
      episodeId,
      backup: "1",
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );

  const j1 = JSON.parse(d1);

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

  // Resolve to real stream link using the smart client
  const { data: d2 } = await client.post(
    "/ajax/player",
    new URLSearchParams({
      link,
      play,
      id,
      backuplinks: "1",
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );

  const j2 = JSON.parse(d2);

  // CHANGED: Check if the link exists, rather than looking for a 'success' boolean
  if (!j2.link) {
    throw new Error("failed to load stream: video link missing from response");
  }

  return j2.link;
}
