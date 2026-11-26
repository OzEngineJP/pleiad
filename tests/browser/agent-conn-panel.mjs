// 設定 › エージェントのカードの［接続先］（実ブラウザー。ADR 0359）:
//   一覧は灰色の面 1 枚に「CLI のログイン → 登録したアカウント → 互換の接続先 →［＋ 接続先を追加］」の順。頭の行は「接続先 N」と［状態を確認］［接続先］だけ。
//   ［既定にする］で「· 新しい会話の既定」の印が 1 か所だけ移る。［＋ 接続先を追加］→ 種類（公式・互換のプリセット）→ 追加の欄。
//   カードの描き直し（［状態を再確認］など。renderAuth）を挟んでも、管理の面（アカウント・接続先）が枠から消えない。
//   「開く → 閉じる → ［状態を再確認］ → 開く」と「開いたまま［状態を再確認］」の後に、枠に面の中身があり、「null」が出ず、ページの例外が無い。
//   開いたまま描き直しても、打ちかけのフォーム（追加の名前）とフォーカスが残る。Claude・Codex・OpenCode・Antigravity のそれぞれで確かめる。
//   CLI のログインのカードの［ログアウト］は能力の印 logout で出し分ける: Claude・Codex・Grok は［ログアウト］、
//   Pleiad から外せない OpenCode は［ログアウト］を出さず、端末のコマンド（opencode auth logout）と［コピー］を案内する。
//   Antigravity は agy が ACP の logout を申告するので［ログアウト］を出す。押すとカードの中で確かめ（アプリと端末の agy も外れる）、
//   Esc・［やめる］で閉じ、失敗はカードの中に赤で出し、外れたら「⚠ ログインしていません」と［ログインする］（ブラウザーでのログイン。端末の案内は出さない）。
//   Claude・Codex・Grok の［ログアウト］は確かめ無しのまま（docs/design-system.md「接続先の一覧」承認済み 2026-11-26）。
//   Antigravity だけ、追加の前に注意のモーダル（2 つ目の Google アカウント）が出る: やめる → 名前の欄は開かない、理解して追加する → 名前の欄。360px に収まる。
//   SHOT_DIR を渡すと、そのモーダルの画面（ja・1280px と 360px）と、Antigravity のログアウトの各場面（1280・360・ダーク）を PNG で保存する。
// 実行: node tests/browser/agent-conn-panel.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる。CONN_PANEL_AGENTS=codex,opencode で確かめるカードを絞る）
// 本物のサーバー（Claude・Codex・OpenCode・Grok・Antigravity の偽の CLI・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
// 🔴 Antigravity は身代わり（fake-agy.mjs）だけ。本物の agy でログアウトすると、この PC の Antigravity のアプリまでログアウトされる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, ROOT } from '../lib/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const AGENTS = (process.env.CONN_PANEL_AGENTS || 'claude,codex,opencode,antigravity').split(',');
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
// Grok のログイン済み（偽の CLI は AGENT_HOST_GROK_HOME の auth.json があればログイン済みと答える）
const grokHome = path.join(dataDir, 'grok-home');
fs.mkdirSync(grokHome, { recursive: true });
fs.writeFileSync(path.join(grokHome, 'auth.json'), '{"fixture":{"api_key":"fake"}}');
// Antigravity の 1 つ目のログイン（身代わりの「OS の資格情報ストア」）。ログアウトで消え、ブラウザーでのログインで書かれる
const agyAuth = path.join(dataDir, 'agy-signed-in');
fs.writeFileSync(agyAuth, 'ok');
// これがある間だけ agy がログアウトを断る（失敗の場面）
const agyLogoutFail = path.join(dataDir, 'agy-logout-fail');
let server, browser;
try {
  server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'claude,codex,opencode,antigravity,grok', AGENT_HOST_LOCALE: 'ja',
    AGENT_HOST_AGY_BIN: fakeBin('fake-agy.mjs'), FAKE_AGY_NEEDS_AUTH: '1', FAKE_AGY_AUTH_FILE: agyAuth,
    FAKE_AGY_LOGOUT_FAIL_FILE: agyLogoutFail, FAKE_AGY_AUTH_HOLD_MS: '2500',
    AGENT_HOST_CLAUDE_BIN: fakeBin('fake-claude-cli.mjs'),
    AGENT_HOST_CODEX_BIN: fakeBin('fake-codex.mjs'), FAKE_CODEX_LOG: path.join(dataDir, 'fake-codex.log'),
    AGENT_HOST_OPENCODE_BIN: fakeBin('fake-opencode.mjs'), AGENT_HOST_OPENCODE_DATA: ocData,
    AGENT_HOST_GROK_BIN: fakeBin('fake-grok.mjs'), AGENT_HOST_GROK_HOME: grokHome, GROK_HOME: grokHome,
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
  const expect = { claude: ['accounts', 'endpoints'], codex: ['accounts', 'endpoints'], opencode: ['accounts'], antigravity: ['accounts'] };
  // 追加の前に注意のモーダルが出るエージェントは、［理解して追加する］まで進める（出ないものは何もしない）
  const confirmNotice = async (page, id) => {
    if (id !== 'antigravity') return;
    await page.waitForSelector(`${card(id)} dialog.aa-notice[open], dialog.aa-notice[open]`, { timeout: 5000 });
    await page.locator('dialog.aa-notice [data-act="notice-ok"]').click();
    await page.waitForSelector('dialog.aa-notice', { state: 'detached', timeout: 5000 });
  };
  // Pleiad から外せるか（能力の印 logout）。外せないエージェントは［ログアウト］を出さず、端末のコマンドを案内する
  const canLogout = { claude: true, codex: true, opencode: false, antigravity: true, grok: true };
  // CLI のログインのカードの操作と、外し方の案内（.conn-guide: 文・コマンド・［コピー］）
  const cliCard = (page, id) => page.evaluate(sel => {
    const cc = document.querySelector(`${sel} [data-conn="cli"]`);
    const guide = cc.querySelector('.conn-guide');
    return { actions: [...cc.querySelectorAll('.mp-card-actions button')].map(b => b.textContent.trim()),
      logoutButtons: cc.querySelectorAll('[data-act="logout"]').length,
      guide: guide ? { text: guide.textContent.trim(), code: guide.querySelector('code')?.textContent ?? null,
        copy: [...guide.querySelectorAll('button')].map(b => b.textContent.trim()), mono: guide.querySelector('code') ? getComputedStyle(guide.querySelector('code')).fontFamily : null } : null };
  }, card(id));
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
      await confirmNotice(page, id);
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
      check(!s.cli.includes('既定にする'), `${id}: CLI のログインのカードに［既定にする］は無い（既定なので）`, s.cli);
      // Antigravity は明示の確認（［状態を再確認］）でログイン済みと分かってから［ログアウト］を出す（受け身の確認は agy を起こさない）
      if (id === 'antigravity') await recheck(page);
      const cli = await cliCard(page, id);
      if (canLogout[id]) {
        check(cli.actions.includes('ログアウト') && cli.logoutButtons === 1 && !cli.guide, `${id}: 外せるエージェントは［ログアウト］（案内は出さない）`, cli);
      } else {
        check(!cli.actions.includes('ログアウト') && cli.logoutButtons === 0, `${id}: 外せないエージェントは［ログアウト］を出さない（押しても失敗するだけ）`, cli);
      }
      if (id === 'antigravity') check(!cli.guide, `${id}: 端末で外す案内は出さない`, cli);
      if (id === 'opencode') {
        // コマンドはログインの案内と同じ書き方（見つけた CLI の場所 + auth logout。偽の CLI なのでその場所が入る）
        check(/(^|[\s"])auth logout$/.test(cli.guide?.code ?? '') && /fake-opencode\.mjs/.test(cli.guide.code) && cli.guide.text.startsWith('外すには、端末で') && cli.guide.copy.join() === 'コピー',
          `${id}: 代わりに、外し方（端末で … auth logout）と［コピー］を案内する`, cli);
        check(/mono|consolas|courier/i.test(cli.guide.mono ?? ''), `${id}: コマンドは等幅`, cli.guide.mono);
      }
      // アカウントを 1 つ足して既定にする → 印が移り、CLI のログインに［既定にする］が出る
      // （Claude はログインが済んだアカウントだけが一覧に載るので、前から登録してある「仕事」を使う）
      if (id === 'claude') {
        check(s.names.includes('仕事') && /^(接続先 2|⚠ 対応が要る接続先 \d+)$/.test(s.head), `${id}: 登録したアカウントが数に入る`, { names: s.names, head: s.head });
      } else {
        await page.locator(`${card(id)} [data-add]`).click();
        if (expect[id].includes('endpoints')) await page.locator(`${card(id)} [data-kind="official"]`).click();
        await confirmNotice(page, id);
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
  // Antigravity: 追加の前の注意のモーダル（文面・やめる・理解して追加する・360px）
  if (AGENTS.includes('antigravity')) {
    scenes.push(['antigravity: 追加の前の注意のモーダル', async page => {
      const id = 'antigravity';
      const shots = process.env.SHOT_DIR;
      await toggle(page, id);
      await page.locator(`${card(id)} [data-add]`).click();
      await page.waitForSelector('dialog.aa-notice[open]', { timeout: 5000 });
      const dlg = page.locator('dialog.aa-notice');
      const text = await dlg.innerText();
      check(text.includes('2 つ目の Google アカウントを追加します') && text.includes('サポート対象外とされています'), 'antigravity: 注意の題と本文（ja）', text);
      check(await dlg.getByRole('button', { name: '理解して追加する' }).count() === 1 && await dlg.getByRole('button', { name: 'やめる' }).count() === 1, 'antigravity: ボタンは［理解して追加する］［やめる］');
      check(await page.locator(`${card(id)} #aaForm`).isHidden(), 'antigravity: 確認の前は名前の欄が開かない');
      if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, 'antigravity-add-notice-ja-1280.png') }); }
      await page.setViewportSize({ width: 360, height: 740 });
      await page.waitForTimeout(300);
      const box = await dlg.boundingBox();
      check(box && box.x >= 0 && box.x + box.width <= 360 && box.y >= 0 && box.y + box.height <= 740, 'antigravity: 360px にモーダルが収まる', box);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= 360 && document.querySelector('dialog.aa-notice').scrollWidth <= document.querySelector('dialog.aa-notice').clientWidth), 'antigravity: 360px で横にあふれない');
      if (shots) await page.screenshot({ path: path.join(shots, 'antigravity-add-notice-ja-360.png') });
      await dlg.getByRole('button', { name: 'やめる' }).click();
      await page.waitForSelector('dialog.aa-notice', { state: 'detached', timeout: 5000 });
      check(await page.locator(`${card(id)} #aaForm`).isHidden(), 'antigravity: やめると名前の欄は開かない');
      await page.waitForTimeout(400);
      check(await page.evaluate(sel => document.activeElement === document.querySelector(sel), `${card(id)} [data-add]`), 'antigravity: やめると［＋ 接続先を追加］へフォーカスが戻る');
      await page.locator(`${card(id)} [data-add]`).click();
      await page.waitForSelector('dialog.aa-notice[open]', { timeout: 5000 });
      await page.keyboard.press('Escape');
      await page.waitForSelector('dialog.aa-notice', { state: 'detached', timeout: 5000 });
      check(await page.locator(`${card(id)} #aaForm`).isHidden(), 'antigravity: Esc もやめると同じ');
      await page.locator(`${card(id)} [data-add]`).click();
      await confirmNotice(page, id);
      check(await page.locator(`${card(id)} #aaForm`).isVisible(), 'antigravity: ［理解して追加する］で名前の欄が開く');
      const form = await page.locator(`${card(id)} #aaForm`).boundingBox();
      check(form && form.x >= 0 && form.x + form.width <= 360, 'antigravity: 360px で名前の欄も収まる', form);
    }]);
  }
  // Grok も CLI のログインのカードを持つ。ここは外せる側（Claude・Codex と同じく［ログアウト］。案内は出さない）の確認
  scenes.push(['grok: CLI のログインのカードは［ログアウト］（案内なし）', async page => {
    await toggle(page, 'grok');
    await page.waitForSelector(`${card('grok')} [data-conn="cli"]`, { timeout: 15000 });
    const cli = await cliCard(page, 'grok');
    check(canLogout.grok && cli.actions.includes('ログアウト') && cli.logoutButtons === 1 && !cli.guide, 'grok: 外せるエージェントは［ログアウト］（案内は出さない）', cli);
  }]);
  // Antigravity の 1 つ目のログインの［ログアウト］（確かめ・やめる・失敗・外した後・ブラウザーでの入り直し・360px・ダーク）。
  // 外す・入り直すのは身代わりの印のファイル（agyAuth）だけ。最後に入り直して、ほかの場面と同じログイン済みへ戻す
  if (AGENTS.includes('antigravity')) {
    scenes.push(['antigravity: ［ログアウト］の確かめ・失敗・外した後・ブラウザーでの入り直し', async page => {
      const id = 'antigravity';
      const cli = `${card(id)} [data-conn="cli"]`;
      const shots = process.env.SHOT_DIR;
      const on = sel => page.evaluate(s => document.activeElement === document.querySelector(s), sel);
      // 1280・360 のライトとダークで、Antigravity のカードを撮る（360 ではカードの中で横にあふれないことも確かめる）
      const shoot = async (scene) => {
        for (const [theme, width] of [['light', 1280], ['light', 360], ['dark', 1280], ['dark', 360]]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.evaluate(t => { if (t === 'dark') document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme; }, theme);
          await page.waitForTimeout(250);
          if (width === 360) {
            const fit = await page.evaluate(sel => { const c = document.querySelector(sel); const r = c.getBoundingClientRect(); return { right: r.right, scroll: c.scrollWidth - c.clientWidth, doc: document.documentElement.scrollWidth }; }, cli);
            check(fit.right <= 360 && fit.scroll <= 1 && fit.doc <= 360, `${id}: ${scene} は 360px でカードの中に収まる（${theme}）`, fit);
          }
          if (shots) {
            fs.mkdirSync(shots, { recursive: true });
            const loc = page.locator(card(id));
            await loc.scrollIntoViewIfNeeded();
            await loc.screenshot({ path: path.join(shots, `impl-${theme}-${width}-${scene}.png`), animations: 'disabled' });
          }
        }
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.evaluate(() => { delete document.documentElement.dataset.theme; });
        await page.waitForTimeout(200);
      };
      const cliState = () => page.evaluate(sel => {
        const c = document.querySelector(sel);
        return { status: c.querySelector('.mp-ln')?.textContent.trim() ?? '', warn: Boolean(c.querySelector('.mp-ln.warn')),
          acts: [...c.querySelectorAll('.mp-head .mp-card-actions button')].map(b => b.textContent.trim()),
          away: c.querySelector('.mp-head .mp-card-actions')?.classList.contains('away') ?? false,
          confirm: c.querySelector('.mp-confirm')?.querySelector('p')?.textContent.trim() ?? null,
          confirmActs: [...(c.querySelector('.mp-confirm')?.querySelectorAll('button') ?? [])].map(b => `${b.textContent.trim()}${b.classList.contains('danger') ? '!' : ''}`),
          alert: c.querySelector('[role="alert"]')?.textContent.trim() ?? null,
          text: c.textContent, code: c.querySelectorAll('code').length };
      }, cli);
      const setupError = () => page.evaluate(() => { const e = document.getElementById('setupError'); return e && !e.hidden ? e.textContent.trim() : ''; });

      await toggle(page, id);
      await recheck(page);
      await page.waitForSelector(`${cli} [data-act="logout"]`, { timeout: 15000 });
      let st = await cliState();
      check(st.acts.includes('ログアウト') && !st.warn && st.status.startsWith('公式'), `${id}: ログイン済みの CLI のログインに［ログアウト］が出る（Codex と同じ位置・名前）`, st);
      const accountCards = await page.evaluate(sel => [...document.querySelectorAll(`${sel} .conn-sec[data-sec="accounts"] .cc`)].map(c => [...c.querySelectorAll('.mp-card-actions button')].map(b => b.textContent.trim())), card(id));
      check(accountCards.every(a => !a.includes('ログアウト')), `${id}: 2 つ目以降のアカウントに［ログアウト］は足さない（［削除］のまま）`, accountCards);
      await shoot('s01');

      // ---- 確かめ: カードの中・文・［やめる］へ焦点・Esc で閉じる
      await page.locator(`${cli} [data-act="logout"]`).click();
      await page.waitForSelector(`${cli} .mp-confirm`, { timeout: 5000 });
      st = await cliState();
      check(st.confirm === 'Antigravity からログアウトしますか？この PC の Antigravity のアプリと、端末の agy もログアウトします。', `${id}: 押すとカードの中で確かめる（アプリと端末の agy も外れる）`, st.confirm);
      check(st.confirmActs.join() === 'やめる,ログアウト!', `${id}: 確かめのボタンは［やめる］と［ログアウト］（危ない操作の色）`, st.confirmActs);
      check(st.away, `${id}: 確かめている間はカードの操作を下げる（削除の確かめと同じ）`, st);
      check(await on(`${cli} .mp-confirm [data-confirm="no"]`), `${id}: 確かめを開くと［やめる］へ焦点が行く`);
      check(fs.existsSync(agyAuth), `${id}: 確かめの間はまだ外さない`);
      await shoot('s02');
      check(await on(`${cli} .mp-confirm [data-confirm="no"]`), `${id}: 描き直し（幅・テーマの切り替え）の後も確かめの中に焦点が残る`);
      await page.keyboard.press('Escape');
      await page.waitForSelector(`${cli} .mp-confirm`, { state: 'detached', timeout: 5000 });
      check(await on(`${cli} [data-act="logout"]`), `${id}: Esc で閉じると［ログアウト］へ焦点が戻る`);
      check(await page.locator(`${card(id)} .agent-conn`).isVisible(), `${id}: Esc は確かめだけを閉じる（接続先の一覧・設定は閉じない）`);
      await page.locator(`${cli} [data-act="logout"]`).click();
      await page.locator(`${cli} .mp-confirm [data-confirm="no"]`).click();
      await page.waitForSelector(`${cli} .mp-confirm`, { state: 'detached', timeout: 5000 });
      check(fs.existsSync(agyAuth) && (await cliState()).acts.includes('ログアウト'), `${id}: ［やめる］では外さない`);

      // ---- 失敗: 押したカードの中に赤の一文（#setupError には出さない）
      fs.writeFileSync(agyLogoutFail, 'keyring unavailable');
      await page.locator(`${cli} [data-act="logout"]`).click();
      await page.locator(`${cli} .mp-confirm [data-confirm="yes"]`).click();
      await page.waitForSelector(`${cli} [role="alert"]`, { timeout: 15000 });
      st = await cliState();
      check(st.alert === 'Antigravity のログアウトに失敗: agy がログアウトを受け付けませんでした', `${id}: 失敗は押したカードの中に出る（wire の生の文は出さない）`, st.alert);
      check(!(await setupError()), `${id}: 失敗を設定の上の欄（#setupError）には出さない`, await setupError());
      check(fs.existsSync(agyAuth) && st.acts.includes('ログアウト'), `${id}: 失敗したらログイン済みのまま`, st);
      check(await on(`${cli} [data-act="logout"]`), `${id}: 失敗したら［ログアウト］へ焦点が戻る`);
      await shoot('s05');
      fs.rmSync(agyLogoutFail, { force: true });

      // ---- 外す: 「⚠ ログインしていません」と［ログインする］
      await page.locator(`${cli} [data-act="logout"]`).click();
      await page.locator(`${cli} .mp-confirm [data-confirm="yes"]`).click();
      await page.waitForSelector(`${cli} [data-act="login"]`, { timeout: 15000 });
      st = await cliState();
      check(!fs.existsSync(agyAuth), `${id}: ［ログアウト］で agy の資格情報が消える（身代わり）`);
      check(st.status.includes('⚠ ログインしていません') && st.warn && st.acts.includes('ログインする') && !st.acts.includes('ログアウト'), `${id}: 外した後は「⚠ ログインしていません」と［ログインする］`, st);
      check(st.alert === null, `${id}: 前の失敗の一文は消える`, st.alert);
      check(await on(`${cli} [data-act="login"]`), `${id}: 外したら［ログインする］へ焦点が行く`);
      await shoot('s04');

      // ---- 入り直す: ブラウザーでのログイン（端末のコマンド・［コピー］は出さない）→ 済むとログイン済み
      await page.locator(`${cli} [data-act="login"]`).click();
      await page.waitForFunction(sel => document.querySelector(sel)?.textContent.includes('ブラウザーで Google にログインしてください'), card(id), { timeout: 10000 });
      const pending = await page.evaluate(sel => { const c = document.querySelector(sel); return { text: c.textContent, code: c.querySelectorAll('code').length, copy: [...c.querySelectorAll('button')].filter(b => b.textContent.trim() === 'コピー').length }; }, card(id));
      check(!/端末からしか|端末で実行/.test(pending.text) && pending.code === 0 && pending.copy === 0, `${id}: ログインを待つ間はブラウザーの案内だけ（端末のコマンド・［コピー］は出さない）`, pending);
      await shoot('s04-pending');
      await page.waitForSelector(`${cli} [data-act="logout"]`, { timeout: 30000 });
      st = await cliState();
      check(fs.existsSync(agyAuth) && !st.warn && st.acts.includes('ログアウト'), `${id}: ブラウザーでのログインが済むとログイン済みに戻る`, st);
    }]);
  }
  // Claude・Codex・Grok の［ログアウト］は確かめ無しのまま（すぐ外れる）。外した後は戻さないので、場面の最後に置く
  scenes.push(['claude・codex・grok: ［ログアウト］は確かめ無しのまま', async page => {
    for (const id of ['codex', 'grok', 'claude']) {
      await toggle(page, id);
      const cli = `${card(id)} [data-conn="cli"]`;
      await page.waitForSelector(`${cli} [data-act="logout"]`, { timeout: 15000 });
      await page.locator(`${cli} [data-act="logout"]`).click();
      await page.waitForTimeout(400);
      check(await page.locator(`${cli} .mp-confirm`).count() === 0, `${id}: 押しても確かめは出ない`);
      if (id !== 'claude') await page.waitForFunction(sel => !document.querySelector(`${sel} [data-act="logout"]`), cli, { timeout: 15000 }).catch(() => {});
      else await page.waitForTimeout(1500);
      const left = await page.evaluate(sel => ({ logout: document.querySelectorAll(`${sel} [data-act="logout"]`).length, alert: document.querySelector(`${sel} [role="alert"]`)?.textContent ?? null, status: document.querySelector(`${sel} .mp-ln`)?.textContent ?? '' }), cli);
      // 偽の Claude の CLI はログアウトしても状態を変えないので、Claude は失敗が出ないことだけを見る
      check(left.alert === null && (id === 'claude' || left.logout === 0), `${id}: すぐ外す（失敗は出ない${id === 'claude' ? '' : '・［ログアウト］が消える'}）`, left);
      await closeConn(page, id);
    }
  }]);
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
