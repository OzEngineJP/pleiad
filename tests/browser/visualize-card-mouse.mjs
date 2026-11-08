// 会話内の可視化カードの操作列を、実マウスで確かめる（指摘 4・P2）。
//   - カードの iframe は隔離の origin（cross-origin）: その上では親の :hover が付かないので、
//     枠の中の橋が送る「触れている」（ply-preview-point → .point）で操作列を出す
//   - 実座標のクリックで「広げる」（その場で広げる）と「ページで開く」（右の欄へ）を別々に確かめる
//   - キーボード（フォーカス + Enter）も変わらず動く
// 実行: node tests/browser/visualize-card-mouse.mjs
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createIsolatedRoutes } from '../../core/isolated-routes.mjs';
import { startIsolatedServer } from '../../core/isolated-server.mjs';
import { createHtmlKeys } from '../../core/html-keys.mjs';
import { collectBundle } from '../../core/viz-bundle.mjs';

const require = createRequire(import.meta.url);
const playwrightCandidates = [process.env.PW_CORE,
  path.join(path.dirname(process.execPath), 'node_modules/@playwright/cli/node_modules/playwright-core'),
  process.env.APPDATA && path.join(process.env.APPDATA, 'npm/node_modules/@playwright/cli/node_modules/playwright-core'),
  'playwright-core'].filter(Boolean);
let playwrightCore;
for (const candidate of playwrightCandidates) {
  try { playwrightCore = candidate === 'playwright-core' ? require.resolve(candidate) : require.resolve(candidate); break; } catch {}
}
if (!playwrightCore) throw new Error('playwright-core is unavailable; set PW_CORE to its installed package path');
const { chromium } = require(playwrightCore);

async function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), process.platform === 'win32' ? 'AppData/Local/ms-playwright' : '.cache/ms-playwright');
  const dirs = (await fs.readdir(base)).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

