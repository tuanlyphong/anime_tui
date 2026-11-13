import * as cheerio from "cheerio";
import { client } from "./http.js";
import * as cache from "./cache.js";

// The suggest endpoint only returns the six dropdown entries. The full search
// page has paginated results, so fetch a bounded number of pages and merge
// them with the suggestions.
const SEARCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "vi,en;q=0.9",
};
const configuredPages = Number(process.env.ANIME_TUI_SEARCH_PAGES);
export const MAX_SEARCH_PAGES =
  Number.isSafeInteger(configuredPages) && configuredPages > 0
    ? configuredPages
    : 10;
const CHALLENGE_ERROR =
  "Unexpected search response: the site may be unavailable or showing a security challenge. Try again later.";

function parseSuggestions(data) {
  const $ = cheerio.load(data);
  const result = [];
  $("li").not(".ss-bottom").each((_, li) => {
    const titleEl = $(li).find("a.ss-title").first();
    const title = titleEl.text().trim();
    const url = titleEl.attr("href") ?? "";
    if (!title || !url) return;
    const style = $(li).find("a.thumb").attr("style") ?? "";
    const poster = style.match(/url\(['"]?(.*?)['"]?\)/)?.[1] ?? "";
    result.push({ title, url, poster });
  });
  if (!result.length && !$("li.ss-bottom #suggest-all").length) {
    throw new Error(CHALLENGE_ERROR);
  }
  return result;
}

function parseSearchPage(data) {
  const $ = cheerio.load(data);
  const rows = [];
  $("li.TPostMv article").each((_, article) => {
    const link = $(article).find("a[href]").first();
    const title =
      $(article).find("h2.Title").first().text().trim() ||
      $(article).find(".Title").first().text().trim();
    const url = link.attr("href") ?? "";
    if (!title || !url) return;
    const poster = $(article).find("img").first().attr("src") ?? "";
    rows.push({ title, url, poster });
  });

  const noResults = $(".movie-list-noresult").length > 0;
  if (!rows.length && !noResults) throw new Error(CHALLENGE_ERROR);

  const pageText = $(".wp-pagenavi .pages").first().text();
  const pages = Number(pageText.match(/của\s+(\d+)/i)?.[1] ?? 1);
  return {
    rows,
    pages: Number.isSafeInteger(pages) && pages > 0 ? pages : 1,
    noResults,
  };
}

function searchPagePath(query, page) {
  const base = `/tim-kiem/${encodeURIComponent(query)}/`;
  return page === 1 ? base : `${base}trang-${page}.html`;
}

async function fetchSearchPages(query) {
  const requestPage = async (page) => {
    const { data } = await client.get(searchPagePath(query, page), {
      headers: SEARCH_HEADERS,
    });
    return parseSearchPage(data);
  };

  const first = await requestPage(1);
  const last = Math.min(first.pages, MAX_SEARCH_PAGES);
  const rows = [...first.rows];

  if (last > 1) {
    // Follow a few pages concurrently. A transient failure on one page must
    // not discard the results that already loaded.
    const remaining = last - 1;
    let next = 0;
    const worker = async () => {
      while (next < remaining) {
        const index = next++;
        try {
          rows.push(...(await requestPage(index + 2)).rows);
        } catch {
          // Keep the pages that succeeded.
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, remaining) }, () => worker()),
    );
  }

  return { rows, noResults: first.noResults && rows.length === 0 };
}

export async function search(query = "") {
  const q = query.trim();
  if (!q) return [];

  const key = `search:v2:${q.toLowerCase()}`;
  const cached = await cache.get(key);
  if (Array.isArray(cached)) return cached;

  const [suggested, pages] = await Promise.allSettled([
    client
      .post("/ajax/suggest", new URLSearchParams({ ajaxSearch: 1, keysearch: q }))
      .then(({ data }) => parseSuggestions(data)),
    fetchSearchPages(q),
  ]);

  const suggestRows = suggested.status === "fulfilled" ? suggested.value : [];
  const pageRows = pages.status === "fulfilled" ? pages.value.rows : [];
  const result = [];
  const seen = new Set();
  for (const row of [...suggestRows, ...pageRows]) {
    if (!row.url || seen.has(row.url)) continue;
    seen.add(row.url);
    result.push(row);
  }

  if (!result.length) {
    const validEmpty =
      pages.status === "fulfilled" &&
      (pages.value.noResults || suggested.status === "fulfilled");
    if (!validEmpty) {
      throw (
        (pages.status === "rejected" && pages.reason) ||
        (suggested.status === "rejected" && suggested.reason) ||
        new Error(CHALLENGE_ERROR)
      );
    }
    return [];
  }

  // Empty searches are cheap to repeat and should not hide newly added titles.
  await cache.put(key, result);
  return result;
}
