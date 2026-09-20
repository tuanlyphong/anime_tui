import { chromium } from "playwright";
import fs from "node:fs";
import { getLiveDomain, REQUEST_TIMEOUT_MS } from "./http.js";

const BLOCKED = new Set([
  "image",
  "stylesheet",
  "font",
  "media",
  "ping",
  "websocket",
]);

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

    // Detect Cloudflare challenge page (common with VPN/proxy IPs)
    const challengeDetected = await page.evaluate(() => {
      return !!document.querySelector("#challenge-running, #challenge-form, .cf-browser-verification, [data-ray]") ||
        document.body.innerText.includes("Đang Kiểm Tra Bảo Mật") ||
        document.title.includes("Kiểm Tra Bảo Mật");
    });
    if (challengeDetected) {
      throw new Error("Cloudflare challenge detected - VPN/proxy IP blocked. Try disabling VPN or using a different exit node.");
    }

    // 3. Resolve the stream link inside the browser, so Cloudflare cookies
    // and the correct origin are used for the /ajax/player requests.
    const link = await page.evaluate(async ({ episodeId, timeoutMs }) => {
      const post = async (body) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch("/ajax/player", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
            },
            body: new URLSearchParams(body),
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new Error(`Stream API returned HTTP ${response.status}. Check site availability and proxy/VPN settings.`);
          }
          return await response.json();
        } catch (error) {
          if (controller.signal.aborted) {
            throw new Error(`Stream API request timed out after ${timeoutMs} ms. Try again or check your connection.`);
          }
          if (error instanceof SyntaxError) {
            throw new Error("Unexpected stream API response: the site may be showing a security challenge. Try again later.");
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
      };

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
    }, { episodeId, timeoutMs: REQUEST_TIMEOUT_MS });

    // CHANGED: Check if the link exists, rather than looking for a 'success' boolean
    if (!link) {
      throw new Error("failed to load stream: video link missing from response");
    }

    return link;
  } finally {
    await browser.close();
  }
}
