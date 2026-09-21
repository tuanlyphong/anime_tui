import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

// Each subprocess gets a real, isolated disk cache and fresh module state.
async function isolated(t, code, env = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "anime-discovery-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await exec(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    ${code}
  `], { env: { ...process.env, HOME: home, ...env }, timeout: 10000 });
}

test("disk cache expires and rejects legacy entries without timestamps", async (t) => {
  await isolated(t, `
    import * as cache from "./lib/cache.js";
    import fs from "node:fs/promises";
    import crypto from "node:crypto";
    let now = Date.now();
    Date.now = () => now;
    await cache.put("fresh", ["value"]);
    assert.deepEqual(await cache.get("fresh", 1000), ["value"]);
    now += 1001;
    assert.equal(await cache.get("fresh", 1000), null);
    const key = crypto.createHash("sha1").update("legacy").digest("hex");
    await fs.writeFile(process.env.HOME + "/.cache/anime-tui/json/" + key, "[]");
    assert.equal(await cache.get("legacy"), null);
  `);
});

test("search rejects challenge responses without poisoning later results", async (t) => {
  await isolated(t, `
    import { client } from "./lib/http.js";
    import { search } from "./lib/search.js";
    client.post = async () => ({data: "<html><title>Just a moment...</title></html>"});
    await assert.rejects(search("kimi"), /search.*response|challenge/i);
    client.post = async () => ({data: '<li><a class="ss-title" href="/anime">Kimi</a></li>'});
    assert.deepEqual(await search("kimi"), [{title:"Kimi", url:"/anime", poster:""}]);
    client.post = async () => { throw new Error("offline"); };
    assert.equal((await search(" KIMI "))[0].title, "Kimi");
  `);
});

test("search and episode cache keys cannot collide", async (t) => {
  await isolated(t, `
    import * as cache from "./lib/cache.js";
    import { client } from "./lib/http.js";
    import { search } from "./lib/search.js";
    await cache.put("episodes:/phim/kimi", [{title:"05", url:"/episode"}]);
    client.post = async () => ({data:'<li class="ss-bottom"><a id="suggest-all">Search</a></li>'});
    assert.deepEqual(await search("episodes:/phim/kimi"), []);
  `);
});

test("valid empty searches remain empty instead of reporting a challenge", async (t) => {
  await isolated(t, `
    import { client } from "./lib/http.js";
    import { search } from "./lib/search.js";
    client.post = async () => ({data:'<li class="ss-bottom"><a id="suggest-all">Search</a></li>'});
    assert.deepEqual(await search("missing"), []);
  `);
});

test("an unwritable cache does not prevent a successful search", async (t) => {
  await isolated(t, `
    import fs from "node:fs/promises";
    await fs.writeFile(process.env.HOME + "/.cache", "not a directory");
    const { client } = await import("./lib/http.js");
    const { search } = await import("./lib/search.js");
    client.post = async () => ({data: '<li><a class="ss-title" href="/anime">Kimi</a></li>'});
    assert.equal((await search("kimi"))[0].title, "Kimi");
  `);
});

test("HTTP errors include status instead of becoming successful search bodies", async (t) => {
  await isolated(t, `
    import { createServer } from "node:http";
    import { client } from "./lib/http.js";
    const server = createServer((req,res) => { res.writeHead(403); res.end("blocked"); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = "http://127.0.0.1:" + server.address().port;
    try {
      await assert.rejects(client.post(url, new URLSearchParams()), /HTTP 403/);
      await assert.rejects(client.get(url), /HTTP 403/);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  `);
});

test("HTTP timeout covers a stalled response body", async (t) => {
  await isolated(t, `
    import { createServer } from "node:http";
    import { client } from "./lib/http.js";
    const server = createServer((req,res) => {
      res.writeHead(200); res.write("partial");
      setTimeout(() => res.end("late"), 300).unref();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      await assert.rejects(client.get("http://127.0.0.1:" + server.address().port), /timed out/i);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  `, { ANIME_TUI_REQUEST_TIMEOUT_MS: "50" });
});

test("domain discovery accepts a completed redirect even if its landing page is protected", async (t) => {
  await isolated(t, `
    const response = new Response(null, {status:403});
    Object.defineProperties(response, {
      url:{value:"https://live.example/"}, redirected:{value:true},
    });
    globalThis.fetch = async () => response;
    const { getLiveDomain } = await import("./lib/http.js");
    assert.equal(await getLiveDomain(), "https://live.example");
    globalThis.fetch = async () => {throw new Error("offline");};
    const reloaded = await import("./lib/http.js?reload");
    assert.equal(await reloaded.getLiveDomain(), "https://live.example");
  `);
});

test("episode cache survives module reloads, ignores old domains, and expires", async (t) => {
  await isolated(t, `
    import { chromium } from "playwright";
    let now = Date.now();
    Date.now = () => now;
    const row = {title:"05", name:"Tập 05", url:"https://live.example/tap-05-123.html", id:"123"};
    chromium.launch = async () => ({
      newPage: async () => ({route: async () => {}, goto: async () => ({ok:()=>true, status:()=>200}),
        waitForSelector: async () => {}, evaluate: async () => [row]}),
      close: async () => {},
    });
    const { episodes } = await import("./lib/episodes.js");
    assert.deepEqual(await episodes("https://old.example/phim/kimi/"), [row]);
    chromium.launch = async () => { throw new Error("browser offline"); };
    const reloaded = await import("./lib/episodes.js?reload");
    assert.deepEqual(await reloaded.episodes("https://new.example/phim/kimi/"), [row]);
    now += 6 * 60 * 1000;
    await assert.rejects(reloaded.episodes("/phim/kimi/"), /browser offline/);
  `);
});

test("failed episode navigation reports HTTP status and closes the browser", async (t) => {
  await isolated(t, `
    import { chromium } from "playwright";
    let closed = false;
    chromium.launch = async () => ({
      newPage: async () => ({route: async () => {},
        goto: async () => ({ok:()=>false, status:()=>403}),
        waitForSelector: async () => { throw new Error("selector timeout"); }}),
      close: async () => { closed = true; },
    });
    const { episodes } = await import("./lib/episodes.js");
    await assert.rejects(episodes("/phim/blocked/"), /HTTP 403/);
    assert.equal(closed, true);
  `);
});

test("episode discovery lets a browser challenge finish after an initial 403", async (t) => {
  await isolated(t, `
    import { chromium } from "playwright";
    const row = {title:"05", name:"Tập 05", url:"https://live.example/tap-05-123.html"};
    chromium.launch = async () => ({
      newPage: async () => ({route:async()=>{}, goto:async()=>({ok:()=>false,status:()=>403}),
        waitForSelector:async()=>{}, evaluate:async()=>[row]}),
      close:async()=>{},
    });
    const { episodes } = await import("./lib/episodes.js");
    assert.deepEqual(await episodes("/phim/kimi/"), [row]);
  `);
});

// Execute the real browser callback; replace only the external browser/network.
const streamBrowser = `
  import fs from "node:fs/promises";
  import { chromium } from "playwright";
  await fs.mkdir(process.env.HOME + "/.cache/anime-tui", {recursive:true});
  await fs.writeFile(process.env.HOME + "/.cache/anime-tui/live-domain.json",
    JSON.stringify({origin:"https://anime.example", updated:Date.now()}));
  globalThis.document = {querySelector:()=>null, body:{innerText:"Episode"}, title:"Episode"};
  let closed = false;
  chromium.launch = async () => ({
    newPage: async () => ({route:async()=>{}, goto:async()=>({ok:()=>true, status:()=>200}),
      evaluate:async(fn,arg)=>fn(arg)}),
    close:async()=>{closed=true;},
  });
  const { streams } = await import("./lib/streams.js");
`;

for (const stage of ['challenge', 'stream']) {
  test(`stream resolution recovers from navigation during ${stage} evaluation`, async t => {
    await isolated(t, `${streamBrowser}
      let interrupted = false, waits = 0;
      chromium.launch = async () => ({
        newPage: async () => ({route:async()=>{}, goto:async()=>{},
          waitForLoadState:async()=>{waits++;},
          evaluate:async(fn,arg)=>{
            if (!interrupted && ${JSON.stringify(stage)} === (arg ? 'stream' : 'challenge')) {
              interrupted=true;
              throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
            }
            return arg ? 'https://abyssplayer.com/resolved' : false;
          }}), close:async()=>{closed=true;}
      });
      assert.equal(await streams('/phim/kimi/tap-06-124.html'),'https://abyssplayer.com/resolved');
      assert.equal(waits,1);
      assert.equal(closed,true);
    `);
  });
}

test('persistent stream navigation fails after bounded attempts and closes browser', async t => {
  await isolated(t, `${streamBrowser}
    let calls=0;
    chromium.launch=async()=>({newPage:async()=>({route:async()=>{},goto:async()=>{},
      waitForLoadState:async()=>{}, evaluate:async()=>{calls++;throw new Error('Execution context was destroyed');}}),
      close:async()=>{closed=true;}});
    await assert.rejects(streams('/phim/kimi/tap-06-124.html'),/Execution context was destroyed/);
    assert.equal(calls,3);assert.equal(closed,true);
  `);
});

test("stream API rejects HTTP errors with actionable status", async (t) => {
  await isolated(t, `${streamBrowser}
    globalThis.fetch = async () => new Response("blocked", {status:403});
    await assert.rejects(streams("/phim/kimi/tap-05-123.html"), /HTTP 403/);
    assert.equal(closed, true);
  `);
});

test("stream API timeout cancels a stalled request and closes the browser", async (t) => {
  await isolated(t, `${streamBrowser}
    globalThis.fetch = async (url,options) => new Promise((resolve,reject) => {
      const timer = setTimeout(() => resolve(new Response('{}')), 300);
      options.signal?.addEventListener("abort", () => {clearTimeout(timer); reject(options.signal.reason);});
    });
    await assert.rejects(streams("/phim/kimi/tap-05-123.html"), /timed out/i);
    assert.equal(closed, true);
  `, { ANIME_TUI_REQUEST_TIMEOUT_MS: "50" });
});