let failures = 0;
const ok = (name, cond, extra = '') => { console.log(`  ${cond ? 'OK' : 'NG'}  ${name}${cond ? '' : `  — ${extra}`}`); if (!cond) failures++; };

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-viz-mouse-'));
const dataDir = path.join(scratch, 'data');
const work = path.join(scratch, 'work');
await fs.mkdir(work, { recursive: true });
await fs.mkdir(dataDir);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let main, isolated, browser;
try {
  const entryHtml = `<!doctype html><html><body style="margin:0"><h1 id="title">chart</h1><a href="#part">Part</a><div id="part" style="height:300px;background:#3c4a9e"></div></body></html>`;
  const entry = path.join(work, 'chart.html');
  await fs.writeFile(entry, entryHtml);
  const bundle = await collectBundle(entry, { dataDir }, { dataDir, entryBody: entryHtml });
  const routes = createIsolatedRoutes({
    dataDir, store: { getPrefs: async () => ({}) }, htmlKeys: createHtmlKeys(), fileAccessFor: () => ({ dataDir }), sweepDelayMs: null,
  });
  isolated = await startIsolatedServer({ routes });

  // 会話の列に見立てた親のページ（127.0.0.1）。実物の renderPresent・style.css・橋を使う
  const fixture = `<!doctype html><html lang="ja"><meta charset="utf-8">
<script type="importmap">{"imports":{"i18next":"/node_modules/i18next.js"}}</script>
<link rel="stylesheet" href="/web/tokens.css"><link rel="stylesheet" href="/web/style.css">
<style>body{margin:0;background:var(--surface-paper)}main{margin:0}#thread{--col:760px;--gut:72px;width:760px;margin:0 auto}#thread .mw .mw-body{position:relative;padding:0 40px 80px}</style>
<main><div id="thread"><div class="mw"><div class="mw-gutter"></div><div class="mw-body" id="body"></div></div></div></main>
<script type="module">
import { renderPresent } from '/web/render.mjs';
import { configureIsolatedOrigin, configureVisualizationTabs } from '/web/visualize-frame.mjs';
window.opened = [];
configureIsolatedOrigin({ port: ${isolated.port} });
configureVisualizationTabs({ sessionId: () => 'one', connected: () => true, openTab: args => window.opened.push(args) });
window.locationReports = [];
addEventListener('message', event => { if (event.data?.type === 'ply-preview-location') window.locationReports.push(event.data); });
const card = renderPresent({ kind:'visualization', caption:'chart', content:'<p>chart</p>', bundle:${JSON.stringify({ hash: bundle.hash, entry: 'chart.html' })}, path:${JSON.stringify(entry)} });
document.querySelector('#body').append(card);
window.card = card;
window.ready = true;
</script>`;
  main = http.createServer(async (req, res) => {
    try {
      const p = new URL(req.url, 'http://x').pathname;
      if (p === '/fixture') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(fixture); }
      const file = p === '/node_modules/i18next.js' ? path.join(repo, 'node_modules/i18next/dist/esm/i18next.js')
        : path.join(repo, decodeURIComponent(p));
      if (!file.startsWith(repo + path.sep)) { res.writeHead(404); return res.end(); }
      res.setHeader('content-type', p.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
      res.end(await fs.readFile(file));
    } catch (e) { res.writeHead(500); res.end(e.message); }
  });
  await new Promise(resolve => main.listen(0, '127.0.0.1', resolve));
  const mainPort = main.address().port;

  browser = await chromium.launch({ executablePath: await chromiumPath() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${mainPort}/fixture`);
  await page.waitForFunction(() => window.ready, null, { timeout: 15000 });
  const frame = page.locator('.visualize-seamless iframe.visualize-frame');
  await frame.waitFor();
  ok('カードの iframe は隔離の origin（cross-origin）', (await frame.getAttribute('src')).includes(`:${isolated.port}/viz/${bundle.hash}/`));
  await page.frameLocator('.visualize-seamless iframe.visualize-frame').locator('h1').waitFor();
  await page.waitForTimeout(200);
  let reportCount = await page.evaluate(() => window.locationReports.length);
  ok('初回読み込みは場所を 1 度だけ報告する', reportCount === 1, String(reportCount));
  await page.frameLocator('.visualize-seamless iframe.visualize-frame').locator('a[href="#part"]').click();
  await page.waitForFunction(() => window.locationReports.length >= 2);
  const fragmentReport = await page.evaluate(() => window.locationReports.at(-1));
  ok('ページ内 # リンクは戻る対象として報告する', fragmentReport.replace === false && fragmentReport.href.endsWith('#part'), JSON.stringify(fragmentReport));
  await page.frameLocator('.visualize-seamless iframe.visualize-frame').locator('body').evaluate(() => history.replaceState({}, '', '#replaced'));
  await page.waitForFunction(() => window.locationReports.length >= 3);
  const replaceReport = await page.evaluate(() => window.locationReports.at(-1));
  ok('replaceState だけは現在の場所を置き換える', replaceReport.replace === true && replaceReport.href.endsWith('#replaced'), JSON.stringify(replaceReport));

  const geo = () => page.evaluate(() => {
    const card = document.querySelector('.visualize-seamless');
    const tools = card.querySelector('.present-tools');
    const btn = card.querySelector('.visualize-widen');
    const box = btn.getBoundingClientRect();
    return { point: card.classList.contains('point'), opacity: getComputedStyle(tools).opacity,
      pe: getComputedStyle(tools).pointerEvents, x: box.x + box.width / 2, y: box.y + box.height / 2,
      widened: card.classList.contains('visualize-widened'), width: card.getBoundingClientRect().width };
  });

  // マウスを枠の上へ（実座標）→ 橋の報告で .point が付き、操作列が出る
  const box = await frame.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => document.querySelector('.visualize-seamless')?.classList.contains('point'), null, { timeout: 5000 });
  await page.waitForTimeout(400); // 不透明度の動き（--dur-fast）
  let g = await geo();
  ok('枠の上の実マウスで .point が付き、操作列が出る（opacity 1・pointer-events auto）', g.point && g.opacity === '1' && g.pe === 'auto', JSON.stringify(g));

  const cardBox = await page.locator('.visualize-seamless').boundingBox();
  const toolbarBox = await page.locator('.visualize-open').boundingBox();
  await page.mouse.move(toolbarBox.x + toolbarBox.width / 2, toolbarBox.y + toolbarBox.height / 2);
  await page.waitForTimeout(120); // Let the iframe's pointer-out debounce finish while the toolbar remains hovered.
  await page.mouse.move(cardBox.x + cardBox.width + 24, toolbarBox.y + toolbarBox.height / 2);
  await page.waitForFunction(() => !document.querySelector('.visualize-seamless')?.classList.contains('point'), null, { timeout: 5000 });
  await page.waitForTimeout(300);
  g = await geo();
  ok('操作列から 1 歩でカードの外へ出ると .point が外れ、操作列が隠れる', !g.point && g.opacity === '0', JSON.stringify(g));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => document.querySelector('.visualize-seamless')?.classList.contains('point'), null, { timeout: 5000 });
  await page.waitForTimeout(400);
  g = await geo();

  // 「広げる」を実クリック（当たり先は iframe でなくボタン）
  const narrow = g.width;
  await page.mouse.click(g.x, g.y);
  await page.waitForFunction(() => document.querySelector('.visualize-seamless')?.classList.contains('visualize-widened'), null, { timeout: 5000 });
  await page.waitForTimeout(400); // margin の動き
  g = await geo();
  ok('実クリックで「広げる」が効く（その場で広がる）', g.widened && g.width > narrow, JSON.stringify(g));
  await page.mouse.click(g.x, g.y);
  await page.waitForFunction(() => !document.querySelector('.visualize-seamless')?.classList.contains('visualize-widened'), null, { timeout: 5000 });
  ok('もう一度押すと元の幅に戻る', !(await geo()).widened);

  // 「ページで開く」を実クリック → 右の欄へ（openTab が呼ばれる）
  const openBtn = await page.locator('.visualize-open').boundingBox();
  await page.mouse.click(openBtn.x + openBtn.width / 2, openBtn.y + openBtn.height / 2);
  await page.waitForFunction(() => window.opened.length === 1, null, { timeout: 5000 });
  const opened = await page.evaluate(() => window.opened[0]);
  ok('「ページで開く」は右の欄へ（kind:viz・束・入口・元パスを渡す）',
    opened.kind === 'viz' && opened.vizHash === bundle.hash && opened.entry === 'chart.html' && opened.path === entry, JSON.stringify(opened));

  // キーボード: フォーカス + Enter でも広げる（変わらない）
  await page.locator('.visualize-widen').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.visualize-seamless')?.classList.contains('visualize-widened'), null, { timeout: 5000 });
  ok('キーボード（フォーカス + Enter）でも広げられる', (await geo()).widened);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.visualize-seamless')?.classList.contains('visualize-widened'), null, { timeout: 5000 });

  // マウスをカードの外へ → .point が外れ、操作列が引っ込む
  await page.evaluate(() => document.querySelector('.visualize-widen').blur());
  await page.mouse.move(40, 40);
  await page.waitForFunction(() => !document.querySelector('.visualize-seamless')?.classList.contains('point'), null, { timeout: 5000 });
  await page.waitForTimeout(300);
  g = await geo();
  ok('カードの外へ出ると .point が外れ、操作列が引っ込む', !g.point && g.opacity === '0', JSON.stringify(g));
  ok('枠の中でスクリプトのエラーが出ない', errors.length === 0, errors.join(' / '));
} catch (error) {
  failures++;
  console.error(error);
} finally {
  await browser?.close();
  await isolated?.close?.();
  if (main?.listening) await new Promise(resolve => main.close(resolve));
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}
console.log(failures ? `NG ${failures}` : 'OK');
process.exit(failures ? 1 : 0);
