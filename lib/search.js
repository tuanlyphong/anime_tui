import { client } from "./http.js";
import * as cache from "./cache.js";
import { parse } from "node-html-parser";

export async function search(query) {
  const cacheKey = "search:" + query;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const { data } = await client.post(
    "/ajax/suggest",
    `ajaxSearch=1&keysearch=${encodeURIComponent(query)}`,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );

  const root = parse(data);
  const list = [];

  for (const li of root.querySelectorAll("li")) {
    const a = li.querySelector("a[href*='/phim/']");
    const url = a?.getAttribute("href") ?? "";

    const titleEl = li.querySelector(".ss-title");
    const title = titleEl?.text.trim() ?? "";

    const posterEl = li.querySelector("[style*='background-image']");
    const style = posterEl?.getAttribute("style") ?? "";
    const m = style.match(/background-image:\s*url\((['"]?)([^'")]+)\1\)/);
    const poster = m ? m[2] : "";

    if (title && url) list.push({ title, url, poster });
  }

  await cache.put(cacheKey, list);
  return list;
}
