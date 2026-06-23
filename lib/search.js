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
    const a = li.querySelector("a");

    const title = li.querySelector(".ss-title")?.text?.trim();

    if (!a || !title) continue;

    const style = li.querySelector(".ss-poster")?.getAttribute("style") || "";

    const poster = style.match(/url\('(.*?)'\)/)?.[1] ?? "";

    result.push({
      title,
      url: a.getAttribute("href"),
      poster,
    });
  }

  await cache.put(query, result);

  return result;
}
