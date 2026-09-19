import { chromium } from "playwright";
import fs from "node:fs";
import { getLiveDomain } from "./http.js";

const BLOCKED = new Set([
  "image",
  "stylesheet",
  "font",
  "media",
  "ping",
  "websocket",
]);

export async function streams(epUrl) {
  // tap-01-111206.html -> 111206
  const episodeId = epUrl.match(/-(\d+)\.html$/)?.[1];

  if (!episodeId) {
    throw new Error("episodeId not found");
  }

  // The site sits behind Cloudflare and silently serves an empty body to
  // plain fetch clients, so resolve the stream inside a real browser
  // (same approach as episodes.js).

  // 1. Resolve the live origin via the gateway (cached by getLiveDomain),
  // then build the episode URL directly on that origin.
  const origin = await getLiveDomain();
  const path = epUrl.startsWith("http") ? new URL(epUrl).pathname : epUrl;
  const safeUrl = `${origin}${path.startsWith("/") ? "" : "/"}${path}`;

  // Launch headless browser
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
    (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const browser = await chromium.launch({ headless: true, executablePath });

  try {
    const page = await browser.newPage();

    // Block unnecessary resources to speed up loading
    await page.route("**/*", (route) =>
      BLOCKED.has(route.request().resourceType())
        ? route.abort()
        : route.continue(),
    );

    // 2. Navigate to the episode page. Cloudflare occasionally drops the
    // first navigation, so retry a few times on transient failures.
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto(safeUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;

    // 3. Resolve the stream link inside the browser, so Cloudflare cookies
    // and the correct origin are used for the /ajax/player requests.
    const link = await page.evaluate(async (episodeId) => {
      const post = (body) =>
        fetch("/ajax/player", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: new URLSearchParams(body),
        }).then((r) => r.json());

      // Load backup server list
      const j1 = await post({ episodeId, backup: "1" });

      if (!j1.success) {
        throw new Error("failed to load backup servers");
      }

      const doc = new DOMParser().parseFromString(j1.html, "text/html");

      // Find HDX server button
      const hdx = [...doc.querySelectorAll(".btn3dsv")].find((x) =>
        x.textContent.includes("HDX"),
      );

      if (!hdx) {
        throw new Error("HDX server not found");
      }

      // Resolve to real stream link
      const j2 = await post({
        link: hdx.getAttribute("data-href"),
        play: hdx.getAttribute("data-play"),
        id: hdx.getAttribute("data-id"),
        backuplinks: "1",
      });

      return j2.link ?? null;
    }, episodeId);

    // CHANGED: Check if the link exists, rather than looking for a 'success' boolean
    if (!link) {
      throw new Error("failed to load stream: video link missing from response");
    }

    return link;
  } finally {
    await browser.close();
  }
}
