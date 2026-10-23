// スマホの幅の引き出し（脇。web/client.mjs の initSidebar・ADR 0251 の置き場所の木）の実ブラウザーの確かめ:
//   - どの区画も件数で絞らずに全部を出す（ADR 0260）。同じ状態の会話 12 件・スレッド 9 件のチャンネルがすべて並び、「ほか N 件」「表示を減らす」は無い
//   - 前の版が保存した好み（chMore・statusMore）が残っていても崩れず、次の保存で消える
//   - 状態の見出し・チャンネルの開閉・行の「…」・フィルターを押しても閉じない
//   - 会話の行・チャンネルの名前・チャンネルの ＋・スレッドの行を押すと（移動する）閉じる。＋ は閉じた後に流れの入力欄へ居場所を置く
// 実行: node tests/browser/drawer-stays-open.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる）
// 本物のサーバー（fake のバックエンド・一時のデータ置き場・別ポート）だけと話す。会話 12 件（同じ状態）と返信のあるスレッド 9 件のチャンネルを WS で作る
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

const CHATS = 12;     // 前の版の 5 件の上限を大きく超える
const THREADS = 9;    // 前の版の最近 3 件の上限を大きく超える
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-drawer-open-'));
let server, browser, ws;
try {
  const work = path.join(scratch, 'work');
  fs.mkdirSync(work);
  server = await startServer({ dataDir: path.join(scratch, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  ws = await open({ port: server.port, token: server.token });
  const invoke = (op, args) => ws.cmd('invoke', { op, args });
  // 一時チャットの同じ状態（状態なし）に 12 件
  for (let i = 1; i <= CHATS; i++) await ws.runTurn({ backend: 'fake', cwd: work, prompt: `echo:会話 ${i}` });
  const channel = await invoke('channels.create', { name: 'dev' });
  // 脇に出るスレッドは返信のある根（core/channels/service.mjs の threadIndex）
  for (let i = 1; i <= THREADS; i++) {
    const root = await invoke('channels.post', { channelId: channel.id, text: `スレッド ${i}`, new: true });
    await invoke('channels.post', { channelId: channel.id, threadId: root.id, text: `返信 ${i}` });
  }
  ws.close();

  browser = await chromium.launch({ executablePath: chromiumPath() });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, hasTouch: true, isMobile: true, locale: 'ja-JP' });
  // 前の版の好み: 「ほか n 件」を開いた区画を覚えていた（読まずに無視する）
  await ctx.addInitScript(([channelId]) => {
    if (sessionStorage.getItem('oldPrefsSeeded')) return;
    sessionStorage.setItem('oldPrefsSeeded', '1');
    localStorage.setItem('agent-host-side', JSON.stringify({ chMore: [channelId], statusMore: ['group:'] }));
  }, [channel.id]);
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
  const sessionRows = `${home} .grp .row[data-session]:not([data-session=""])`;
  const threadRows = `${chan} .row[data-thread]`;
  const madeRows = `${home} .grp .row[data-session^="fake-"]`;   // 作った 12 件（未送信の下書きの行は数えない）
  await page.waitForFunction(([s, n]) => document.querySelectorAll(s).length >= n, [madeRows, CHATS], { timeout: 5000 }).catch(() => {});

  // 件数で絞らずに全部を出す
  check(await count(madeRows) === CHATS, `同じ状態の会話 ${CHATS} 件がすべて並ぶ`, await count(madeRows));
  check(await count(threadRows) === THREADS, `チャンネルのスレッド ${THREADS} 件がすべて並ぶ`, await count(threadRows));
  const leftovers = await page.evaluate(() => [...document.querySelectorAll('#groups .row.more, #groups .cs-more')].length
    + [...document.querySelectorAll('#groups .row-t, #groups button')].filter(n => /^ほか \d+ 件|表示を減らす|少なく表示/.test(n.textContent.trim())).length);
  check(leftovers === 0, '「ほか N 件」「表示を減らす」の行やボタンは無い', leftovers);

  // ほかの、脇の中で移動しない操作
  await tapKeeps(page.locator(`${home} .grp > .grp-head .grp-name`).first(), '状態の見出し（畳む）');
  check(await count(`${home} .grp.collapsed`) === 1, '状態の見出しで畳まれる');
  // 見出しの開閉で好みが保存され、前の版の chMore・statusMore は消える
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('agent-host-side') ?? '{}'));
  check(!('chMore' in saved) && !('statusMore' in saved) && Array.isArray(saved.collapsed), '前の版の chMore・statusMore は次の保存で消える', saved);
  await tapKeeps(page.locator(`${home} .grp > .grp-head .grp-name`).first(), '状態の見出し（開く）');
  check(await count(madeRows) === CHATS, '開き直しても全部が並ぶ');
  await tapKeeps(page.locator(`${chan} > .grp-head .chsec-chev`), 'チャンネルの開閉');
  await tapKeeps(page.locator(`${chan} > .grp-head .chsec-chev`), 'チャンネルの開閉（戻す）');
  check(await count(threadRows) === THREADS, 'チャンネルを開き直してもスレッドが全部並ぶ');
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
  await page.locator(threadRows).last().click();   // 前の版なら畳まれていた、いちばん古いスレッド
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
