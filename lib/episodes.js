import fs from "node:fs";
import * as cache from "./cache.js";

const EPISODE_CACHE_TTL = 5 * 60 * 1000;

const BLOCKED = new Set([
  "image",
  "stylesheet",
  "font",
  "media",
  "ping",
  "websocket",
]);

// Use the permanent gateway to guarantee a redirect to the live site
const GATEWAY_URL = "https://animevietsub.info";

// Proxy support via env: ANIME_TUI_PROXY="http://user:pass@host:port"
// or PLAYWRIGHT_PROXY_SERVER (Playwright standard)
function getProxyConfig() {
  const proxyUrl = process.env.ANIME_TUI_PROXY || process.env.PLAYWRIGHT_PROXY_SERVER;
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    return {
      server: `${u.protocol}//${u.host}`,
      username: u.username || undefined,
      password: u.password || undefined,
    };
  } catch {
    return { server: proxyUrl };
  }
}

export async function episodes(animeUrl) {
  // 1. Extract the path (e.g., "/phim/naruto") whether it's an absolute or relative URL
  const path = animeUrl.startsWith("http")
    ? new URL(animeUrl).pathname
    : animeUrl;
  const cacheKey = `episodes:${path.replace(/\/$/, "")}`;
  const cached = await cache.get(cacheKey, EPISODE_CACHE_TTL);
  if (Array.isArray(cached) && cached.length) return cached;
  const { chromium } = await import("playwright");

  // 2. Build the URL starting with the reliable gateway
  let safeUrl = `${GATEWAY_URL}${path.startsWith("/") ? "" : "/"}${path}`;

  // 3. Append the viewing suffix
  safeUrl = safeUrl.endsWith("/")
    ? safeUrl + "xem-phim.html"
    : safeUrl + "/xem-phim.html";

  // Launch headless browser with optional proxy
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
    (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const proxy = getProxyConfig();
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    proxy: proxy || undefined,
  });

  try {
    const page = await browser.newPage();

    // Block unnecessary resources to speed up loading
    await page.route("**/*", (route) =>
      BLOCKED.has(route.request().resourceType())
        ? route.abort()
        : route.continue(),
    );

    // 4. Playwright visits the gateway and automatically follows the 301/302 redirect to the live site!
    const response = await page.goto(safeUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    // An initial 403 can be a challenge that the browser resolves on its own.
    // Wait for the list before treating that initial status as a failure.
    try {
      await page.waitForSelector("li.episode a", { timeout: 15000 });
    } catch (error) {
      if (response && !response.ok()) {
        throw new Error(`Episode page returned HTTP ${response.status()} and no episode list appeared. Check site availability and proxy/VPN settings.`, { cause: error });
      }
      throw error;
    }

    // Scrape the episode data[cite: 4]
    const result = await page.evaluate(() =>
      [...document.querySelectorAll("li.episode a")].map((a) => ({
        title: a.textContent.trim(),
        name: a.title,
        url: a.href, // Playwright automatically resolves this to the NEW live domain!
        id: a.dataset.id,
        hash: a.dataset.hash,
        source: a.dataset.source,
      })),
    );
    if (result.length) await cache.put(cacheKey, result);
    return result;
  } finally {
    await browser.close(); // kill toàn bộ, không chờ pending requests[cite: 4]
  }
}
