const BASE_URL = "https://animevietsub.info";
const HEADERS = { "User-Agent": "Mozilla/5.0" };

export const client = {
  async get(path) {
    const url = path.startsWith("http") ? path : BASE_URL + path;
    const res = await fetch(url, { headers: HEADERS });
    return { data: await res.text() };
  },

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
