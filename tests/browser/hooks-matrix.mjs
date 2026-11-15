// 設定 › プラグイン › Hooks（Hook × エージェントの表。ADR 0338）と会話の右の欄の Hooks を、本物のサーバーと画面で確かめる:
//   - タブ・件数・3 つのまとまり（Pleiad に登録／ユーザー／作業場所の 1 行）・担当の 2 択が無いこと
//   - 移行前（hooks-agents.json が無い）: 開いただけでは何も保存せず、説明（以前の「任せる」の登録がオフに見える理由）を出す。最初に押したときに保存する
//   - 鍵の吹き出し（Devin が Claude Code の設定から取り込む・作業場所の行に従う）と、行のスイッチの鍵
//   - 初めてほかのエージェントへ広げる確かめ（その場で 1 回・渡すときの注意の並び・やめる／実行する）
//   - 画面から押すと承認のカード無しで保存し、CLI（会話に束縛されない）からの同じ操作は断る
//   - 保存できないとき: 日本語の理由を下の固定の位置に出し、押したマスを元へ戻す
//   - キーボード（行のスイッチ・マス）とフォーカスの戻り先、行の詳細
//   - 読めない hooks-agents.json の理由と、ここから直す操作
//   - 会話の右の欄: 行ごとの「この場所で使うか」だけ（hooks.setPlace）
//   - 1280 / 360・ライト / ダークで横にはみ出さない。SHOT_DIR を渡すと撮る（hooks-agents-*.png）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

const results = [];
const check = (ok, label, detail) => {
  if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  results.push(label);
};

// 画面の文は辞書から引く（文を変えても試験の意味は変わらない）
const ja = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/locales/ja/ui.json'), 'utf8'));
const jaServer = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/locales/ja/server.json'), 'utf8'));
const T = (key, params = {}, dict = ja) => {
  const s = key.split('.').reduce((o, k) => o?.[k], dict);
  if (typeof s !== 'string') throw new Error(`辞書に無い: ${key}`);
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(params[k] ?? ''));
};

