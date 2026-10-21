// ログインを待っている間の［やめる］（実ブラウザー。docs/design-system.md「ログインを待っている間」、ADR 0243）:
//   - 設定のカード: ［ログイン］→ 回る印と「ログインを待っている」・［やめる］（焦点が移る）・ログインの画面を開く／リンクをコピー。
//     ［やめる］は押したらすぐ押せなくなり、2 度押してもやめる命令は 1 回。やめたら一文を出さずに「未ログイン」と［ログイン］へ戻り、焦点も［ログイン］へ
//   - 時間切れ: 「時間切れになりました（10 分）。」をカードの中に出す（会話には足さない）
//   - 初回の案内の行: 同じく［やめる］と開く・写す入口。やめたら［ログイン］へ戻る
// 実行: node tests/browser/login-cancel-card.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる）
// 本物のサーバー（fake のバックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
// fake のログインは AGENT_HOST_FAKE_LOGIN_MS の間待ち、AGENT_HOST_FAKE_LOGIN_FAIL=timeout で時間切れにする
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

const card = '#authSec .agent-card[data-agent="fake"]';
const servers = [];
const dirs = [];
let browser;
async function serve(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-login-cancel-'));
  dirs.push(dataDir);
  const server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja', ...env } });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/?token=${server.token}`;
}

// やめる命令（authCancel）を数える。WebSocket の送信を覗くだけ
const countCommands = () => {
  const send = WebSocket.prototype.send;
  window.__commands = [];
  WebSocket.prototype.send = function (data) {
    try { const m = JSON.parse(data); if (m?.kind === 'command') window.__commands.push(m.command); } catch {}
    return send.call(this, data);
  };
};

