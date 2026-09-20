// http.js
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const GATEWAY_URL = "https://animevietsub.info";
const HEADERS = { "User-Agent": "Mozilla/5.0" };
const DOMAIN_CACHE = path.join(
  os.homedir(),
  ".cache",
  "anime-tui",
  "live-domain.json",
);
const DOMAIN_CACHE_TTL = 60 * 60 * 1000;
const configuredTimeout = Number(process.env.ANIME_TUI_REQUEST_TIMEOUT_MS);
export const REQUEST_TIMEOUT_MS = Number.isSafeInteger(configuredTimeout) &&
  configuredTimeout > 0 && configuredTimeout <= 2147483647 ? configuredTimeout : 15000;

async function request(url, { discoverOrigin = false, ...options } = {}) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...options,
      headers: { ...HEADERS, ...options.headers },
      signal,
    });
    // Domain discovery only needs the redirect destination. Its landing page
    // can require a browser even when the site's search API accepts plain HTTP.
    if (!res.ok && !(discoverOrigin && res.redirected)) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}. Check site availability and proxy/VPN settings.`);
    }
    // Consume the body inside the timeout/error boundary too.
    return { data: await res.text(), url: res.url };
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`Request to ${new URL(url).hostname} timed out after ${REQUEST_TIMEOUT_MS} ms. Try again or check your connection.`, { cause: error });
    }
    throw error;
  }
}

// Variable to hold the resolved domain in memory
let ACTIVE_DOMAIN = null;

// Automatically resolves the gateway redirect to find the live domain
export async function getLiveDomain() {
  if (ACTIVE_DOMAIN) return ACTIVE_DOMAIN;

  try {
    const cached = JSON.parse(await fs.readFile(DOMAIN_CACHE, "utf8"));
    if (
      typeof cached.origin === "string" &&
      Date.now() - cached.updated < DOMAIN_CACHE_TTL
    ) {
      ACTIVE_DOMAIN = cached.origin;
      return ACTIVE_DOMAIN;
    }
  } catch {
    // Missing, expired, or invalid cache: resolve the gateway below.
  }

  try {
    // A HEAD request is faster because it doesn't download the page body.
    // fetch() automatically follows redirects by default.
    const res = await request(GATEWAY_URL, {
      method: "HEAD",
      discoverOrigin: true,
    });

    // res.url holds the final destination after the redirect (e.g., https://animevietsub.meme/)
    const url = new URL(res.url);

    // .origin strips away any trailing slashes or paths, leaving just the base URL
    ACTIVE_DOMAIN = url.origin;
    try {
      await fs.mkdir(path.dirname(DOMAIN_CACHE), { recursive: true });
      await fs.writeFile(
        DOMAIN_CACHE,
        JSON.stringify({ origin: ACTIVE_DOMAIN, updated: Date.now() }),
      );
    } catch {
      // The in-memory value is still usable when the disk cache is unwritable.
    }
    return ACTIVE_DOMAIN;
  } catch (err) {
    console.error("[Auto-Config] Failed to resolve gateway.", err);
    // Absolute fallback just in case the gateway itself is down
    ACTIVE_DOMAIN = "https://animevietsub.meme";
    return ACTIVE_DOMAIN;
  }
}

// HTTP client for making requests to the anime API
export const client = {
  async get(path) {
    // Lazily resolve the live domain before making the request
    const domain = path.startsWith("http") ? "" : await getLiveDomain();
    const url = path.startsWith("http") ? path : domain + path;

    return request(url);
  },

  async post(path, body, opts = {}) {
    // Lazily resolve the live domain before making the request
    const domain = path.startsWith("http") ? "" : await getLiveDomain();
    const url = path.startsWith("http") ? path : domain + path;

    return request(url, {
      method: "POST",
      headers: { ...HEADERS, ...(opts.headers ?? {}) },
      body,
    });
  },
};
