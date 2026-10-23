// スマホの幅の引き出し（脇。web/client.mjs の initSidebar・ADR 0251 の置き場所の木）は、脇の中で移動しない操作では閉じない（実ブラウザー）:
//   - 状態の「ほか N 件」・チャンネルの「ほか N 件」を押すと、脇は開いたままでその場で行が増える。もう一度押すと戻る
//   - 状態の見出し・チャンネルの開閉・行の「…」・フィルターを押しても閉じない
//   - 会話の行・チャンネルの名前・チャンネルの ＋・スレッドの行を押すと（移動する）閉じる。＋ は閉じた後に流れの入力欄へ居場所を置く
// 実行: node tests/browser/drawer-stays-open.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる）
// 本物のサーバー（fake のバックエンド・一時のデータ置き場・別ポート）だけと話す。会話 7 件（同じ状態）と返信のあるスレッド 5 件のチャンネルを WS で作る
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const results = [];
const check = (ok, label, detail) => { if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); results.push(label); };

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-drawer-open-'));
let server, browser, ws;
try {
  const work = path.join(scratch, 'work');
  fs.mkdirSync(work);
  server = await startServer({ dataDir: path.join(scratch, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  ws = await open({ port: server.port, token: server.token });
  const invoke = (op, args) => ws.cmd('invoke', { op, args });
  // 一時チャットの同じ状態（状態なし）に 7 件。5 件を超えた 2 件が「ほか 2 件」に畳まれる
  for (let i = 1; i <= 7; i++) await ws.runTurn({ backend: 'fake', cwd: work, prompt: `echo:会話 ${i}` });
  // スレッド 5 件のチャンネル。最近 3 件の先の 2 件が「ほか 2 件」に畳まれる
  const channel = await invoke('channels.create', { name: 'dev' });
  // 脇に出るスレッドは返信のある根（core/channels/service.mjs の threadIndex）
  for (let i = 1; i <= 5; i++) {
    const root = await invoke('channels.post', { channelId: channel.id, text: `スレッド ${i}`, new: true });
    await invoke('channels.post', { channelId: channel.id, threadId: root.id, text: `返信 ${i}` });
  }
  ws.close();

  browser = await chromium.launch({ executablePath: chromiumPath() });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, hasTouch: true, isMobile: true, locale: 'ja-JP' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
  await page.locator('#prompt').waitFor();
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());

  const isOpen = () => page.evaluate(() => document.documentElement.classList.contains('side-open'));
  // 脇を開く入口は見えている面で替わる（会話の頭 #openSidebar・チャンネルの流れ #chOpenSidebar・スレッド #chThreadOpenSidebar）。いま押せるものを押す
  // （閉じる動きの間は脇が入口に重なっているので、上に来るまで待つ）
  const opener = async () => (await page.waitForFunction(() => ['openSidebar', 'chOpenSidebar', 'chThreadOpenSidebar'].find((id) => {
    const b = document.getElementById(id);
    const r = b?.getBoundingClientRect();
    return r && r.width > 0 && b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  }), null, { timeout: 5000 })).jsonValue();
  const openDrawer = async () => {
    if (!await isOpen()) await page.locator(`#${await opener()}`).click();
    await page.waitForFunction(() => document.documentElement.classList.contains('side-open'));
    await page.waitForTimeout(400);   // 開く動き（--dur）が終わるまで
  };
  const home = '[data-side-key="chsec:home"]';
  const chan = `[data-side-key="chsec:${channel.id}"]`;
  const count = (sel) => page.locator(sel).count();
  // 押した後、脇がまだ開いているか（閉じる処理は同じタップの中で side-open を外す）
  const tapKeeps = async (locator, label) => {
    await openDrawer();
    await locator.click();
    await page.waitForTimeout(300);
    check(await isOpen(), `${label}: 脇は開いたまま`);
  };

  await openDrawer();
  await page.locator(`${home} .grp .row.more`).first().waitFor();

  // 状態の「ほか N 件」
  const sessionRows = `${home} .grp .row[data-session]:not([data-session=""])`;
  const before = await count(sessionRows);
  await tapKeeps(page.locator(`${home} .grp .row.more`).first(), '状態の「ほか N 件」');
  check(await count(sessionRows) > before, '状態の「ほか N 件」で会話の行が増える', { before, after: await count(sessionRows) });
  await tapKeeps(page.locator(`${home} .grp .row.more`).first(), '状態の「表示を減らす」');
  check(await count(sessionRows) === before, '状態の「表示を減らす」で 5 件に戻る');

  // チャンネルの「ほか N 件」
  const threadRows = `${chan} .row[data-thread]`;
  const threadsBefore = await count(threadRows);
  await tapKeeps(page.locator(`${chan} .row.more`), 'チャンネルの「ほか N 件」');
  check(threadsBefore === 3 && await count(threadRows) === 5, 'チャンネルの「ほか N 件」でスレッドの行が増える', { threadsBefore, after: await count(threadRows) });
  await tapKeeps(page.locator(`${chan} .row.more`), 'チャンネルの「表示を減らす」');

  // ほかの、脇の中で移動しない操作
  await tapKeeps(page.locator(`${home} .grp > .grp-head .grp-name`).first(), '状態の見出し（畳む）');
  check(await count(`${home} .grp.collapsed`) === 1, '状態の見出しで畳まれる');
  await tapKeeps(page.locator(`${home} .grp > .grp-head .grp-name`).first(), '状態の見出し（開く）');
  await tapKeeps(page.locator(`${chan} > .grp-head .chsec-chev`), 'チャンネルの開閉');
  await tapKeeps(page.locator(`${chan} > .grp-head .chsec-chev`), 'チャンネルの開閉（戻す）');
  await tapKeeps(page.locator('#filterBtn'), 'フィルター');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.body.click());
  await tapKeeps(page.locator(`${sessionRows} .row-more`).first(), '会話の行の「…」');
  check(await page.locator('.pop.menu, .pop:not([hidden])').count() > 0, '会話の行の「…」でメニューが開く');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 移動する操作は閉じる
  await openDrawer();
  const target = await page.locator(sessionRows).nth(1).getAttribute('data-session');
  await page.locator(`${sessionRows}[data-session="${target}"]`).click();
  await page.waitForFunction(() => !document.documentElement.classList.contains('side-open'));
  check(true, '会話の行を押すと閉じる');
  // チャンネルの名前・＋ は channels:show で閉じる（行ではないので、押した場所では決まらない）
  await openDrawer();
  await page.locator(`${chan} > .grp-head .chsec-name`).click();
  await page.waitForFunction(() => !document.documentElement.classList.contains('side-open'));
  check(true, 'チャンネルの名前を押すと閉じる');
  await openDrawer();
  await page.locator(`${chan} > .grp-head .grp-add`).click();
  await page.waitForFunction(() => !document.documentElement.classList.contains('side-open'));
  await page.waitForTimeout(500);
  check(await page.evaluate(() => Boolean(document.activeElement?.closest('#chFeed .ch-input'))), 'チャンネルの ＋ を押すと閉じ、流れの入力欄に居場所が置かれる',
    await page.evaluate(() => document.activeElement?.id || document.activeElement?.className));
  await openDrawer();
  await page.locator(threadRows).first().click();
  await page.waitForFunction(() => !document.documentElement.classList.contains('side-open'));
  check(true, 'スレッドの行を押すと閉じる');

  check(errors.length === 0, '画面の例外なし', errors);
  await ctx.close();
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`drawer-stays-open: ${results.length} 件 通過`);
} catch (e) {
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.error(`NG  ${e.message}`);
  if (server) console.error(server.tail(20));
  process.exitCode = 1;
} finally {
  ws?.close();
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
