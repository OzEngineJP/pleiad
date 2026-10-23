// タッチの画面の「候補を入れる」ボタン（web/composer/suggestion.mjs。docs/design-system.md「入力欄の呼び出しと候補」）は、
// 入力欄が使えない間（設定が会話を覆って inert にしている間）は出さない（実ブラウザー）:
//   - 設定を開くと消え、どのページ（エージェント設定・使用量・プラグインなど）でも設定の上に浮かない。戻るとまた出る
//   - 入力欄にフォーカスがあるまま設定へ移ったときも同じ
//   - スマホの幅（360px）と、タッチの広い幅（1280px）の両方
// 実行: node tests/browser/suggestion-take-covered.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる）
// 本物のサーバー（fake のバックエンド・一時のデータ置き場・別ポート）だけと話す。fake は返答の「suggest:…」を候補にする
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';

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

// ボタンが見えていて、その中心で一番上にあるのがボタン自身か（覆われていれば false）
const take = (page) => page.evaluate(() => {
  const b = document.querySelector('.cg-take');
  const r = b.getBoundingClientRect();
  const shown = !b.hidden && Boolean(b.offsetParent) && r.width > 0;
  const top = shown ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  return { shown, onTop: Boolean(top && b.contains(top)) };
});
const settingsOpen = (page) => page.evaluate(() => document.body.classList.contains('settings'));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-suggest-take-'));
let server, browser;
try {
  // 試験のサーバーは既定で候補を切る（tests/lib/server.mjs）。この試験では入れておく
  fs.mkdirSync(path.join(scratch, 'data'));
  fs.writeFileSync(path.join(scratch, 'data', 'prefs.json'), JSON.stringify({ memoryLearnPaused: true, composerSuggestions: true }));
  server = await startServer({ dataDir: path.join(scratch, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  browser = await chromium.launch({ executablePath: chromiumPath() });

  for (const [name, viewport, isMobile] of [['スマホ', { width: 360, height: 760 }, true], ['広い幅', { width: 1280, height: 900 }, false]]) {
    const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile, locale: 'ja-JP' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
    await page.locator('#prompt').waitFor();
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
    // 新しい会話（狭い幅の ⚙・＋ は引き出しの中なので、押す代わりに click を呼ぶ）
    await page.evaluate(() => document.getElementById('newSession').click());
    await page.waitForTimeout(700);
    await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
    check(await page.evaluate(() => matchMedia('(pointer:coarse)').matches), `${name}: タッチの画面として開く`);

    // 候補を出す: 画面から送り、返答の候補が空の欄に出るのを待つ
    await page.locator('#prompt').click();
    await page.keyboard.insertText(`echo:${name}で直して suggest:コミットして、PR を作って`);
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => { const b = document.querySelector('.cg-take'); return b && !b.hidden && b.offsetParent; }, null, { timeout: 15_000 });
    await page.waitForTimeout(400);
    let s = await take(page);
    check(s.shown && s.onTop, `${name}: 会話では候補のボタンが出る`, s);

    // 入力欄にフォーカスがあるまま設定へ
    await page.locator('#prompt').focus();
    check(await page.evaluate(() => document.activeElement?.id === 'prompt'), `${name}: 欄にフォーカス`);
    await page.evaluate(() => document.getElementById('settings').click());
    await page.waitForFunction(() => document.body.classList.contains('settings'));
    await page.waitForTimeout(300);
    for (const tab of ['setupTab', 'usageTab', 'openContext', 'inputTab', 'updatesTab']) {
      await page.evaluate(id => document.getElementById(id).click(), tab);
      await page.waitForTimeout(200);
      s = await take(page);
      check(!s.shown && !s.onTop, `${name}: 設定（${tab}）では候補のボタンを出さない`, s);
    }
    await page.evaluate(() => document.getElementById('setupTab').click());
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(scratch, `${name}-settings.png`) });

    // 戻るとまた出る
    await page.evaluate(() => document.getElementById('backToChat').click());
    await page.waitForFunction(() => !document.body.classList.contains('settings'));
    await page.waitForTimeout(300);
    s = await take(page);
    check(s.shown && s.onTop, `${name}: 会話へ戻ると候補のボタンがまた出る`, s);

    // フォーカスが欄に無いまま開いても同じ
    await page.evaluate(() => document.activeElement?.blur());
    await page.evaluate(() => document.getElementById('settings').click());
    await page.waitForFunction(() => document.body.classList.contains('settings'));
    await page.waitForTimeout(200);
    s = await take(page);
    check(await settingsOpen(page) && !s.shown, `${name}: 欄にフォーカスが無いまま開いた設定でも出さない`, s);
    await page.evaluate(() => document.getElementById('backToChat').click());
    await page.waitForTimeout(300);
    s = await take(page);
    check(s.shown && s.onTop, `${name}: もう一度戻ると出る`, s);

    check(errors.length === 0, `${name}: 画面の例外なし`, errors);
    await ctx.close();
  }
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`suggestion-take-covered: ${results.length} 件 通過`);
} catch (e) {
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.error(`NG  ${e.message}`);
  if (server) console.error(server.tail(20));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