async function session(url, { onboarding = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ja-JP' });
  await ctx.addInitScript(countCommands);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  if (!onboarding) {
    await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
    await page.evaluate(() => document.getElementById('settings')?.click());
    await page.waitForSelector(`${card} [data-act="login"]`, { timeout: 20000 });
  }
  return { ctx, page, errors };
}
const cardState = page => page.evaluate(sel => {
  const c = document.querySelector(sel);
  const act = c?.querySelector('[data-act="login"]');
  return {
    state: c?.querySelector('.agent-state')?.textContent.trim(),
    spin: Boolean(c?.querySelector('.agent-state.spin .run')),
    act: act?.textContent.trim(), label: act?.getAttribute('aria-label'), disabled: act?.disabled,
    focused: Boolean(act && document.activeElement === act),
    links: [...(c?.querySelectorAll('.auth-links a, .auth-links button') ?? [])].map(x => ({ text: x.textContent.trim(), href: x.getAttribute('href') })),
    note: c?.querySelector(':scope > .auth-note')?.textContent.trim() ?? null,
    live: document.getElementById('authLive')?.textContent ?? '',
  };
}, card);
// 会話に足された一行（URL・ログインの結果）
const sysLines = page => page.evaluate(() => [...document.querySelectorAll('.m.sys')].map(x => x.textContent));

try {
  browser = await chromium.launch({ executablePath: chromiumPath() });
  const scenes = [];

  scenes.push(['設定のカード: 待っている間とやめる', await serve({ AGENT_HOST_FAKE_LOGIN_MS: '60000' }), {}, async page => {
    const before = await cardState(page);
    check(before.state === '未ログイン' && before.act === 'ログイン', 'はじめは「未ログイン」と［ログイン］', before);
    await page.locator(`${card} [data-act="login"]`).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(sel => document.querySelector(`${sel} .auth-links`), card, { timeout: 10000 });
    const pend = await cardState(page);
    check(pend.state === 'ログインを待っている' && pend.spin, '待っている間は回る印と「ログインを待っている」', pend);
    check(pend.act === 'やめる' && pend.label === 'Fake (test) のログインをやめる' && pend.disabled === false, '［ログイン］の場所に［やめる］（読み上げの名前にエージェント名）', pend);
    check(pend.focused, '焦点は［やめる］へ移る', pend);
    check(pend.links.length === 2 && pend.links[0].text === 'ログインの画面を開く' && pend.links[0].href === 'https://example.invalid/login' && pend.links[1].text === 'リンクをコピー',
      'URL が届くと［ログインの画面を開く］［リンクをコピー］', pend.links);
    check(pend.live === 'Fake (test): ログインを待っている', '状態の変化を読み上げる', pend.live);
    check(!(await sysLines(page)).some(x => x.includes('example.invalid')), '設定から始めたログインは会話に URL の一行を足さない', await sysLines(page));

    // 2 度押し: 1 度目で押せなくなり、2 度目は届かない
    const pressed = await page.evaluate(sel => {
      const stop = document.querySelector(`${sel} [data-act="login"]`);
      stop.click();
      const disabled = stop.disabled;
      stop.click();
      return { disabled };
    }, card);
    check(pressed.disabled, '［やめる］は押したらすぐ押せなくなる', pressed);
    await page.waitForFunction(sel => document.querySelector(`${sel} [data-act="login"]`)?.textContent.trim() === 'ログイン', card, { timeout: 10000 });
    await page.waitForTimeout(400);
    const after = await cardState(page);
    check(after.state === '未ログイン' && after.act === 'ログイン' && !after.links.length, 'やめると「未ログイン」と［ログイン］に戻り、入口は消える', after);
    check(after.note === null, 'やめたときは一文を出さない', after.note);
    check(after.focused, '焦点は［ログイン］へ戻る', after);
    const sent = await page.evaluate(() => window.__commands.filter(c => c === 'authCancel').length);
    check(sent === 1, '2 度押してもやめる命令は 1 回', sent);
    check(!(await sysLines(page)).some(x => /やめ|キャンセル|失敗|できません/.test(x)), 'やめたことを会話に書かない', await sysLines(page));

    // もう一度始められる
    await page.locator(`${card} [data-act="login"]`).click();
    await page.waitForFunction(sel => document.querySelector(`${sel} [data-act="login"]`)?.textContent.trim() === 'やめる', card, { timeout: 10000 });
    check(true, 'やめた後はすぐ次のログインを始められる');
    await page.locator(`${card} [data-act="login"]`).click();
    await page.waitForFunction(sel => document.querySelector(`${sel} [data-act="login"]`)?.textContent.trim() === 'ログイン', card, { timeout: 10000 });
  }]);

  scenes.push(['設定のカード: 時間切れ', await serve({ AGENT_HOST_FAKE_LOGIN_MS: '1500', AGENT_HOST_FAKE_LOGIN_FAIL: 'timeout' }), {}, async page => {
    await page.locator(`${card} [data-act="login"]`).click();
    await page.waitForFunction(sel => document.querySelector(`${sel} > .auth-note`), card, { timeout: 15000 });
    await page.waitForTimeout(400);
    const st = await cardState(page);
    check(st.note === '時間切れになりました（10 分）。', '時間切れの一文をカードの中に出す', st);
    check(st.state === '未ログイン' && st.act === 'ログイン', '時間切れの後は［ログイン］でやり直せる', st);
    check(st.live.includes('時間切れになりました（10 分）。'), '時間切れも読み上げる', st.live);
    check(!(await sysLines(page)).some(x => x.includes('時間切れ') || x.includes('timed out')), '時間切れを会話には足さない', await sysLines(page));
    // やり直すと一文は消える
    await page.locator(`${card} [data-act="login"]`).click();
    await page.waitForFunction(sel => document.querySelector(`${sel} [data-act="login"]`)?.textContent.trim() === 'やめる', card, { timeout: 10000 });
    check((await cardState(page)).note === null, 'やり直すと時間切れの一文は消える');
  }]);

  scenes.push(['初回の案内の行: 待っている間とやめる', await serve({ AGENT_HOST_FAKE_LOGIN_MS: '60000' }), { onboarding: true }, async page => {
    await page.waitForSelector('#onboardingDialog[open] #onboardingAgentList [data-act="login"]', { timeout: 20000 });
    const row = '#onboardingAgentList .onboarding-agent-item';
    const hint = await page.evaluate(() => document.getElementById('onboardingError').textContent.trim());
    await page.locator(`${row} [data-act="login"]`).click();
    await page.waitForFunction(sel => document.querySelector(`${sel} .ob-links`), row, { timeout: 10000 });
    const pend = await page.evaluate(sel => {
      const r = document.querySelector(sel);
      const act = r.querySelector('[data-act="login"]');
      return { wait: r.querySelector('.agent-state .wait')?.textContent.trim(), spin: Boolean(r.querySelector('.wait .run')), act: act?.textContent.trim(), focused: document.activeElement === act,
        links: [...r.querySelectorAll('.ob-links a, .ob-links button')].map(x => x.textContent.trim()), open: document.getElementById('onboardingDialog').open };
    }, row);
    check(pend.wait === 'ログインを待っている' && pend.spin && pend.act === 'やめる' && pend.focused, '行にも回る印と［やめる］（焦点が移る）', pend);
    check(pend.links.join() === 'ログインの画面を開く,リンクをコピー' && pend.open, '名前の下に開く・写す入口（案内は開いたまま）', pend);
    await page.locator(`${row} [data-act="login"]`).click();
    await page.waitForFunction(sel => document.querySelector(`${sel} [data-act="login"]`)?.textContent.trim() === 'ログイン', row, { timeout: 10000 });
    await page.waitForTimeout(300);
    const after = await page.evaluate(sel => {
      const act = document.querySelector(`${sel} [data-act="login"]`);
      return { focused: document.activeElement === act, links: document.querySelectorAll(`${sel} .ob-links`).length, error: document.getElementById('onboardingError').textContent.trim(),
        live: document.getElementById('onboardingLive').textContent };
    }, row);
    check(after.focused && after.links === 0 && after.error === hint, 'やめると［ログイン］に戻り、焦点も戻り、案内は始める前のまま（やめたことは書かない）', { ...after, hint });
    check(after.live === 'Fake (test): 未ログイン', '行の状態の変化を読み上げる', after.live);
  }]);

  const failed = [];
  for (const [name, url, opts, run] of scenes) {
    const { ctx, page, errors } = await session(url, opts);
    try {
      await run(page);
      check(errors.length === 0, `${name}: ページの例外が無い`, errors);
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
    }
    await ctx.close();
  }

  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  if (failed.length) {
    console.log(failed.map(f => `  NG  ${f}`).join('\n'));
    process.exitCode = 1;
  } else console.log(`\n全て通過 ${results.length} 判定`);
} catch (e) {
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`  NG  ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  for (const s of servers) await s.stop().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
