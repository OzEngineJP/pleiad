// 隔離の origin の可視化（ADR 0292 の 3。core/isolated-routes.mjs）を実ブラウザーで見る。
//   - 本体に見立てた 127.0.0.1 のページが、sandbox の iframe で /viz/<束>/<入口>?embed=conversation を開く
//   - 束の中の相対パスの画像・fetch が読め、localStorage は落ちずに使え（枠の中だけの置き場）、高さが親へ届く
//   - 束の外（本体の port）・確認の要る外のサイトは CSP で止まり、止まった外のサイトは親へ知らせる
// 実行: node tests/browser/visualize-isolated.mjs
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createIsolatedRoutes } from '../../core/isolated-routes.mjs';
import { startIsolatedServer } from '../../core/isolated-server.mjs';
import { createHtmlKeys } from '../../core/html-keys.mjs';
import { collectBundle } from '../../core/viz-bundle.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');

async function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = (await fs.readdir(base)).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

let failures = 0;
const ok = (name, cond, extra = '') => { console.log(`  ${cond ? 'OK' : 'NG'}  ${name}${cond ? '' : `  — ${extra}`}`); if (!cond) failures++; };

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-viz-isolated-'));
const dataDir = path.join(scratch, 'data');
const work = path.join(scratch, 'work');
await fs.mkdir(path.join(work, 'assets'), { recursive: true });
await fs.mkdir(dataDir);
// 1x1 の PNG
await fs.writeFile(path.join(work, 'assets', 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
await fs.writeFile(path.join(work, 'assets', 'data.json'), '{"value":42}');

let main, isolated, browser;
try {
  // 本体に見立てた口（127.0.0.1）。枠を開く親のページと、束の外から読もうとする先
  main = http.createServer((req, res) => {
    if (req.url.startsWith('/parent')) {
      const src = new URL(req.url, 'http://x').searchParams.get('src');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><script>window.messages=[];addEventListener('message',e=>window.messages.push(e.data))</script><iframe sandbox="allow-scripts allow-downloads allow-forms" src="${src}"></iframe>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end('{"main":true}');
  });
  await new Promise(resolve => main.listen(0, '127.0.0.1', resolve));
  const mainPort = main.address().port;

  const html = `<!doctype html><html><head><title>viz</title></head><body><div style="height:333px">chart</div>
<img id="dot" src="assets/dot.png">
<script>(async()=>{const r={};
try{localStorage.setItem('k','v');r.storage=localStorage.getItem('k')}catch(e){r.storage='throw:'+e.name}
try{r.fetch=(await (await fetch('assets/data.json')).json()).value}catch(e){r.fetch='throw:'+e.name}
try{await fetch('http://127.0.0.1:${mainPort}/api');r.main='loaded'}catch(e){r.main='blocked'}
await new Promise(done=>{const img=document.getElementById('dot');if(img.complete)done();else{img.onload=done;img.onerror=done}});
r.img=document.getElementById('dot').naturalWidth;
const ext=new Image();ext.src='https://blocked.example/x.png';
await new Promise(done=>setTimeout(done,300));
parent.postMessage({type:'result',...r},'*')})()</script></body></html>`;
  const entry = path.join(work, 'chart.html');
  await fs.writeFile(entry, html);
  const bundle = await collectBundle(entry, { dataDir }, { dataDir, entryBody: html });
  const routes = createIsolatedRoutes({
    dataDir, store: { getPrefs: async () => ({ confirmExternalLoads: true }) }, htmlKeys: createHtmlKeys(), fileAccessFor: () => ({ dataDir }), sweepDelayMs: null,
  });
  isolated = await startIsolatedServer({ routes });
  const src = `http://localhost:${isolated.port}/viz/${bundle.hash}/chart.html?embed=conversation&theme=light`;

  browser = await chromium.launch({ executablePath: await chromiumPath() });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${mainPort}/parent?src=${encodeURIComponent(src)}`);
  await page.waitForFunction(() => window.messages.some(m => m?.type === 'result'), null, { timeout: 15000 });
  const messages = await page.evaluate(() => window.messages);
  const result = messages.find(m => m?.type === 'result');
  ok('束の中の相対パスの画像が読める', result.img === 1, JSON.stringify(result));
  ok('束の中の相対パスの fetch が読める（不透明な origin からでも）', result.fetch === 42, JSON.stringify(result));
  ok('localStorage は落ちずに使える（枠の中だけの置き場）', result.storage === 'v', JSON.stringify(result));
  ok('本体の port へは読みに行けない（CSP）', result.main === 'blocked', JSON.stringify(result));
  const heights = messages.filter(m => m?.type === 'ply-visualize-height').map(m => m.height);
  ok('高さが親へ届く', heights.some(h => h >= 333), JSON.stringify(heights));
  ok('止まった外のサイトを親へ知らせる', messages.some(m => m?.type === 'ply-preview-blocked' && m.url.startsWith('https://blocked.example/')), JSON.stringify(messages));
  ok('枠の中でスクリプトのエラーが出ない', errors.length === 0, errors.join(' / '));
  const frame = page.frames().find(f => f.url().startsWith(`http://localhost:${isolated.port}/`));
  ok('枠の origin は不透明（allow-same-origin なし）', await frame.evaluate(() => self.origin) === 'null');
} catch (error) {
  failures++;
  console.error(error);
} finally {
  await browser?.close();
  await isolated?.close?.();
  main?.close();
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}
console.log(failures ? `NG ${failures}` : 'OK');
process.exit(failures ? 1 : 0);
