// 設定 › エージェントのカードの［接続先］（実ブラウザー。ADR 0359）:
//   一覧は灰色の面 1 枚に「CLI のログイン → 登録したアカウント → 互換の接続先 →［＋ 接続先を追加］」の順。頭の行は「接続先 N」と［状態を確認］［接続先］だけ。
//   ［既定にする］で「· 新しい会話の既定」の印が 1 か所だけ移る。［＋ 接続先を追加］→ 種類（公式・互換のプリセット）→ 追加の欄。
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
fs.writeFileSync(path.join(dataDir, 'onboarding.json'), JSON.stringify({ seen: true, setupComplete: true, backend: 'claude', cwd: dataDir }));
fs.writeFileSync(path.join(dataDir, 'claude-accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: 'acct-00000000c1a0', name: '仕事', createdAt: '2026-11-01T00:00:00.000Z' }] }));
const home = path.join(dataDir, 'home');
for (const d of ['.claude', '.codex']) fs.mkdirSync(path.join(home, d), { recursive: true });
let server, browser;
try {
  server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'claude,codex,opencode', AGENT_HOST_LOCALE: 'ja',
    AGENT_HOST_CLAUDE_BIN: fakeBin('fake-claude-cli.mjs'),
    AGENT_HOST_CODEX_BIN: fakeBin('fake-codex.mjs'), FAKE_CODEX_LOG: path.join(dataDir, 'fake-codex.log'),
    AGENT_HOST_OPENCODE_BIN: fakeBin('fake-opencode.mjs'), AGENT_HOST_OPENCODE_DATA: ocData,
    USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') } });
  const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  browser = await chromium.launch({ executablePath: chromiumPath() });

  async function session() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ja-JP' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url, { waitUntil: 'load' });
    // 起動の直後は設定のボタンがまだ効かないことがあるので、カードが出るまで押し直す
    for (let i = 0; ; i++) {
      await page.waitForTimeout(1000);
      await page.evaluate(() => { document.getElementById('onboardingDialog')?.close(); document.getElementById('settings')?.click(); });
      try { await page.waitForSelector('#authSec .agent-card[data-agent="opencode"] .connect', { timeout: 5000 }); break; }
      catch (e) { if (i > 3) throw e; }
    }
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
    return { sec: s.dataset.sec, panel: Boolean(panel && !panel.hidden), text: slot.textContent.trim().slice(0, 80),
      visible: !s.closest('.agent-conn').hidden };
  }), card(id));
  const expect = { claude: ['accounts', 'endpoints'], codex: ['accounts', 'endpoints'], opencode: ['accounts'] };
  const filled = (page, id, label) => slots(page, id).then(list => {
    check(list.length === expect[id].length && list.every((s, i) => s.sec === expect[id][i]), `${label}: 節が ${expect[id].join('・')}`, list);
    check(list.every(s => s.visible && s.panel), `${label}: どの枠にも面がある`, list);
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
      // 追加は一覧の下の［＋ 接続先を追加］→ 種類の「公式のアカウント」（互換を持たない OpenCode は種類を挟まない）
      const form = id === 'claude' ? { name: '[data-account^="new"] .mp-name-in' } : { name: '#aaName' };
      await page.locator(`${card(id)} [data-add]`).click();
      if (expect[id].includes('endpoints')) {
        check(await page.evaluate(sel => document.activeElement === document.querySelector(`${sel} .conn-kinds .mp-preset`), card(id)), `${id}: 種類の最初の候補へフォーカスが行く`);
        await page.locator(`${card(id)} [data-kind="official"]`).click();
      }
      check(await page.locator(`${card(id)} [data-add]`).count() === 0, `${id}: 追加の欄が開いている間は［＋ 接続先を追加］を出さない`);
      await page.locator(`${card(id)} ${form.name}`).fill('打ちかけ');
      await recheck(page, { keepFocus: true });
      check(await page.locator(`${card(id)} ${form.name}`).inputValue() === '打ちかけ', `${id}: 開いたまま再確認しても打ちかけの名前が残る`);
      check(await page.evaluate(sel => document.activeElement === document.querySelector(sel), `${card(id)} ${form.name}`), `${id}: 打っていた欄のフォーカスも残る`);
    }]);
  }
  for (const id of AGENTS) {
    scenes.push([`${id}: 一覧の並び・頭の行・既定の印`, async page => {
      await toggle(page, id);
      const shape = () => page.evaluate(sel => {
        const c = document.querySelector(sel);
        const panel = c.querySelector('.agent-conn > .conn-panel');
        const kids = [...panel.children].map(n => n.dataset.conn ? `card:${n.dataset.conn}` : n.dataset.sec ? `sec:${n.dataset.sec}` : n.className);
        const nameOf = cc => { const st = cc.querySelector('.mp-name strong').cloneNode(true); st.querySelector('.def')?.remove(); return st.textContent.trim(); };
        const cards = [...panel.querySelectorAll('.cc')].filter(cc => cc.offsetParent !== null);
        return { kids, names: cards.map(nameOf), defaults: cards.filter(cc => cc.querySelector('.def')).map(nameOf),
          head: c.querySelector('.ar2-h .arow-s')?.textContent.trim(), headActs: [...c.querySelectorAll('.ar2-a > button')].map(b => b.textContent.trim()),
          h4: panel.querySelectorAll('h4').length, cli: [...panel.querySelector('[data-conn="cli"]').querySelectorAll('.mp-card-actions button')].map(b => b.textContent.trim()) };
      }, card(id));
      let s = await shape();
      check(s.kids[0] === 'card:cli' && /\bconn-add\b/.test(s.kids.at(-1)), `${id}: 先頭は CLI のログイン、末尾は［＋ 接続先を追加］`, s.kids);
      check(s.kids.filter(k => k.startsWith('sec:')).join() === expect[id].map(x => `sec:${x}`).join(), `${id}: アカウント → 互換の順`, s.kids);
      check(s.names[0] === 'CLI のログイン', `${id}: CLI のログインの名前`, s.names);
      check(s.h4 === 0, `${id}: 面に見出しを置かない`);
      check(/^(接続先 \d+|⚠ 対応が要る接続先 \d+)$/.test(s.head), `${id}: 頭の行は接続先の数`, s.head);
      check(s.headActs.join() === '状態を確認,接続先', `${id}: 頭の行のボタンは［状態を確認］［接続先］だけ`, s.headActs);
      check(s.defaults.join() === 'CLI のログイン', `${id}: 既定の印は CLI のログインの 1 か所`, s.defaults);
      check(!s.cli.includes('既定にする') && s.cli.includes('ログアウト'), `${id}: CLI のログインのカードは［ログアウト］（既定なので［既定にする］なし）`, s.cli);
      // アカウントを 1 つ足して既定にする → 印が移り、CLI のログインに［既定にする］が出る
      // （Claude はログインが済んだアカウントだけが一覧に載るので、前から登録してある「仕事」を使う）
      if (id === 'claude') {
        check(s.names.includes('仕事') && /^(接続先 2|⚠ 対応が要る接続先 \d+)$/.test(s.head), `${id}: 登録したアカウントが数に入る`, { names: s.names, head: s.head });
      } else {
        await page.locator(`${card(id)} [data-add]`).click();
        if (expect[id].includes('endpoints')) await page.locator(`${card(id)} [data-kind="official"]`).click();
        await page.locator(`${card(id)} #aaName`).fill('仕事');
        await page.locator(`${card(id)} #aaName`).press('Enter');
        await page.waitForFunction(sel => [...document.querySelectorAll(`${sel} .conn-sec[data-sec="accounts"] .cc .mp-name strong`)].some(n => n.textContent.trim() === '仕事'), card(id), { timeout: 15000 });
        await page.waitForTimeout(600);
        const before = s.head;
        s = await shape();
        check(s.head !== before && /^(接続先 2|⚠ 対応が要る接続先 \d+)$/.test(s.head), `${id}: 足すと数が増える`, { before, after: s.head });
      }
      const work = page.locator(`${card(id)} .conn-sec[data-sec="accounts"] .cc`).filter({ hasText: '仕事' }).first();
      const make = work.getByRole('button', { name: '既定にする' });
      if (await make.count()) {
        await make.click();
        await page.waitForFunction(sel => [...document.querySelectorAll(`${sel} .cc .def`)].some(d => d.closest('.cc').textContent.includes('仕事')), card(id), { timeout: 10000 });
        s = await shape();
        check(s.defaults.join() === '仕事', `${id}: ［既定にする］で印が 1 か所だけ移る`, s.defaults);
        check(s.cli.includes('既定にする'), `${id}: CLI のログインに［既定にする］が出る`, s.cli);
        await page.locator(`${card(id)} [data-conn="cli"]`).getByRole('button', { name: '既定にする' }).click();
        await page.waitForFunction(sel => document.querySelector(`${sel} [data-conn="cli"] .def`), card(id), { timeout: 10000 });
        s = await shape();
        check(s.defaults.join() === 'CLI のログイン', `${id}: CLI のログインへ戻せる`, s.defaults);
      } else check(false, `${id}: 足したアカウントに［既定にする］がある`);
    }]);
  }
  // キーボードの人の行き先: ［接続先］を Enter で開いても［接続先］に残る。追加を Esc でやめると［＋ 接続先を追加］へ戻る（描き直しで消えるボタンに居ても同じ役の要素へ戻す）
  for (const id of AGENTS) {
    scenes.push([`${id}: キーボードのフォーカス（［接続先］・［＋ 接続先を追加］）`, async page => {
      const on = sel => page.evaluate(s => document.activeElement === document.querySelector(s), `${card(id)} ${sel}`);
      await page.locator(`${card(id)} .connect`).focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(900);
      check(await on('.connect'), `${id}: ［接続先］を Enter で開いても、フォーカスは［接続先］に残る`);
      await page.locator(`${card(id)} [data-add]`).focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      check(await on('[data-add]'), `${id}: 追加を Esc でやめると、フォーカスは［＋ 接続先を追加］へ戻る`);
      check(await page.locator(`${card(id)} .agent-conn`).isVisible(), `${id}: Esc は 1 層だけ閉じ、設定の画面や接続先の一覧は閉じない`);
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