const shotDir = process.env.SHOT_DIR || '';
const shoot = async (page, name, locator = null) => {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  if (locator) await locator.screenshot({ path: path.join(shotDir, name) });
  else await page.screenshot({ path: path.join(shotDir, name), fullPage: false });
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-hooks-ui-'));
const home = path.join(dataDir, 'home');
const repo = path.join(dataDir, 'repo');
const store = path.join(dataDir, 'data');
const agentsFile = path.join(store, 'hooks-agents.json');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

let server, client, browser;
try {
  // 利用者の Claude Code の設定に 1 つ（Devin が取り込み、Grok も互換で読む）、作業場所に 1 つ
  write(path.join(home, '.claude/settings.json'), JSON.stringify({
    hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo hook-ok' }] }] },
  }));
  write(path.join(home, '.grok/auth.json'), JSON.stringify({ apiKey: 'test-key' }));
  const grokStub = path.join(dataDir, process.platform === 'win32' ? 'grok-stub.cmd' : 'grok-stub');
  write(grokStub, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') fs.chmodSync(grokStub, 0o755);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--quiet', repo]);
  write(path.join(repo, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo repo-stop' }] }] } }));

  const bins = Object.fromEntries(['CLAUDE', 'CODEX', 'AGY', 'OPENCODE', 'DEVIN', 'GROK'].map(n => [`AGENT_HOST_${n}_BIN`, path.join(dataDir, `no-such-${n.toLowerCase()}.exe`)]));
  server = await startServer({
    dataDir: store,
    env: {
      AGENT_HOST_BACKENDS: 'fake,claude,codex,antigravity,opencode,devin,grok',
      USERPROFILE: home, HOME: home,
      PLEIAD_SCAN_HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      AGENT_HOST_GROK_HOME: path.join(home, '.grok'),
      ...bins,
      AGENT_HOST_GROK_BIN: grokStub,
    },
  });
  client = await open({ ...server, autoAllow: true });
  await client.cmd('onboardingSeen');
  // 以前の担当は既定（エージェントに任せる）のまま、Pleiad に 1 つ登録する（移行前は、どのエージェントにも渡っていない）
  await client.cmd('savePlyHook', { value: { name: '保存の後に整える', agent: 'claude', event: 'PostToolUse', matcher: 'Edit', command: 'node fmt.js', targets: ['claude', 'codex'] } });
  const first = await client.cmd('hooksMatrix', { trust: false });
  const regKey = first.rows.find(r => r.kind === 'reg')?.key;
  const nativeKey = first.rows.find(r => r.kind === 'native' && r.group === 'own')?.key;
  check(first.adopted === false && regKey && nativeKey, '試験の置き場: 移行前で、登録の行と利用者の設定の行がある', { adopted: first.adopted, regKey, nativeKey });
  const managed = await client.cmd('newSession', { cwd: repo, backend: 'fake' });
  await client.runTurn({ ...managed, prompt: 'echo:Hooks の右の欄を確認' });

  browser = await chromium.launch({ executablePath: chromiumPath() });
  const errors = [];
  const baseUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;

  // 起動の直後は設定のボタンがまだ効かないことがあるので、タブが見えるまで押し直す（context-tabs-and-lock-tip と同じ）
  const openHooks = async (page, ready = `#cx-panel-hooks [data-key="${nativeKey}"]`) => {
    await page.waitForSelector('#settings', { state: 'attached', timeout: 15000 });
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => {
        document.getElementById('onboardingDialog')?.close();
        if (!document.body.classList.contains('settings')) document.getElementById('settings')?.click();
        document.getElementById('openContext')?.click();
        document.getElementById('cx-tab-hooks')?.click();
      });
      if (await page.waitForSelector(ready, { state: 'visible', timeout: 1500 }).then(() => true, () => false)) return;
    }
    throw new Error(`Hooks のタブが開かない: ${ready}`);
  };
  const rowOf = (page, key) => page.locator(`#cx-panel-hooks .cx-row[data-key="${key}"]`);
  const cellOf = (page, key, agent) => rowOf(page, key).locator(`.cx-ag[data-agent="${agent}"]`);
  const swOf = (page, key) => rowOf(page, key).locator('.cx-sw');
  const noOverflow = async page => page.evaluate(() => {
    const p = document.querySelector('#cx-panel-hooks');
    const doc = document.scrollingElement;
    const wide = [...p.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1 && e.getClientRects().length).map(e => e.className).slice(0, 5);
    return { ok: doc.scrollWidth <= window.innerWidth + 1 && wide.length === 0, sw: doc.scrollWidth, w: window.innerWidth, wide };
  });
  const cli = args => {
    const env = { ...process.env, AGENT_HOST_DATA: store, AGENT_HOST_LOCALE: 'ja' };
    delete env.PLEIAD_CONTROL_URL; delete env.PLEIAD_CONTROL_TOKEN;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/pleiad.mjs'), ...args], { env, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, err: r.stderr };
  };

  // ==================== 1. 1280・ライト: 設定 › プラグイン › Hooks ====================
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await openHooks(page);

    const tabCnt = await page.locator('#cx-tab-hooks .c').textContent();
    check(tabCnt === '1', 'Hooks のタブの件数は、どれかのエージェントで実行する Hook の数（作業場所のまとめの行は数えない）', tabCnt);
    const shape = await page.evaluate(({ regKey, nativeKey }) => {
      const p = document.querySelector('#cx-panel-hooks');
      return {
        seg: p.querySelectorAll('.cx-seg').length,
        blocks: p.querySelectorAll('.cx-block').length,
        reg: !!p.querySelector(`.cx-row[data-key="${regKey}"]`),
        regOff: p.querySelector(`.cx-row[data-key="${regKey}"]`)?.classList.contains('off'),
        native: !!p.querySelector(`.cx-row[data-key="${nativeKey}"]`),
        ws: p.querySelector('.cx-row[data-key="ws:hooks"] .nm')?.textContent ?? null,
        repoStop: p.textContent.includes('echo repo-stop'),
        adopt: p.querySelector('.hk-adopt')?.textContent ?? null,
        adoptOff: p.querySelector('.hk-adopt-off')?.textContent ?? null,
        legend: !!p.querySelector('.cx-legend'),
      };
    }, { regKey, nativeKey });
    check(shape.seg === 0 && shape.blocks === 2 && shape.reg && shape.regOff && shape.native && !shape.repoStop && shape.legend,
      'Hooks は「Pleiad に登録」と「エージェントの設定」の 2 つのまとまりで、担当の 2 択は無く、作業場所の定義は設定のページに並べない', shape);
    check(shape.ws === T('hooks.matrix.wsRow'), '作業場所は 1 行（.claude\\settings.json・.codex\\hooks.json）', shape.ws);
    check(shape.adopt === T('hooks.matrix.adopted') && shape.adoptOff === T('hooks.matrix.adoptedOff'),
      '移行前: 開いただけでは保存しないことと、以前の「任せる」の登録がオフに見える理由を出す', shape);
    check(!fs.existsSync(agentsFile), '移行前: ページを開いただけでは hooks-agents.json を書かない');

    // 読み上げ名と、セルの見え方
    const claudeCell = cellOf(page, nativeKey, 'claude');
    check(await claudeCell.getAttribute('aria-label') === T('hooks.matrix.runAria', { agent: 'Claude', name: 'echo hook-ok' })
      && await claudeCell.getAttribute('aria-pressed') === 'true',
      'マスの読み上げ名は「{エージェント} で {名前} を実行する」で、Claude はオン', await claudeCell.getAttribute('aria-label'));
    check(await rowOf(page, regKey).locator('button.cx-ag').count() === 0 && await rowOf(page, regKey).locator('.cx-ag.none[aria-hidden="true"]').count() === 6,
      '行がオフ（どのエージェントでも実行しない）の登録は、押せるマスを隠す（指示・Skills と同じ）');

    // 鍵: Devin のマスと行のスイッチ
    const devinCell = cellOf(page, nativeKey, 'devin');
    const devinTip = T('hooks.matrix.tip.devinImports', { agent: 'Devin' });
    check(await devinCell.getAttribute('aria-disabled') === 'true' && await devinCell.getAttribute('data-tip') === devinTip,
      'Devin のマスは鍵つきで、文は理由の細目（Claude Code の設定から取り込む）', await devinCell.getAttribute('data-tip'));
    await devinCell.hover();
    await page.waitForSelector('.cx-tip.on', { state: 'visible', timeout: 3000 });
    check((await page.locator('.cx-tip.on').innerText()) === devinTip, '鍵のマスへ載せると、吹き出しに理由が出る');
    await shoot(page, 'hooks-agents-lock.png', page.locator('#cx-panel-hooks'));
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => !document.querySelector('.cx-tip.on'), { timeout: 3000 });
    await page.waitForTimeout(400); // 吹き出しが消える動きの後に撮る
    const nativeSw = swOf(page, nativeKey);
    check(await nativeSw.getAttribute('aria-disabled') === 'true' && await nativeSw.getAttribute('data-tip') === devinTip,
      '鍵つきでオンのマスが残る行は、行のスイッチも鍵（同じ理由）', await nativeSw.getAttribute('data-tip'));
    const wsDevin = rowOf(page, 'ws:hooks').locator('.cx-ag[data-agent="opencode"]');
    check(await wsDevin.getAttribute('data-tip') === T('hooks.matrix.tip.noWorkspaceHooks', { agent: 'OpenCode' }),
      '作業場所の行の OpenCode は、作業場所の Hook を読まない理由の鍵', await wsDevin.getAttribute('data-tip'));
    // 押せるマスが無い（行がオフの）登録の行も、行のスイッチは同じ列にそろう
    const swX = await page.evaluate(keys => keys.map(k => Math.round(document.querySelector(`#cx-panel-hooks .cx-row[data-key="${k}"] .cx-sw`).getBoundingClientRect().left)), [regKey, nativeKey, 'ws:hooks']);
    check(new Set(swX).size === 1, '行がオフでマスの無い行も、行のスイッチは同じ列（汎用の .empty の余白を受けない）', swX);
    await shoot(page, 'hooks-agents-1280.png');

    // 初めてほかのエージェントへ広げる: その場で 1 回確かめ、注意を並べる
    await cellOf(page, nativeKey, 'codex').click();
    const ask = page.locator('#cx-panel-hooks .cx-ask');
    await ask.waitFor({ state: 'visible', timeout: 3000 });
    const askFacts = await ask.evaluate(el => ({
      q: el.querySelector('.q')?.textContent, warns: [...el.querySelectorAll('.hk-warns li')].map(li => li.textContent),
      prev: el.previousElementSibling?.dataset.key, focus: document.activeElement?.textContent, btns: [...el.querySelectorAll('button')].map(b => b.textContent),
    }));
    check(askFacts.q === T('hooks.matrix.ask', { from: 'Claude', to: 'Codex' }) && askFacts.prev === nativeKey
      && askFacts.btns.join('|') === `${T('context.matrix.cancel')}|${T('hooks.matrix.confirm')}` && askFacts.focus === T('hooks.matrix.confirm'),
      '確かめる帯は押した行のすぐ下に出て、「{出どころ} の設定の Hook を、{相手} でも実行します」［やめる］［実行する］・フォーカスは［実行する］', askFacts);
    check(askFacts.warns.length === 4 && askFacts.warns.every(s => s && !/\{\{|undefined/.test(s)),
      '渡すときの注意（Codex の 4 件）を帯の中に並べる', askFacts.warns);
    await shoot(page, 'hooks-agents-ask.png', page.locator('#cx-panel-hooks'));
    await ask.locator('button', { hasText: T('context.matrix.cancel') }).click();
    await page.waitForFunction(() => !document.querySelector('#cx-panel-hooks .cx-ask'), { timeout: 3000 });
    check(await cellOf(page, nativeKey, 'codex').getAttribute('aria-pressed') === 'false' && !fs.existsSync(agentsFile)
      && await page.evaluate(() => document.activeElement?.dataset.agent) === 'codex',
      '［やめる］で帯が消え、何も保存せず、押したマスへフォーカスが戻る');
    await cellOf(page, nativeKey, 'codex').click();
    await ask.waitFor({ state: 'visible', timeout: 3000 });
    await ask.locator('button', { hasText: T('hooks.matrix.confirm') }).click();
    await page.waitForFunction(k => document.querySelector(`#cx-panel-hooks .cx-row[data-key="${k}"] .cx-ag[data-agent="codex"]`)?.getAttribute('aria-pressed') === 'true', nativeKey, { timeout: 10000 });
    await page.waitForSelector('#cx-panel-hooks ~ .cx-toast.on, .cx-toast.on', { state: 'visible', timeout: 5000 }).catch(() => {});
    const afterAdopt = await client.cmd('hooksMatrix', { trust: false });
    check(fs.existsSync(agentsFile) && afterAdopt.adopted === true && afterAdopt.rows.find(r => r.key === nativeKey).cells.codex.state === 'on',
      '［実行する］で保存する。最初に押したときに移行し（hooks-agents.json）、承認のカードは出さない（画面から人が押した）');
    check(await page.locator('#cx-panel-hooks .hk-adopt').count() === 0, '移行した後は、移行前の説明を出さない');
    const toast = await page.locator('.cx-toast.on').first().textContent().catch(() => '');
    check(!!toast && !/err/.test(await page.locator('.cx-toast.on').first().getAttribute('class')), '保存したことを下の固定の位置に出す', toast);

    // CLI（会話に束縛されない）からの同じ向きの操作は、画面へ誘導して断る（guarded）
    const before = fs.readFileSync(agentsFile, 'utf8');
    const viaCli = cli(['call', 'hooks.setAgent', '--args', JSON.stringify({ key: nativeKey, agent: 'antigravity', on: true })]);
    check(viaCli.code === 4 && /画面/.test(viaCli.err) && fs.readFileSync(agentsFile, 'utf8') === before,
      'CLI からの Hook を広げる操作は断り（終了コード 4・画面へ誘導）、何も書かない', viaCli);

    // 保存できない: hooks-agents.json を読むだけにして、Codex を外す
    fs.chmodSync(agentsFile, 0o444);
    try {
      await cellOf(page, nativeKey, 'codex').click();
      await page.waitForSelector('.cx-toast.on.err', { state: 'visible', timeout: 10000 });
      const errText = await page.locator('.cx-toast.on.err').textContent();
      await page.waitForFunction(k => document.querySelector(`#cx-panel-hooks .cx-row[data-key="${k}"] .cx-ag[data-agent="codex"]`)?.getAttribute('aria-pressed') === 'true', nativeKey, { timeout: 10000 });
      check(errText.includes(T('plyHooks.write.denied', { file: 'hooks-agents.json' }, jaServer)) && !/EPERM|EACCES|operation not permitted/i.test(errText),
        '保存できないときは、日本語の理由（Node の生の誤りではない）を下の固定の位置に出す', errText);
      check(await cellOf(page, nativeKey, 'codex').getAttribute('aria-pressed') === 'true', '保存できなかったマスは元（オン）へ戻る');
      await shoot(page, 'hooks-agents-fail.png');
    } finally {
      fs.chmodSync(agentsFile, 0o644);
    }

    // キーボード: 登録の行のスイッチを Space で入れる（確かめの要らない Claude・Codex が入る）
    await swOf(page, regKey).focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(k => document.querySelector(`#cx-panel-hooks .cx-row[data-key="${k}"] .cx-sw`)?.getAttribute('aria-checked') === 'true', regKey, { timeout: 10000 });
    await page.waitForFunction(k => document.querySelector(`#cx-panel-hooks .cx-row[data-key="${k}"] button.cx-ag[data-agent="claude"]`), regKey, { timeout: 10000 });
    // 画面は先に見た目を変える。保存の後の読み直しを待ってから、サーバーの状態を見る
    let regOn = null;
    for (let i = 0; i < 40; i++) {
      regOn = (await client.cmd('hooksMatrix', { trust: false })).rows.find(r => r.key === regKey);
      if (regOn.on) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const regCells = Object.fromEntries(Object.entries(regOn.cells).map(([a, c]) => [a, c.state]));
    check(regOn.on === true && regCells.claude === 'on' && await page.evaluate(k => document.activeElement === document.querySelector(`#cx-panel-hooks .cx-row[data-key="${k}"] .cx-sw`), regKey),
      'キーボード: 行のスイッチを Space で入れると保存し、フォーカスは行のスイッチに残る', regCells);
    // マスを Enter で外す。ほかにオンのマスが残る間はフォーカスはマスに、最後のマスを外すと行が切れて行のスイッチへ
    const onAgents = Object.entries(regCells).filter(([, s]) => s === 'on').map(([a]) => a);
    for (const [i, a] of onAgents.entries()) {
      await cellOf(page, regKey, a).focus();
      await page.keyboard.press('Enter');
      const last = i === onAgents.length - 1;
      if (last) await page.waitForFunction(k => document.querySelector(`#cx-panel-hooks .cx-row[data-key="${k}"] .cx-sw`)?.getAttribute('aria-checked') === 'false', regKey, { timeout: 10000 });
      else await page.waitForFunction(([k, a]) => document.querySelector(`#cx-panel-hooks .cx-row[data-key="${k}"] .cx-ag[data-agent="${a}"]`)?.getAttribute('aria-pressed') === 'false', [regKey, a], { timeout: 10000 });
      await page.waitForFunction(() => !document.querySelector('.cx-busy, #contextPanel [aria-busy="true"]'), null, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(400);
      const where = await page.evaluate(() => document.activeElement?.dataset?.cxFk ?? document.activeElement?.className);
      check(where === (last ? `sw:${regKey}` : `ag:${regKey}:${a}`),
        last ? 'キーボード: 最後のマスを Enter で外すと行が切れ、フォーカスは行のスイッチへ移る（マスは隠れるため）' : `キーボード: ${a} のマスを Enter で外しても、フォーカスはそのマスに残る`, where);
    }

    // 行の詳細: 書いてある場所・動いているエージェント・変えられない理由
    await rowOf(page, nativeKey).locator('.cx-open').click();
    const facts = await page.locator('#cx-panel-hooks .hk-details .hk-facts').first().innerText();
    check(facts.includes(T('hooks.matrix.fact.where')) && facts.includes('settings.json') && facts.includes('Claude') && facts.includes(devinTip),
      '行を開くと、書いてある場所・動いているエージェント・変えられない理由を出す', facts);
    await rowOf(page, nativeKey).locator('.cx-open').click();
    check((await noOverflow(page)).ok, '1280: Hooks のタブは横にはみ出さない', await noOverflow(page));

    // 読めない hooks-agents.json: 理由と、ここから直す操作（指示・Skills と同じ置き方）
    const good = fs.readFileSync(agentsFile, 'utf8');
    fs.writeFileSync(agentsFile, '{ broken');
    await page.reload({ waitUntil: 'load' });
    await openHooks(page, '#cx-panel-hooks .hk-broken');
    const broken = await page.locator('#cx-panel-hooks .hk-broken').evaluate(el => ({ role: el.getAttribute('role'), text: el.textContent, btn: el.querySelector('button')?.textContent }));
    const cntHidden = await page.locator('#cx-tab-hooks .c').evaluate(c => c.hidden || !c.textContent);
    check(broken.role === 'alert' && broken.text.includes('hooks-agents.json') && broken.btn === T('context.repairDocAgents') && cntHidden && !/SyntaxError|Unexpected token/.test(broken.text),
      '読めない hooks-agents.json は、日本語の理由と［直す］を一覧の代わりに出し、件数を隠す', { broken, cntHidden });
    await shoot(page, 'hooks-agents-broken.png', page.locator('#cx-panel-hooks'));
    await page.locator('#cx-panel-hooks .hk-broken button').click();
    await page.waitForSelector(`#cx-panel-hooks [data-key="${nativeKey}"]`, { state: 'visible', timeout: 15000 });
    await page.waitForSelector('.cx-toast.on', { state: 'visible', timeout: 5000 });
    const repairedToast = await page.locator('.cx-toast.on').first().textContent();
    check(!fs.existsSync(agentsFile) && fs.readdirSync(store).some(f => /^hooks-agents\.broken-.+\.json$/.test(f))
      && await page.locator('#cx-panel-hooks .hk-adopt').count() === 1 && /hooks-agents\.broken-/.test(repairedToast),
      '［直す］で壊れたファイルを消さずに隣へ退避し（移行前の動きに戻る）、一覧と移行前の説明を出し、退避先を知らせる', { files: fs.readdirSync(store), repairedToast });
    fs.writeFileSync(agentsFile, good);
    await ctx.close();
  }

  // ==================== 2. 360・ライト: 横にはみ出さない・確かめる帯 ====================
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, colorScheme: 'light', locale: 'ja-JP', hasTouch: true });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await openHooks(page);
    const o1 = await noOverflow(page);
    check(o1.ok, '360: Hooks のタブは横にはみ出さない', o1);
    // WCAG 2.5.8: 24px 未満の的（共有の行のスイッチは高さ 20px）は、中心から 24px の円がほかの的と重ならなければよい
    const tight = await page.locator('#cx-panel-hooks .cx-ag:not([aria-hidden="true"]), #cx-panel-hooks .cx-sw').evaluateAll(els => {
      const rs = els.map(e => e.getBoundingClientRect()).filter(r => r.width);
      const c = r => [r.left + r.width / 2, r.top + r.height / 2];
      const out = [];
      rs.forEach((r, i) => {
        if (Math.min(r.width, r.height) >= 24) return;
        const [x, y] = c(r);
        for (const [j, o] of rs.entries()) {
          if (i === j) continue;
          const nx = Math.max(o.left, Math.min(x, o.right)), ny = Math.max(o.top, Math.min(y, o.bottom));
          if (Math.hypot(nx - x, ny - y) < 12) { out.push({ i, j, w: r.width, h: r.height }); break; }
        }
      });
      return out;
    });
    check(tight.length === 0, '360: 24px 未満の的（行のスイッチ）も、中心から半径 12px の中にほかの的が無い（WCAG 2.5.8 の間隔の例外）', tight);
    await shoot(page, 'hooks-agents-360.png');
    await cellOf(page, nativeKey, 'antigravity').click();
    await page.locator('#cx-panel-hooks .cx-ask').waitFor({ state: 'visible', timeout: 3000 });
    const o2 = await noOverflow(page);
    check(o2.ok && await page.locator('#cx-panel-hooks .cx-ask .hk-warns li').count() === 5, '360: 確かめる帯（Antigravity の注意 5 件）もはみ出さない', o2);
    await page.locator('#cx-panel-hooks .cx-ask').scrollIntoViewIfNeeded();
    await shoot(page, 'hooks-agents-360-ask.png');
    await page.locator('#cx-panel-hooks .cx-ask button', { hasText: T('context.matrix.cancel') }).click();
    await ctx.close();
  }

  // ==================== 3. 1280・ダーク ====================
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await openHooks(page);
    const dark = await page.evaluate(() => {
      const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
      const ink = getComputedStyle(document.querySelector('#cx-panel-hooks .cx-row .nm')).color.match(/\d+/g).map(Number);
      return { bg, ink, darkBg: bg.slice(0, 3).reduce((a, b) => a + b, 0) < 200, lightInk: ink.slice(0, 3).reduce((a, b) => a + b, 0) > 400 };
    });
    check(dark.darkBg && dark.lightInk, 'ダーク: 背景は暗く、行の名前は明るい文字', dark);
    check((await noOverflow(page)).ok, 'ダーク: 横にはみ出さない');
    await shoot(page, 'hooks-agents-dark.png');
    await cellOf(page, nativeKey, 'antigravity').click();
    await page.locator('#cx-panel-hooks .cx-ask').waitFor({ state: 'visible', timeout: 3000 });
    await shoot(page, 'hooks-agents-dark-ask.png', page.locator('#cx-panel-hooks'));
    await page.locator('#cx-panel-hooks .cx-ask button', { hasText: T('context.matrix.cancel') }).click();
    await ctx.close();
  }

  // ==================== 4. 会話の右の欄: 行ごとの「この場所で使うか」 ====================
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
    await page.waitForSelector(`[data-session="${managed.sessionId}"]`, { state: 'visible', timeout: 15000 });
    await page.locator(`[data-session="${managed.sessionId}"]`).first().click();
    await page.setViewportSize({ width: 700, height: 900 });
    await page.locator('#sessionMore').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#sessionMore').click();
    await page.getByRole('menuitem', { name: /プラグイン/ }).click();
    await page.waitForSelector('.file-preview-content .scx [data-act="placeStart"]', { state: 'visible', timeout: 15000 });
    await page.setViewportSize({ width: 1280, height: 900 });
    const normalText = await page.locator('.file-preview-content .scx').innerText();
    check(/Hooks/.test(normalText), '右の欄のふだんの面には、今までどおり Hooks の欄がある');
    await page.locator('.file-preview-content .scx [data-act="placeStart"]').click();
    await page.locator('#scx-tab-hooks').click();
    await page.waitForSelector('#scx-panel-hooks [data-row] .cx-sw', { state: 'visible', timeout: 15000 });
    const facts = await page.locator('#scx-panel-hooks [data-row]').evaluateAll(rows => rows.map(r => ({
      key: r.dataset.row, name: r.querySelector('.nm')?.textContent, sub: r.querySelector('.p')?.textContent,
      checked: r.querySelector('.cx-sw')?.getAttribute('aria-checked'), aria: r.querySelector('.cx-sw')?.getAttribute('aria-label'),
    })));
    const repoRow = facts.find(f => f.name === 'echo repo-stop');
    check(facts.length === 3 && repoRow && facts.every(f => f.checked === 'true') && !facts.some(f => f.key === 'ws:hooks')
      && await page.locator('#scx-panel-hooks .cx-seg, #scx-panel-hooks .cx-ags, #scx-panel-hooks .cx-ag').count() === 0,
      '右の欄の Hooks は、この場所の中身（登録・利用者・作業場所の定義）を行ごとに並べ、スイッチは「この場所で使うか」だけ（エージェントのマスは無い）', facts);
    check(repoRow.aria === T('sessionContext.hooks.placeSwitchAria', { name: 'echo repo-stop' }) && repoRow.sub.includes('Claude'),
      '右の欄の行の読み上げ名は「この場所で {名前} を使う」、下の段に実行するエージェント', repoRow);
    await shoot(page, 'hooks-agents-panel.png', page.locator('.file-preview-content .scx'));
    await page.locator(`#scx-panel-hooks [data-row="${repoRow.key}"] .cx-sw`).click();
    await page.waitForFunction(k => document.querySelector(`#scx-panel-hooks [data-row="${CSS.escape(k)}"] .cx-sw`)?.getAttribute('aria-checked') === 'false', repoRow.key, { timeout: 10000 });
    const placed = await client.cmd('hooksMatrix', { cwd: repo, trust: false });
    const placedRow = placed.rows.find(r => r.key === repoRow.key);
    const sub2 = await page.locator(`#scx-panel-hooks [data-row="${repoRow.key}"] .p`).textContent();
    check(placedRow.here.use === false && placed.rows.filter(r => r.here && r.key !== repoRow.key && r.kind !== 'ws').every(r => r.here.use === true)
      && sub2.includes(T('sessionContext.place.offHere')),
      '右の欄のスイッチは、その行だけをこの場所で使わない（hooks.setPlace）にし、下の段に「この場所では使わない」', { here: placedRow.here, sub2 });
    const settingsRow = (await client.cmd('hooksMatrix', { trust: false })).rows.find(r => r.key === repoRow.key);
    check(!settingsRow, '作業場所の定義は、設定のページの一覧には出ない（場所ごとの中身は右の欄だけ）');
    await page.locator(`#scx-panel-hooks [data-row="${repoRow.key}"] .cx-sw`).click();
    await page.waitForFunction(k => document.querySelector(`#scx-panel-hooks [data-row="${CSS.escape(k)}"] .cx-sw`)?.getAttribute('aria-checked') === 'true', repoRow.key, { timeout: 10000 });
    check((await client.cmd('hooksMatrix', { cwd: repo, trust: false })).rows.find(r => r.key === repoRow.key).here.use === true, '右の欄のスイッチを入れ直すと、この場所で使うに戻る');
    await ctx.close();
  }

  check(errors.length === 0, 'ページ例外（pageerror）が出ない', errors);
  console.log(`PASS: ${results.length} 判定すべて通過`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (client) client.close();
  if (server) await server.stop().catch(() => {});
  try { fs.chmodSync(agentsFile, 0o644); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
}
