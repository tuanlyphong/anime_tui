import { parse } from "node-html-parser";
import { client } from "./http.js";
import * as cache from "./cache.js";

export async function search(query = "") {
  const cached = await cache.get(query);

  if (cached) return cached;

  const { data } = await client.post(
    "https://animevietsub.pl/ajax/suggest",
    new URLSearchParams({
      ajaxSearch: 1,
      keysearch: query,
    }),
  );

  const root = parse(data);

  const result = [];

  for (const li of root.querySelectorAll("li")) {
    // skip the last "Enter để tìm kiếm" row
    if (li.classList.contains("ss-bottom")) continue;

    const titleEl = li.querySelector("a.ss-title");
    const thumbEl = li.querySelector("a.thumb");

    const title = titleEl?.text?.trim();
    const url = titleEl?.getAttribute("href") ?? "";

    if (!title || !url) continue;

    // poster is the background-image on the thumb <a>
    const style = thumbEl?.getAttribute("style") ?? "";
    const poster = style.match(/url\(['"]?(.*?)['"]?\)/)?.[1] ?? "";

    result.push({ title, url, poster });
  }
  await cache.put(query, result);

  return result;
}
