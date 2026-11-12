// 実行: node tests/browser/page-scroll-chase-input.mjs（PW_CORE・PW_CHROMIUM でブラウザーを指定できる）。
// 隔離ページの橋（web/visualize-document.mjs の LINK_BRIDGE）が、読み直しの後に位置を追っている間（高さが遅れて届くページ）、
// 利用者が本物の入力で動かしたら追うのをやめることを、実ブラウザーで確かめる（ADR 0320）。
//   触れない → 高さが届いたあと目的地に追いつく（対照）・ホイールで動かす → 引き戻さない・スクロールバーのつまみをドラッグ → 引き戻さない。
// スクロールバーのつまみは、playwright 既定の --hide-scrollbars では描かれず触れないので、その旗を外して起動する。
// ローカルのポート 1 つだけを使い、実データには触れない。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { LINK_BRIDGE } from '../../web/visualize-document.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const newest = (prefix) => fs.readdirSync(base).filter((n) => n.startsWith(prefix)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
const executablePath = process.env.PW_CHROMIUM || path.join(base, newest('chromium-'), 'chrome-win64/chrome.exe');

const GOAL = 4000;
const child = `<!doctype html><meta charset="utf-8"><title>p</title>${LINK_BRIDGE}<h1>x</h1><div id="s" style="height:2000px;width:100px">long</div>`
  + `<script>setTimeout(function(){document.getElementById('s').style.height='6000px'},1500)</script>`;
const outer = '<!doctype html><body style="margin:0"><iframe id="f" src="/child" style="width:600px;height:500px;border:0"></iframe>';
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(req.url.startsWith('/child') ? child : outer); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const results = [];
const check = (ok, label, detail = '') => { if (!ok) throw new Error(`${label} ${JSON.stringify(detail)}`); results.push(label); };
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const run = async (mode) => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForTimeout(500);
    const frame = page.frames().find((f) => /\/child/.test(f.url()));
    const geo = await frame.evaluate(() => ({ bar: innerWidth - document.documentElement.clientWidth, h: document.documentElement.scrollHeight, vh: innerHeight }));
    await page.evaluate((y) => document.getElementById('f').contentWindow.postMessage({ type: 'pleiad:page-command', command: { type: 'scroll-restore', x: 0, y } }, '*'), GOAL);
    await page.waitForTimeout(400);   // 高さが届くまでは目的地に届かず、追い続けている
    const before = await frame.evaluate(() => Math.round(scrollY));
    const box = await (await frame.frameElement()).boundingBox();
    if (mode === 'wheel') { await page.mouse.move(box.x + 200, box.y + 200); await page.mouse.wheel(0, -300); }
    if (mode === 'drag') {
      check(geo.bar > 0, '前提: スクロールバーが描かれている（つまみに触れる）', geo);
      const track = box.height - 34, thumb = Math.max(20, track * geo.vh / geo.h);
      const thumbY = box.y + 17 + (track - thumb) * (before / Math.max(1, geo.h - geo.vh)) + thumb / 2;
      const barX = box.x + box.width - geo.bar / 2;
      await page.mouse.move(barX, thumbY); await page.mouse.down();
      await page.mouse.move(barX, thumbY - 80, { steps: 6 }); await page.mouse.up();
    }
    const moved = await frame.evaluate(() => Math.round(scrollY));
    await page.waitForTimeout(2600);   // 高さが届いた（1.5 秒）あと、追う処理が生きていれば 4000 へ引き戻す
    const end = await frame.evaluate(() => ({ y: Math.round(scrollY), h: document.documentElement.scrollHeight }));
    await page.close();
    return { before, moved, end };
  };
  const none = await run('none');
  check(none.end.h > 5000 && none.end.y === GOAL, `対照: 触れなければ、高さが届いたあと目的地（${GOAL}）に追いつく`, none);
  const wheel = await run('wheel');
  check(wheel.end.y < 3500, `追っている間にホイールで動かしたら、追うのをやめる（${wheel.before} → ${wheel.end.y}。引き戻さない）`, wheel);
  const drag = await run('drag');
  check(drag.moved < drag.before - 50, `前提: つまみのドラッグでページが動いた（${drag.before} → ${drag.moved}）`, drag);
  check(drag.end.y < 3500, `追っている間にスクロールバーのつまみをドラッグしたら、追うのをやめる（引き戻さない: ${drag.end.y}）`, drag);
  console.log(`${results.length} checks passed\n${results.join('\n')}`);
} finally {
  await browser?.close().catch(() => {});
  server.close();
}
