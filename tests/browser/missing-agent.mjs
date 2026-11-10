// 使えるエージェントが無いときの知らせ（実ブラウザー。docs/desktop-onboarding.md「使えるエージェントが無いとき」・docs/design-system.md「エージェントの行」）:
//   起動時に 0 個 → 閉じられない案内（Esc・外のクリック）／歯車で設定へ行き、戻ると案内が戻る／SDK だけ先に済ませてからログインすると選べて、案内が自動で閉じる
//   確かめられない（未確認）だけのときは案内を出さない
//   使っている途中で 0 個になる → 会話の中の一覧が出て送信ボタンだけ無効（下書きは書ける）／直ると一覧が消えて送れる
//   エージェントの選択欄は使えないエージェントを選べない／送れなかった行から直して再送できる
// 実行: node tests/browser/missing-agent.mjs   （playwright-core は Windows の node の大域のもの。PW_CORE・PW_CHROMIUM で替えられる。MISSING_AGENT_ONLY=<場面名の一部> で絞る）
// 本物のサーバー（偽の Claude Code CLI・一時のデータ置き場・別ポート）だけと話す。LLM も実データも使わない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer, ROOT } from '../lib/server.mjs';
import { installFakeClaude } from '../lib/fake-claude.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const results = [];
const check = (ok, label, detail) => { if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); results.push(label); };
const SWITCH = fileURLToPath(new URL('../lib/fake-claude-switch.mjs', import.meta.url));
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'core/claude-sdk-pin.json'), 'utf8'));
const MISSING = 'D:/nonexistent/none.exe';

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

/** SDK を取り終えた形で置く（取得の本物は npm に出るので、置き場に偽の中身を置く。印と package.json が pin と合えば「取得済み」） */
function seedSdk(dataDir) {
  const dir = path.join(dataDir, 'claude-sdk', PIN.version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.pleiad-sdk.json'), JSON.stringify({ name: PIN.name, version: PIN.version, integrity: PIN.integrity, installedAt: Date.now() }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PIN.name, version: PIN.version, main: 'sdk.mjs' }));
  fs.writeFileSync(path.join(dir, 'sdk.mjs'), 'export {};\n');
  fs.writeFileSync(path.join(dataDir, 'claude-sdk', 'consent.json'), JSON.stringify({ acceptedAt: new Date().toISOString() }));
}
/** 偽の Antigravity CLI（`agy`。未ログイン: models が「Please sign in」で落ちる）を置き、AGENT_HOST_AGY_BIN に渡す値を返す */
function installFakeAgy(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const script = fileURLToPath(new URL('../lib/fake-agy-signin.mjs', import.meta.url));
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'agy.cmd');
    fs.writeFileSync(cmd, `@"${process.execPath}" "${script}" %*
`);
    return cmd;
  }
  const sh = path.join(dir, 'agy');
  fs.writeFileSync(sh, `#!/bin/sh
exec "${process.execPath}" "${script}" "$@"
`, { mode: 0o755 });
  return sh;
}
const unseedSdk = dataDir => fs.rmSync(path.join(dataDir, 'claude-sdk'), { recursive: true, force: true });

/**
 * Claude Code の行の、文字の左端（getBoundingClientRect().left）を全部読む。名前・説明・SDK の名前・規約の行は、ロゴの右の
 * 同じ位置から始まる（docs/design-system.md「エージェントの行」）。取得中・失敗の行は同じ親へ足して、実際の文脈の CSS で読む。
 * ロゴの無い文脈（送れなかった行）は、行の左端が基準
 */
