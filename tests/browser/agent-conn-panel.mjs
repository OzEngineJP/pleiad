// 設定 › エージェントのカードの［アカウントと接続先］（実ブラウザー）:
//   カードの描き直し（［状態を再確認］など。renderAuth）を挟んでも、管理の面（アカウント・接続先）が枠から消えない。
//   「開く → 閉じる → ［状態を再確認］ → 開く」と「開いたまま［状態を再確認］」の後に、枠に面の中身があり、「null」が出ず、ページの例外が無い。
//   開いたまま描き直しても、打ちかけのフォーム（追加の名前）とフォーカスが残る。Claude・Codex・OpenCode のそれぞれで確かめる。
// 実行: node tests/browser/agent-conn-panel.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる。CONN_PANEL_AGENTS=codex,opencode で確かめるカードを絞る）
// 本物のサーバー（Claude・Codex・OpenCode の偽の CLI・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, ROOT } from '../lib/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const AGENTS = (process.env.CONN_PANEL_AGENTS || 'claude,codex,opencode').split(',');
const results = [];
const check = (ok, label, detail) => { if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); results.push(label); };

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

const fakeBin = name => `"${process.execPath}" "${path.join(ROOT, 'tests/lib', name)}"`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-conn-panel-'));
const ocData = path.join(dataDir, 'opencode-data');
fs.mkdirSync(ocData, { recursive: true });
let server, browser;
try {
  server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'claude,codex,opencode', AGENT_HOST_LOCALE: 'ja',
    AGENT_HOST_CLAUDE_BIN: fakeBin('fake-claude-cli.mjs'),
    AGENT_HOST_CODEX_BIN: fakeBin('fake-codex.mjs'), FAKE_CODEX_LOG: path.join(dataDir, 'fake-codex.log'),
    AGENT_HOST_OPENCODE_BIN: fakeBin('fake-opencode.mjs'), AGENT_HOST_OPENCODE_DATA: ocData } });
  const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  browser = await chromium.launch({ executablePath: chromiumPath() });

  async function session() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ja-JP' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
    await page.evaluate(() => document.getElementById('settings')?.click());
    await page.waitForSelector('#authSec .agent-card[data-agent="opencode"] .connect', { timeout: 20000 });
    return { ctx, page, errors };
  }
  const card = id => `#authSec .agent-card[data-agent="${id}"]`;
  const toggle = async (page, id) => { await page.locator(`${card(id)} .connect`).click(); await page.waitForTimeout(600); };
  const closeConn = async (page, id) => { await page.locator(`${card(id)} .connect`).click(); await page.waitForTimeout(300); };
  // ［状態を再確認］。カードが描き直される（renderAuth）
  // keepFocus: フォーカスを動かさずに押す（打っている間の裏の描き直し。SDK の取得・接続先の変更のイベントと同じ）
  const recheck = async (page, { keepFocus = false } = {}) => {
    await page.evaluate(() => { for (const c of document.querySelectorAll('#authSec .agent-card')) c.dataset.old = '1'; });
    if (keepFocus) await page.evaluate(() => document.getElementById('refreshAgents').click());
    else await page.locator('#refreshAgents').click();
    await page.waitForFunction(() => document.querySelectorAll('#authSec .agent-card').length && !document.querySelector('#authSec .agent-card[data-old]'), null, { timeout: 15000 });
    await page.waitForTimeout(300);
  };
  // 開いている枠の中身（節ごと）。面が入っていて見えているか、文字に「null」が無いか
  const slots = (page, id) => page.evaluate(sel => [...document.querySelectorAll(`${sel} .agent-conn .conn-sec`)].map(s => {
    const slot = s.querySelector('.conn-slot');
    const panel = slot.querySelector('.mp-panel');
    return { sec: s.dataset.sec, panel: Boolean(panel && !panel.hidden && panel.textContent.trim()), text: slot.textContent.trim().slice(0, 80),
      visible: !s.closest('.agent-conn').hidden };
  }), card(id));
  const expect = { claude: ['accounts', 'endpoints'], codex: ['accounts', 'endpoints'], opencode: ['accounts'] };
  const filled = (page, id, label) => slots(page, id).then(list => {
    check(list.length === expect[id].length && list.every((s, i) => s.sec === expect[id][i]), `${label}: 節が ${expect[id].join('・')}`, list);
    check(list.every(s => s.visible && s.panel), `${label}: どの枠にも面の中身がある`, list);
    check(list.every(s => !/\bnull\b/.test(s.text)), `${label}: 枠に「null」が出ない`, list);
  });

  // 場面ごとに新しいページで流す（1 つの場面で面が外れても、ほかの場面の結果が分かる）
  const scenes = [];
  for (const id of AGENTS) {
    scenes.push([`${id}: 開く → 閉じる → 再確認 → 開く`, async page => {
      await toggle(page, id);
      await filled(page, id, `${id}: 初めて開く`);
      await closeConn(page, id);
      check(await page.locator(`${card(id)} .agent-conn`).isHidden(), `${id}: 閉じると面が畳まれる`);
      await recheck(page);
      await toggle(page, id);
      await filled(page, id, `${id}: 閉じて再確認した後に開く`);
      // 別のカードへ移っても面は空にならない（面はカードどうしで共有）
      const other = id === 'opencode' ? 'codex' : 'opencode';
      await toggle(page, other);
      await filled(page, other, `${id} の後に ${other} を開く`);
    }]);
    scenes.push([`${id}: 開いたまま再確認`, async page => {
      await toggle(page, id);
      await recheck(page);
      await filled(page, id, `${id}: 開いたまま再確認`);
      await recheck(page);
      await filled(page, id, `${id}: 開いたまま 2 回目の再確認`);
      const panels = await page.evaluate(() => ['claudeAccountsPanel', 'agentAccountsPanel', 'compatEndpointsPanel'].map(x => document.querySelectorAll(`#${x}`).length));
      check(panels.every(n => n === 1), `${id}: 管理の面は文書に 1 つずつのまま（作り直さない）`, panels);
      // 打ちかけのフォームは描き直しても残る（アカウントの追加の名前。フォーカスも）
      const form = id === 'claude' ? { add: '#caAdd', name: '#caName' } : { add: '#aaAdd', name: '#aaName' };
      await page.locator(`${card(id)} ${form.add}`).click();
      await page.locator(`${card(id)} ${form.name}`).fill('打ちかけ');
      await recheck(page, { keepFocus: true });
      check(await page.locator(`${card(id)} ${form.name}`).inputValue() === '打ちかけ', `${id}: 開いたまま再確認しても打ちかけの名前が残る`);
      check(await page.evaluate(sel => document.activeElement === document.querySelector(sel), `${card(id)} ${form.name}`), `${id}: 打っていた欄のフォーカスも残る`);
    }]);
  }
  const failed = [];
  for (const [name, run] of scenes) {
    const { ctx, page, errors } = await session();
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
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
