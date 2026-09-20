import { parse } from "node-html-parser";
import { client } from "./http.js";
import * as cache from "./cache.js";

export async function search(query = "") {
  const q = query.trim();
  if (!q) return [];

  const key = `search:${q.toLowerCase()}`;
  const cached = await cache.get(key);
  if (Array.isArray(cached)) return cached;

  const { data } = await client.post(
    "/ajax/suggest",
    new URLSearchParams({ ajaxSearch: 1, keysearch: q }),
  );
  const document = parse(data);
  const result = document
    .querySelectorAll("li:not(.ss-bottom)")
    .flatMap((li) => {
      const titleEl = li.querySelector("a.ss-title");
      const title = titleEl?.text?.trim();
      const url = titleEl?.getAttribute("href") ?? "";
      if (!title || !url) return [];
      const style = li.querySelector("a.thumb")?.getAttribute("style") ?? "";
      const poster = style.match(/url\(['"]?(.*?)['"]?\)/)?.[1] ?? "";
      return [{ title, url, poster }];
    });

  if (!result.length && !document.querySelector("li.ss-bottom #suggest-all")) {
    throw new Error("Unexpected search response: the site may be unavailable or showing a security challenge. Try again later.");
  }
  // Empty searches are cheap to repeat and should not hide newly added titles.
  if (result.length) await cache.put(key, result);
  return result;
}