async function leftEdges(page, scope) {
  return page.evaluate(async (scope) => {
    const m = await import('/agent-row.mjs');
    const rows = [...document.querySelectorAll(`${scope} [data-row="claude"]`)].filter(r => r.offsetParent);
    const row = rows[0];
    if (!row) return null;
    const agent = { id: 'claude', label: 'Claude Code', description: 'エージェントの説明', capabilities: {} };
    const logo = !row.classList.contains('nologo');
    const base = { supported: true, installed: true, loggedIn: true };
    const extra = [
      m.agentRow({ agent, desc: true, logo, on: {}, st: { ...base, sdk: { ready: false, fetching: { received: 1000, total: 4000 }, version: '0.3.288' } } }),
      m.agentRow({ agent, desc: true, logo, on: {}, st: { ...base, sdk: { ready: false, error: { kind: 'network', message: 'ネットワークに届かない' }, version: '0.3.288' } } }),
      m.agentRow({ agent, desc: true, logo, on: {}, termsUrl: 'https://example.com/terms', st: { ...base, sdk: { ready: false, version: '0.3.288' } } }),
    ];
    row.parentElement.append(...extra);
    const left = e => (e ? Math.round(e.getBoundingClientRect().left * 10) / 10 : null);
    const out = { name: left(row.querySelector('.arow-n')) ?? left(row.querySelector('.ar2-m')), desc: [], sdkName: [], terms: [], progress: [], failure: [] };
    for (const r of [row, ...extra]) {
      for (const d of r.querySelectorAll('.ar2-d')) out.desc.push(left(d));
      for (const n of r.querySelectorAll('.ar2-sn')) out.sdkName.push(left(n));
      for (const a of r.querySelectorAll('.ar2-d a')) out.terms.push(left(a));
    }
    out.progress = [...extra[0].querySelectorAll('.bar, .st')].map(left);
    out.failure = [...extra[1].querySelectorAll('.st')].map(left);
    out.retry = [...extra[1].querySelectorAll('button')].map(b => b.textContent.trim());
    extra.forEach(e => e.remove());
    return out;
  }, scope);
}
function checkEdges(e, where) {
  check(e !== null, `${where}: Claude Code の行がある`);
  const lines = [e.name, ...e.desc, ...e.sdkName, ...e.terms];
  check(e.terms.length >= 1 && e.sdkName.length >= 3, `${where}: 名前・説明・SDK の名前・規約の行が全部ある`, e);
  check(lines.every(x => x === e.name), `${where}: 名前・説明・SDK の名前・規約の左端が同じ（${e.name}）`, e);
  check(e.retry.includes('もう一度取得'), `${where}: 取得に失敗した行に［もう一度取得］がある`, e.retry);
  // 取得中の棒・失敗の理由は SDK の名前の行に続く（名前の右）。折り返したときの行頭も同じ左端になる
  check([...e.progress, ...e.failure].every(x => x >= e.name), `${where}: 取得中・失敗の表示は名前の左端より左へ出ない`, e);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-missing-agent-'));
let n = 0, browser;
const servers = [];
/** 場面ごとに別のサーバーとデータ置き場（done: 案内を一度終えた人。login: 最初からログイン済みか。sdk: 'local' | 'download'） */
async function scene({ done = true, login = false, sdk = 'download', backends = 'claude,codex', seed = false, env = {}, cwd = os.homedir(), init = null } = {}) {
  const dir = path.join(scratch, `s${++n}`);
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const flag = path.join(dir, 'login.flag');
  if (login) fs.writeFileSync(flag, '1');
  if (done) fs.writeFileSync(path.join(dataDir, 'onboarding.json'), JSON.stringify({ seen: true, setupComplete: true, backend: 'claude', cwd }));
  if (seed) seedSdk(dataDir);
  const fake = await installFakeClaude(path.join(dir, 'cli'), { cli: SWITCH });
  const server = await startServer({ dataDir, timeoutMs: 30_000, env: { AGENT_HOST_BACKENDS: backends, AGENT_HOST_LOCALE: 'ja', ...fake.env, FAKE_CLAUDE_LOGIN_FLAG: flag,
    AGENT_HOST_CLAUDE_SDK: sdk, AGENT_HOST_CODEX_BIN: MISSING, AGENT_HOST_AGY_BIN: MISSING, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), ...env } });
  servers.push(server);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  const errors = [];
  // 起動中にサイドバーの知らせの札（#sideUndo）へ出た字を全部控える（起動しただけで失敗の札が出ていないかを見る）
  await page.addInitScript(() => {
    window.__sideTexts = [];
    const watch = () => {
      const box = document.getElementById('sideUndo');
      if (!box) return false;
      new MutationObserver(() => { if (!box.hidden && box.textContent.trim()) window.__sideTexts.push(box.textContent.trim()); }).observe(box, { childList: true, attributes: true, subtree: true });
      return true;
    };
    if (!watch()) document.addEventListener('DOMContentLoaded', watch);
  });
  if (init) await page.addInitScript(init);
  await page.bringToFront();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
  return { page, errors, dataDir, flag, login: () => fs.writeFileSync(flag, '1'), logout: () => fs.rmSync(flag, { force: true }) };
}
const dialogOpen = page => page.evaluate(() => Boolean(document.getElementById('onboardingDialog')?.open));
const settingsOpen = page => page.evaluate(() => document.body.classList.contains('settings'));
const listShown = page => page.evaluate(() => { const e = document.getElementById('noAgent'); return Boolean(e && !e.hidden && e.offsetParent); });
const sendDisabled = page => page.evaluate(() => document.getElementById('send').disabled);
const backToChat = page => page.evaluate(() => document.getElementById('backToChat').click());
const recheckButton = (page, root) => page.locator(`${root} button:has-text("状態を再確認")`).first();

