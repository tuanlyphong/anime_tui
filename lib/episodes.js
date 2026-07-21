import { chromium } from "playwright";

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

export async function episodes(animeUrl) {
  // 1. Extract the path (e.g., "/phim/naruto") whether it's an absolute or relative URL
  const path = animeUrl.startsWith("http")
    ? new URL(animeUrl).pathname
    : animeUrl;

  // 2. Build the URL starting with the reliable gateway
  let safeUrl = `${GATEWAY_URL}${path.startsWith("/") ? "" : "/"}${path}`;

  // 3. Append the viewing suffix
  safeUrl = safeUrl.endsWith("/")
    ? safeUrl + "xem-phim.html"
    : safeUrl + "/xem-phim.html";

  // Launch headless browser
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();

    // Block unnecessary resources to speed up loading
    await page.route("**/*", (route) =>
      BLOCKED.has(route.request().resourceType())
        ? route.abort()
        : route.continue(),
    );

    // 4. Playwright visits the gateway and automatically follows the 301/302 redirect to the live site!
    await page.goto(safeUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for the episode list to render[cite: 4]
    await page.waitForSelector("li.episode a", { timeout: 15000 });

    // Scrape the episode data[cite: 4]
    return await page.evaluate(() =>
      [...document.querySelectorAll("li.episode a")].map((a) => ({
        title: a.textContent.trim(),
        name: a.title,
        url: a.href, // Playwright automatically resolves this to the NEW live domain!
        id: a.dataset.id,
        hash: a.dataset.hash,
        source: a.dataset.source,
      })),
    );
  } finally {
    await browser.close(); // kill toàn bộ, không chờ pending requests[cite: 4]
  }
}
