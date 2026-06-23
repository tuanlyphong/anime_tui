// Base URL for the anime API
const BASE_URL = "https://animevietsub.info";
// Default headers to mimic a browser request
const HEADERS = { "User-Agent": "Mozilla/5.0" };

// HTTP client for making requests to the anime API
export const client = {
  // Sends a GET request. Path can be relative (appended to BASE_URL) or absolute
  async get(path) {
    const url = path.startsWith("http") ? path : BASE_URL + path;
    const res = await fetch(url, { headers: HEADERS });
    return { data: await res.text() };
  },

  // Sends a POST request with optional custom headers merged with default headers
  async post(path, body, opts = {}) {
    const url = path.startsWith("http") ? path : BASE_URL + path;
    const res = await fetch(url, {
      method: "POST",
      headers: { ...HEADERS, ...(opts.headers ?? {}) },
      body,
    });
    return { data: await res.text() };
  },
};
