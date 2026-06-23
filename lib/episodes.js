import { chromium } from "playwright";

export async function episodes(animeUrl) {
  animeUrl = animeUrl.endsWith("/")
    ? animeUrl + "xem-phim.html"
    : animeUrl + "/xem-phim.html";

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();

    await page.goto(animeUrl, {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    await page.waitForSelector("li.episode a", {
      timeout: 30000,
    });

    return await page.evaluate(() =>
      [...document.querySelectorAll("li.episode a")].map((a) => ({
        title: a.textContent.trim(),
        name: a.title,
        url: a.href,
        id: a.dataset.id,
        hash: a.dataset.hash,
        source: a.dataset.source,
      })),
    );
  } finally {
    await browser.close();
  }
}
