import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const browserPath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
  (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath());

test('real browser waits for body and recovers when navigation interrupts stream API',
  { skip: !existsSync(browserPath) }, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'stream-navigation-'));
    let posts = 0;
    const server = createServer(async (req, res) => {
      if (req.url === '/ajax/player') {
        let body = '';
        for await (const chunk of req) body += chunk;
        posts++;
        if (posts === 1) {
          // The page polls this counter and navigates while fetch is pending.
          const timer = setTimeout(() => res.end('{}'), 1000);
          res.on('close', () => clearTimeout(timer));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body.includes('backup=1') ? {
          success: true, html: '<button class="btn3dsv" data-href="x" data-play="y" data-id="z">HDX</button>',
        } : { link: 'https://abyssplayer.com/next' }));
      } else if (req.url === '/status') {
        res.end(String(posts));
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<html><body>Episode<script>
          ${req.url === '/ready' ? '' : `setInterval(async()=>{if(Number(await (await fetch('/status')).text())>0) location.href='/ready';},20);`}
        </script></body></html>`);
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(home, { recursive: true, force: true }); });
    await mkdir(path.join(home, '.cache/anime-tui'), { recursive: true });
    await writeFile(path.join(home, '.cache/anime-tui/live-domain.json'), JSON.stringify({
      origin: `http://127.0.0.1:${server.address().port}`, updated: Date.now(),
    }));
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { chromium } from 'playwright';
      const launch = chromium.launch.bind(chromium);
      chromium.launch = async options => {
        const browser = await launch(options), newPage = browser.newPage.bind(browser);
        browser.newPage = async () => {
          const page = await newPage(), goto = page.goto.bind(page);
          page.goto = async (...args) => {
            const result = await goto(...args);
            await page.evaluate(() => {
              const body = document.body; body.remove();
              setTimeout(() => document.documentElement.append(body), 250);
            });
            return result;
          };
          return page;
        };
        return browser;
      };
      const { streams } = await import('./lib/streams.js');
      console.log(await streams('/tap-06-124.html'));
    `], { env: { ...process.env, HOME: home, PLAYWRIGHT_EXECUTABLE_PATH: browserPath }, timeout: 20000 });
    assert.equal(stdout.trim(), 'https://abyssplayer.com/next');
    assert.equal(posts, 3, 'interrupted backup request must restart before resolving the link');
  });