try {
  browser = await chromium.launch({ executablePath: chromiumPath() });
  const scenes = [];

  scenes.push(['起動時に 0 個: 閉じられない案内・歯車で設定へ・戻ると案内が戻る・SDK だけ先に済ませてからログインすると選べて自動で閉じる', async () => {
    const s = await scene({ login: false });
    const { page } = s;
    await page.waitForFunction(() => document.getElementById('onboardingDialog')?.open, null, { timeout: 20_000 });
    const title = await page.textContent('#onboardingTitle');
    check(/使えるエージェントがありません/.test(title), '見出し「使えるエージェントがありません」', title);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    check(await dialogOpen(page), 'Esc で閉じない');
    await page.mouse.click(4, 4);
    await page.waitForTimeout(300);
    check(await dialogOpen(page), '外のクリックで閉じない');
    await page.click('#onboardingGear');
    await page.waitForTimeout(600);
    check(!(await dialogOpen(page)), '歯車で案内が閉じる');
    check(await settingsOpen(page), '歯車で設定が開く');
    await backToChat(page);
    await page.waitForFunction(() => document.getElementById('onboardingDialog')?.open, null, { timeout: 10_000 });
    check(true, '設定から戻ると案内が戻る');
    // SDK だけ先に済ませる（ログインはまだ）→ まだ使えない
    seedSdk(s.dataDir);
    await recheckButton(page, '#onboardingDialog').click().catch(() => {});
    await page.waitForTimeout(2800);
    check(await dialogOpen(page), 'SDK だけでは案内が閉じない');
    // ログインを済ませる → 裏の確かめで見つかり、案内が自動で閉じる
    s.login();
    await page.waitForFunction(() => !document.getElementById('onboardingDialog')?.open, null, { timeout: 20_000 }).catch(async e => { throw new Error(`${e.message} ${JSON.stringify(await page.evaluate(() => ({ focus: document.hasFocus(), vis: document.visibilityState, list: document.getElementById('onboardingAgentList').innerText })))}`); });
    check(true, '使えるようになると案内が自動で閉じる');
    // 選択欄: 使える Claude は選べ、使えない Codex は選べない
    await page.click('#modelChip');
    await page.waitForTimeout(400);
    const opts = await page.evaluate(() => [...document.querySelectorAll('[data-key^="backend:"]')].map(o => ({ key: o.dataset.key, off: o.getAttribute('aria-disabled') === 'true' })));
    check(opts.some(o => o.key === 'backend:claude' && !o.off), '選択欄で Claude が選べる', opts);
    check(opts.some(o => o.key === 'backend:codex' && o.off), '選択欄で使えない Codex は選べない形', opts);
    const before = await page.textContent('#modelChip');
    await page.evaluate(() => document.querySelector('[data-key="backend:codex"]')?.click());
    await page.waitForTimeout(300);
    check((await page.textContent('#modelChip')) === before, '使えないエージェントを押しても切り替わらない', await page.textContent('#modelChip'));
    check(s.errors.length === 0, 'ページの例外が無い', s.errors);
  }]);

  scenes.push(['確かめられない（未確認）だけのときは案内を出さない', async () => {
    const s = await scene({ login: false, backends: 'claude,antigravity', env: { AGENT_HOST_AGY_BIN: installFakeAgy(path.join(scratch, 'agy-unconfirmed')) } });
    await s.page.waitForTimeout(3500);
    check(!(await dialogOpen(s.page)), '未確認が混ざる間は案内を出さない');
    check(s.errors.length === 0, 'ページの例外が無い', s.errors);
  }]);

  scenes.push(['使っている途中で 0 個: 会話の中の一覧・送信ボタンだけ無効・直ると送れる', async () => {
    const s = await scene({ login: true, sdk: 'local', backends: 'claude' });
    const { page } = s;
    await page.waitForSelector('#prompt', { timeout: 20_000 });
    await page.waitForTimeout(1500);
    check(!(await dialogOpen(page)) && !(await listShown(page)), '使えるうちは案内も一覧も出ない');
    s.logout();
    await page.click('#settings');
    await page.waitForSelector('#refreshAgents', { timeout: 10_000 });
    await page.click('#refreshAgents');
    await page.waitForTimeout(1500);
    await backToChat(page);
    await page.waitForFunction(() => { const e = document.getElementById('noAgent'); return e && !e.hidden && e.offsetParent; }, null, { timeout: 20_000 });
    check(!(await dialogOpen(page)), '使っている途中では案内（ダイアログ）を出さない');
    await page.click('#prompt');
    await page.keyboard.type('下書きは書ける');
    check((await page.textContent('#prompt')).includes('下書きは書ける'), '下書きは書ける');
    check(await sendDisabled(page), '一覧が出ている間は送信ボタンが無効');
    s.login();
    await recheckButton(page, '#noAgent').click();
    await page.waitForFunction(() => { const e = document.getElementById('noAgent'); return !e || e.hidden || !e.offsetParent; }, null, { timeout: 20_000 });
    check(true, '直ると一覧が消える');
    check(!(await sendDisabled(page)), '送信ボタンが使える');
    await page.click('#send');
    await page.waitForSelector('.m.user', { timeout: 20_000 });
    check(true, '直った後は送れる');
    check(s.errors.length === 0, 'ページの例外が無い', s.errors);
  }]);

  scenes.push(['送れなかった行: 原因を出し、直して再送すると送れる', async () => {
    // 画面が「使える」と思っている間に SDK が消え、送ると失敗する。失敗の行で状態を読み直し、SDK の行から取り直して（偽の置き場に戻す）再送する
    const s = await scene({ login: true, sdk: 'download', backends: 'claude', seed: true });
    const { page } = s;
    await page.waitForSelector('#prompt', { timeout: 20_000 });
    await page.waitForTimeout(1800);
    check(!(await dialogOpen(page)) && !(await listShown(page)), '使えるうちは案内も一覧も出ない');
    unseedSdk(s.dataDir);
    await page.click('#prompt');
    await page.keyboard.type('再送の確かめ');
    await page.click('#send');
    await page.waitForSelector('.outbox-fix, .outbox-status-failed', { timeout: 20_000 });
    await page.waitForSelector('.outbox-fix', { timeout: 20_000 });
    const text = await page.textContent('.outbox-fix');
    check(/送れませんでした/.test(text), '「送れませんでした」の見出し', text);
    check(/Claude Agent SDK/.test(text), '原因の一文に SDK が出る', text);
    check(await page.locator('.outbox-fix [data-fix="resend"]').count() === 0, 'SDK が無い間は［再送する］を出さない');
    // 直す（取得の本物は npm に出るので、置き場に偽の中身を戻す）→ 状態が変わり、［再送する］が出る
    seedSdk(s.dataDir);
    await page.evaluate(() => document.getElementById('settings')?.click());
    await page.waitForSelector('#refreshAgents', { timeout: 10_000 });
    await page.click('#refreshAgents');
    await page.waitForTimeout(1500);
    await backToChat(page);
    await page.waitForSelector('.outbox-fix [data-fix="resend"]', { timeout: 20_000 });
    check(true, '直ると［再送する］が出る');
    check(s.errors.length === 0, 'ページの例外が無い', s.errors);
  }]);

  scenes.push(['送れなかった行: ログインし直して［再送する］を押すと、同じ発言が送られる', async () => {
    const s = await scene({ login: true, sdk: 'local', backends: 'claude' });
    const { page } = s;
    await page.waitForSelector('#prompt', { timeout: 20_000 });
    await page.waitForTimeout(1500);
    s.logout();
    await page.click('#prompt');
    await page.keyboard.type('ログインし直して再送');
    await page.click('#send');
    await page.waitForSelector('.outbox-fix', { timeout: 30_000 }).catch(async e => { throw new Error(`${e.message} ${(await page.textContent('#thread')).slice(0, 600)}`); });
    const text = await page.textContent('.outbox-fix');
    check(/送れませんでした/.test(text) && /ログイン/.test(text), '原因（ログインが要る）が出る', text);
    check(await page.locator('.outbox-fix [data-fix="resend"]').count() === 0, 'ログインするまで［再送する］は出ない');
    s.login();
    await page.evaluate(() => document.getElementById('settings')?.click());
    await page.waitForSelector('#refreshAgents', { timeout: 10_000 });
    await page.click('#refreshAgents');
    await page.waitForTimeout(1500);
    await backToChat(page);
    await page.waitForSelector('.outbox-fix [data-fix="resend"]', { timeout: 20_000 });
    await page.click('.outbox-fix [data-fix="resend"]');
    await page.waitForFunction(() => !document.querySelector('.outbox-fix'), null, { timeout: 30_000 });
    check(true, '［再送する］で失敗の行が消える');
    await page.waitForFunction(() => document.querySelectorAll('.m.user').length >= 1 && [...document.querySelectorAll('.m.user')].some(e => e.textContent.includes('ログインし直して再送')), null, { timeout: 20_000 });
    check(true, '同じ発言が会話に残る');
    check(s.errors.length === 0, 'ページの例外が無い', s.errors);
  }]);

  scenes.push(['行の形: 期限切れ・リモートの窓・SDK を取り直している間', async () => {
    const s = await scene({ login: true, sdk: 'local', backends: 'claude' });
    const { page } = s;
    await page.waitForSelector('#prompt', { timeout: 20_000 });
    const rows = await page.evaluate(async () => {
      const m = await import('/agent-row.mjs');
      const agent = { id: 'claude', label: 'Claude Code', description: 'x', capabilities: {} };
      const base = { supported: true, installed: true, loggedIn: true, sdk: { ready: true, version: '0.3.288' } };
      const text = (st, remote = false) => { const r = m.agentRow({ agent, st, remote, on: {} }); return { text: r.innerText.split(/\s+/).join(' '), ops: [...r.querySelectorAll('button')].map(x => x.textContent.trim()) }; };
      return {
        expired: text({ ...base, expired: true }),
        remote: text({ ...base, loggedIn: false }, true),
        refetch: text({ ...base, sdk: { ready: false, fetching: { received: 1000, total: 4000 }, version: '0.3.288' } }),
      };
    });
    check(/ログインの有効期限が切れています/.test(rows.expired.text) && rows.expired.ops.includes('ログインし直す'), '期限切れの行: 文言と［ログインし直す］', rows.expired);
    check(/ホストの PC でログイン/.test(rows.remote.text) && rows.remote.ops.length === 0, 'リモートの窓の行: 「ホストの PC でログイン」で操作が無い', rows.remote);
    check(/取得しています/.test(rows.refetch.text), 'SDK を取り直している間の行: 「取得しています」', rows.refetch);
    check(s.errors.length === 0, 'ページの例外が無い', s.errors);
  }]);

  scenes.push(['起動しただけでは失敗の札を出さない（使えるものが 0 個でも 1 つ以上でも。覚えが無いときも）', async () => {
    for (const [label, opts] of [['0 個', { login: false, backends: 'claude,codex' }], ['1 個', { login: true, sdk: 'local', backends: 'claude,codex' }], ['初回・0 個・3 つ有効', { done: false, login: false, backends: 'claude,codex,antigravity' }], ['初回・1 個・3 つ有効', { done: false, login: true, sdk: 'local', backends: 'claude,codex,antigravity' }]]) {
      const s = await scene(opts);
      await s.page.waitForTimeout(4500);
      const texts = await s.page.evaluate(() => window.__sideTexts);
      check(!texts.some(x => /操作できませんでした|エージェントの指定/.test(x)), `起動しただけでは失敗の札が出ない（使えるもの ${label}）`, texts);
      check(s.errors.length === 0, 'ページの例外が無い', s.errors);
    }
  }]);

  scenes.push(['行の左端: 初回・出し直し・設定・会話の中の一覧・送れなかった行で、名前と下の行の左端が同じ', async () => {
    // 初回
    let s = await scene({ done: false, login: false, backends: 'claude,codex' });
    await s.page.waitForFunction(() => document.getElementById('onboardingDialog')?.open, null, { timeout: 20_000 });
    await s.page.waitForTimeout(1500);
    checkEdges(await leftEdges(s.page, '#onboardingDialog'), '初回の案内');
    check(s.errors.length === 0, 'ページの例外が無い', s.errors);
    // 出し直し
    s = await scene({ done: true, login: false, backends: 'claude,codex' });
    await s.page.waitForFunction(() => document.getElementById('onboardingDialog')?.open, null, { timeout: 20_000 });
    await s.page.waitForTimeout(1500);
    checkEdges(await leftEdges(s.page, '#onboardingDialog'), '出し直した案内');
    // 設定
    await s.page.click('#onboardingGear');
    await s.page.waitForSelector('#refreshAgents', { timeout: 10_000 });
    await s.page.waitForTimeout(800);
    checkEdges(await leftEdges(s.page, 'body.settings'), '設定のエージェント設定');
    // 会話の中の一覧
    s = await scene({ login: true, sdk: 'local', backends: 'claude' });
    await s.page.waitForSelector('#prompt', { timeout: 20_000 });
    await s.page.waitForTimeout(1500);
    s.logout();
    await s.page.click('#settings');
    await s.page.waitForSelector('#refreshAgents', { timeout: 10_000 });
    await s.page.click('#refreshAgents');
    await s.page.waitForTimeout(1500);
    await backToChat(s.page);
    await s.page.waitForFunction(() => { const e = document.getElementById('noAgent'); return e && !e.hidden && e.offsetParent; }, null, { timeout: 20_000 });
    checkEdges(await leftEdges(s.page, '#noAgent'), '会話の中の一覧');
    // 送れなかった行
    s = await scene({ login: true, sdk: 'download', backends: 'claude', seed: true });
    await s.page.waitForSelector('#prompt', { timeout: 20_000 });
    await s.page.waitForTimeout(1800);
    unseedSdk(s.dataDir);
    await s.page.click('#prompt');
    await s.page.keyboard.type('左端の確かめ');
    await s.page.click('#send');
    await s.page.waitForSelector('.outbox-fix [data-row="claude"]', { timeout: 20_000 });
    checkEdges(await leftEdges(s.page, '.outbox-fix'), '送れなかった行');
  }]);

  scenes.push(['ログインの途中: 2 秒ごとの確かめ直しで「待っている」が戻らない（URL の欄・［やめる］が残り、二重に始められない）', async () => {
    // Antigravity は、サーバーが pending を返さない（ログインは端末で行い、Pleiad は見張るだけ）
    const s = await scene({ login: true, sdk: 'local', backends: 'claude,antigravity', env: { AGENT_HOST_AGY_BIN: installFakeAgy(path.join(scratch, 'agy-login')) } });
    const { page } = s;
    await page.waitForSelector('#prompt', { timeout: 20_000 });
    await page.evaluate(() => document.getElementById('railSettings').click());
    const card = page.locator('#authSec [data-agent="antigravity"]');
    await card.locator('button:has-text("状態を確認")').click();
    await card.locator('button:has-text("ログイン")').first().waitFor({ timeout: 10_000 });
    await card.locator('button:has-text("ログイン")').first().click();
    await card.locator('button:has-text("やめる")').waitFor({ timeout: 10_000 });
    // 確かめ直しは 2 秒ごと。三回り（6 秒）たっても、待っている表示のまま
    await page.waitForTimeout(6000);
    const text = await card.innerText();
    check(/ログインを待っている/.test(text), 'ログインの途中: 6 秒たっても「待っている」のまま', text);
    check(await card.locator('button:has-text("やめる")').count() === 1, '［やめる］が残っている');
    check(await card.getByRole('button', { name: 'ログイン', exact: true }).count() === 0, '［ログイン］に戻らない（二重に始められない）');
    check(await card.locator('.copy, button:has-text("コピー")').count() >= 1, 'URL（端末で打つコマンド）の欄が残っている');
    await card.locator('button:has-text("やめる")').click();
    await card.getByRole('button', { name: 'ログイン', exact: true }).waitFor({ timeout: 10_000 });
    check(!/ログインを待っている/.test(await card.innerText()), 'やめると未ログインに戻る');
    check(s.errors.length === 0, 'ページの例外が無い', s.errors);
  }]);

  scenes.push(['0 個でも、窓も一覧も理由を見せていないとき（「たぶん」が混ざる）は、会話を作れなかった知らせを出す', async () => {
    // Claude は未ログイン（使えない）、Antigravity は確かめられない（たぶん）。窓も一覧も出ないので、札が唯一の知らせになる。
    // 会話を作る呼び出しは、サーバーが断る（知らないエージェントの指定に差し替える）
    const s = await scene({ login: false, sdk: 'local', backends: 'claude,antigravity', env: { AGENT_HOST_AGY_BIN: installFakeAgy(path.join(scratch, 'agy-maybe')) } });
    const { page } = s;
    await page.waitForSelector('#prompt', { timeout: 20_000 });
    await page.waitForTimeout(2500);
    check(!(await dialogOpen(page)) && !(await listShown(page)), '窓も一覧も出ていない');
    await page.evaluate(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (m) { try { const o = JSON.parse(m); if (o.command === 'newSession') return send.call(this, JSON.stringify({ ...o, args: { ...o.args, backend: 'no-such-agent' } })); } catch { /* 文字でない */ } return send.call(this, m); };
    });
    await page.click('#prompt');
    await page.keyboard.press('Control+Shift+O');   // 新しい会話（ページの中のショートカット）
    await page.waitForFunction(() => { const b = document.getElementById('sideUndo'); return b && !b.hidden && /操作できませんでした/.test(b.textContent); }, null, { timeout: 15_000 });
    check(true, '会話を作れなかった知らせの札が出る');
  }]);

  scenes.push(['裏の確かめ直し: 使えると分かっているエージェントの CLI は起こさない・ほかの設定のページでは走らない・使えるようになったのは 5 秒以内に見つける', async () => {
    const count = path.join(scratch, 'count.log');
    const read = () => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').split('\n').filter(l => l.startsWith('auth')).length : 0);
    // ログイン済みの Claude（使える）だけ。エージェントの設定のページを開いて 10 秒おく
    let s = await scene({ login: true, sdk: 'local', backends: 'claude', env: { FAKE_CLAUDE_COUNT_FILE: count } });
    await s.page.waitForSelector('#prompt', { timeout: 20_000 });
    await s.page.evaluate(() => document.getElementById('railSettings').click());
    await s.page.waitForSelector('#authSec', { state: 'visible', timeout: 10_000 });
    await s.page.waitForTimeout(1500);
    const base = read();
    await s.page.waitForTimeout(10_000);
    check(read() === base, '使えると分かっている Claude の CLI を、裏の確かめ直しは起こさない', { base, now: read() });
    // 未ログインの Claude: 設定の別のページでは起こさず、エージェント設定のページでは 4 秒おきに起こす
    fs.rmSync(count, { force: true });
    s = await scene({ login: false, sdk: 'local', backends: 'claude,codex', env: { FAKE_CLAUDE_COUNT_FILE: count } });
    await s.page.waitForSelector('#prompt', { timeout: 20_000 });
    await s.page.waitForTimeout(1500);
    await s.page.evaluate(() => { document.getElementById('onboardingGear')?.click(); });
    await s.page.waitForTimeout(500);
    await s.page.evaluate(() => document.getElementById('appearanceTab').click());
    await s.page.waitForTimeout(500);
    const b2 = read();
    await s.page.waitForTimeout(9000);
    check(read() === b2, '外観のページを見ている間は、確かめ直しが CLI を起こさない', { b2, now: read() });
    await s.page.evaluate(() => document.getElementById('setupTab').click());
    await s.page.waitForSelector('#authSec', { state: 'visible', timeout: 10_000 });
    const b3 = read();
    await s.page.waitForTimeout(9000);
    const n = read() - b3;
    check(n >= 2 && n <= 3, 'エージェント設定のページでは 4 秒おき（9 秒で 2〜3 回）', n);
    // ログインしたら 5 秒以内に見つける
    s.login();
    const t0 = Date.now();
    await s.page.waitForFunction(() => /ログイン中|ログイン済み/.test(document.querySelector('#authSec [data-agent="claude"]')?.innerText ?? ''), null, { timeout: 8000 }).catch(() => {});
    const took = Date.now() - t0;
    check(took <= 5000, 'ログインしたのを 5 秒以内に見つける', took);
  }]);

  scenes.push(['リモートの窓（ホストにつないだ側）: 閉じられない窓は出さず、会話の中の一覧が「ホストの PC でログイン」を出す・歯車で設定へ行ける', async () => {
    const s = await scene({ login: false, sdk: 'local', backends: 'claude', init: () => { window.plyRemote = { shell: 'desktop' }; } });
    const { page } = s;
    await page.waitForSelector('#prompt', { timeout: 20_000 });
    await page.waitForTimeout(3000);
    check(!(await dialogOpen(page)), 'リモートの窓には閉じられない窓を出さない');
    check(await listShown(page), '会話の中の一覧が出る');
    const text = await page.innerText('#noAgent');
    check(text.includes('ホストの PC でログイン'), '一覧の行が「ホストの PC でログイン」を案内する', text);
    check(await page.locator('#noAgent button:has-text("ログイン")').count() === 0, 'この窓からログインを始めるボタンは出ない');
    check(await sendDisabled(page), '送信ボタンは押せない');
    await page.evaluate(() => document.getElementById('railSettings').click());
    check(await settingsOpen(page), '設定へ行ける（過去の会話・設定は塞がれない）');
    check(s.errors.length === 0, 'ページの例外が無い', s.errors);
  }]);

  scenes.push(['閉じられない窓が出ている間も、窓（ページ）は閉じられる（アプリの終了を止めない）', async () => {
    // デスクトップ版の終了（閉じる・メニュー・トレイ・Alt+F4）は main プロセスの close / before-quit が受け持ち、ページの中身に聞かない（desktop/main.cjs）。
    // ページ側は、終了の確認（beforeunload）を持たず、モーダルが窓を閉じるのを止めないことだけを確かめる
    const s = await scene({ done: false, login: false, backends: 'claude,codex' });
    await s.page.waitForSelector('#prompt', { timeout: 20_000 });
    await s.page.waitForTimeout(1500);
    check(await dialogOpen(s.page), '閉じられない窓が出ている');
    const before = await s.page.evaluate(() => ({ hasHandler: typeof window.onbeforeunload === 'function' }));
    check(!before.hasHandler, 'ページは beforeunload の止め方を持たない');
    const closed = new Promise(res => s.page.once('close', () => res(true)));
    await s.page.close({ runBeforeUnload: true });
    check(await Promise.race([closed, new Promise(res => setTimeout(() => res(false), 5000))]), '窓が出たままでもページは閉じる');
  }]);

  const only = process.env.MISSING_AGENT_ONLY;
  let failed = 0;
  for (const [name, fn] of scenes) {
    if (only && !name.includes(only)) continue;
    try { await fn(); console.log(`ok: ${name}`); } catch (e) { failed++; console.log(`FAIL: ${name}\n  ${e.message}
  （直前に通った確認: ${results.at(-1) ?? 'なし'}）`); }
  }
  console.log(`${results.length} checks, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  await browser?.close();
  for (const s of servers) { try { s.stop?.() ?? s.kill?.(); } catch { /* 終わっている */ } }
}
