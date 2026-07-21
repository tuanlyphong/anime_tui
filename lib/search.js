import { parse } from "node-html-parser";
import { client } from "./http.js";
import * as cache from "./cache.js";

export async function search(query = "") {
  const q = query.trim();
  if (!q) return []; // ① tránh gọi API với query rỗng

  const key = q.toLowerCase(); // ② normalize cache key
  const cached = await cache.get(key);
  if (cached) return cached;

  // search.js
  // ... inside export async function search(query = "")
  const { data } = await client.post(
    "/ajax/suggest", // Changed from full URL to relative path
    new URLSearchParams({ ajaxSearch: 1, keysearch: q }),
  );
  // ...
  const result = parse(data)
    .querySelectorAll("li:not(.ss-bottom)") // ③ filter trong selector, bỏ classList check
    .flatMap((li) => {
      const titleEl = li.querySelector("a.ss-title");
      const title = titleEl?.text?.trim();
      const url = titleEl?.getAttribute("href") ?? "";
      if (!title || !url) return [];
      const style = li.querySelector("a.thumb")?.getAttribute("style") ?? "";
      const poster = style.match(/url\(['"]?(.*?)['"]?\)/)?.[1] ?? "";
      return [{ title, url, poster }];
    });

  await cache.put(key, result);
  return result;
}
