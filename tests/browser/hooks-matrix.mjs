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
//   - Devin の取り込みが止まり始める操作（旧「そろえる」で Devin へ向けた登録の、実際の移行結果）: Devin のマス・Devin だけの行の行スイッチ・
//     右の欄の「この場所で使う」で、保存の前に確認の帯。やめるは何も保存せず、実行するで止まる（hooks-r3-*.png）
//   - 1280 / 360・ライト / ダークで横にはみ出さない。SHOT_DIR を渡すと撮る（hooks-agents-*.png）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { createPlyHooks } from '../../core/ply-hooks.mjs';
import { createHooksConfig } from '../../core/hooks-config.mjs';
import { createHooksAgents } from '../../core/hooks-agents.mjs';

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

  // サーバーの hooks.list の応答を使い、既存の登録と、追加した直後の登録を端まで操作する。
  const registeredCrud = async (page, phase, viaAdd, toggle = false) => {
    const name = `登録の操作 ${phase} ${viaAdd ? '追加' : '既存'}`;
    const original = `echo reg-${phase}-${viaAdd ? 'new' : 'old'}`;
    const edited = `${original}-edited`;
    const sheet = page.locator('dialog.hk-ply-sheet');
    const saveSheet = async () => {
      await sheet.getByRole('button', { name: T('hooks.unify.sheetReview'), exact: true }).click();
      await sheet.locator('.hk-confirm .hk-check input').check();
      await sheet.getByRole('button', { name: T('hooks.unify.save'), exact: true }).click();
      await sheet.waitFor({ state: 'detached' });
    };
    let key;
    if (viaAdd) {
      await page.locator('#cx-panel-hooks').getByRole('button', { name: T('hooks.add'), exact: true }).click();
      await sheet.waitFor({ state: 'visible' });
      await sheet.getByLabel(T('hooks.sheet.name'), { exact: true }).fill(name);
      await sheet.locator('select').nth(1).selectOption('Stop');
      await sheet.getByLabel(T('hooks.sheet.command'), { exact: true }).fill(original);
      await saveSheet();
      key = (await client.cmd('plyHooks')).hooks.find(h => h.name === name)?.id;
    } else {
      key = (await client.cmd('savePlyHook', { value: { name, agent: 'claude', event: 'Stop', matcher: '', command: original, targets: ['claude', 'codex'] } })).id;
      await page.reload({ waitUntil: 'load' });
      await openHooks(page);
    }
    const row = rowOf(page, key);
    await row.waitFor({ state: 'visible' });
    await row.locator('.cx-open').click();
    const detail = page.locator('#cx-panel-hooks .hk-details').filter({ has: page.locator('.hk-peek', { hasText: original }) });
    const peek = detail.locator('.hk-peek');
    await peek.waitFor({ state: 'visible', timeout: 5000 });
    check((await peek.innerText()).includes(original), `${phase}・${viaAdd ? '追加直後' : '既存'}: 登録の定義の箱が出る`);
    await peek.getByRole('button', { name: T('hooks.edit'), exact: true }).click();
    await sheet.waitFor({ state: 'visible' });
    check(await sheet.getByLabel(T('hooks.sheet.command'), { exact: true }).inputValue() === original, `${phase}: 編集シートに元のコマンドが入る`);
    await sheet.getByLabel(T('hooks.sheet.command'), { exact: true }).fill(edited);
    await saveSheet();
    await page.waitForFunction(({ key, edited }) => document.querySelector(`#cx-panel-hooks .cx-row[data-key="${key}"] .nm`)?.textContent === edited, { key, edited });
    check((await client.cmd('readPlyHook', { id: key })).command === edited, `${phase}: 編集したコマンドが保存されて行にも反映される`);
    check(fs.existsSync(agentsFile) === (phase !== 'before'), `${phase}: 追加・編集だけで移行状態を変えない`);
    if (toggle) {
      for (const on of [true, false, true]) {
        const current = (await client.cmd('hooksMatrix', { trust: false })).rows.find(r => r.key === key);
        if (current.on !== on) await swOf(page, key).click();
        // 登録の行は Claude・Codex だけが対象なので、オンは「一部オン（mixed）」に見える（全体のスイッチは role=checkbox の 3 状態。ADR 0337 §決定 4 の 2026-11-17 改訂）
        await page.waitForFunction(({ key, on }) => {
          const v = document.querySelector(`#cx-panel-hooks .cx-row[data-key="${key}"] .cx-sw`)?.getAttribute('aria-checked');
          return on ? (v === 'true' || v === 'mixed') : v === 'false';
        }, { key, on });
        // スイッチは先に見た目を変える。前の保存の通知ではなく、今回の保存と読み直しを待つ。
        let persisted = false;
        for (let i = 0; i < 100; i++) {
          persisted = (await client.cmd('hooksMatrix', { trust: false })).rows.find(r => r.key === key).on === on;
          if (persisted) break;
          await page.waitForTimeout(50);
        }
        await page.waitForFunction(() => !document.querySelector('#cx-panel-hooks .pending-label'));
        check(persisted, `${phase}: 登録の行を ${on ? 'オン' : 'オフ'} に保存できる`);
      }
      // Claude を外して off に残る選択も作り、削除後の残りを調べる。
      await cellOf(page, key, 'claude').click();
      await page.waitForFunction(({ key }) => document.querySelector(`#cx-panel-hooks .cx-row[data-key="${key}"] .cx-ag[data-agent="claude"]`)?.getAttribute('aria-pressed') === 'false'
        || document.querySelector(`#cx-panel-hooks .cx-row[data-key="${key}"]`)?.classList.contains('off'), { key });
      // 保存を待つ（表の楽観的な表示だけでは確認しない）。
      for (let i = 0; i < 100 && !JSON.parse(fs.readFileSync(agentsFile, 'utf8')).off[key]?.includes('claude'); i++) await page.waitForTimeout(50);
      check(JSON.parse(fs.readFileSync(agentsFile, 'utf8')).off[key]?.includes('claude'), `${phase}: 削除前にエージェントごとの off が保存されている`);
    }
    if (await row.locator('.cx-open').getAttribute('aria-expanded') !== 'true') await row.locator('.cx-open').click();
    const currentPeek = page.locator('#cx-panel-hooks .hk-peek').filter({ hasText: edited });
    await currentPeek.getByRole('button', { name: T('hooks.delete'), exact: true }).click();
    await currentPeek.locator('.hk-ask').getByRole('button', { name: T('hooks.confirm.delete'), exact: true }).click();
    await row.waitFor({ state: 'detached' });
    const matrix = await client.cmd('hooksMatrix', { trust: false });
    check(!(await client.cmd('plyHooks')).hooks.some(h => h.id === key) && !matrix.rows.some(r => r.key === key), `${phase}: 削除すると登録と表の行が消える`);
    if (toggle) {
      const state = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
      check(state.off[key]?.includes('claude') && !matrix.orphans.some(o => o.key === key), `${phase}: off の残りはあるが行も行き先不明の表示も作らない`);
    } else check(!fs.existsSync(agentsFile), 'before: 削除も移行前のまま完了する');
  };

  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await openHooks(page);
    await registeredCrud(page, 'before', false);
    await registeredCrud(page, 'before', true);
    await registeredCrud(page, 'before', false, true);
    check(fs.existsSync(agentsFile), 'before: 登録の行の最初のオンで移行できる');
    // 次の移行前の検査に戻す。削除済みの試験用登録の選択だけなので、本物の設定には触れない。
    fs.unlinkSync(agentsFile);
    await ctx.close();
  }

  // 事実と定義は同じ詳細の面で、見出しと値を別の列に組む。文字があるだけの検査では inline の崩れを見逃す。
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await openHooks(page);
    for (const width of [1280, 360]) for (const theme of ['light', 'dark']) {
      // 狭い幅では定義が縦に伸びる。編集・削除まで同じ撮影に収める。
      await page.setViewportSize({ width, height: width === 360 ? 1800 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      for (const [kind, key] of [['native', nativeKey], ['reg', regKey]]) {
        await rowOf(page, key).locator('.cx-open').click();
        const detail = page.locator('#cx-panel-hooks .hk-details');
        const facts = detail.locator(':scope > .hk-facts');
        await facts.scrollIntoViewIfNeeded();
        if (process.env.FACTS_BEFORE) await shoot(page, 'plugin-polish-facts-before.png');
        const layout = await facts.evaluate(fm => {
          const css = getComputedStyle(fm), parent = getComputedStyle(fm.parentElement);
          const pairs = [...fm.querySelectorAll('.k')].map(k => {
            const v = k.nextElementSibling, a = k.getBoundingClientRect(), b = v.getBoundingClientRect();
            return { kx: a.left, vx: b.left, kr: a.right, ky: a.top, vy: b.top };
          });
          const peek = fm.nextElementSibling;
          return { display: css.display, pairs, background: css.backgroundColor,
            radius: parseFloat(css.borderTopLeftRadius), padding: parseFloat(css.paddingLeft),
            gap: peek ? peek.getBoundingClientRect().top - fm.getBoundingClientRect().bottom : null,
            parentGap: parseFloat(parent.rowGap),
            sameLeft: !peek || Math.abs(peek.getBoundingClientRect().left - fm.getBoundingClientRect().left) < 1 };
        });
        check(layout.display === 'grid' && layout.pairs.length >= 2
          && layout.pairs.every(p => p.vx > p.kx && p.vx > p.kr && Math.abs(p.ky - p.vy) < 1)
          && layout.pairs.every(p => Math.abs(p.vx - layout.pairs[0].vx) < 1),
          `${width}・${theme}・${kind}: 事実の見出しと値はそろった別の列`, layout);
        const paper = await facts.evaluate(el => {
          const probe = document.createElement('span'); probe.style.background = 'var(--surface-paper)'; el.append(probe);
          const value = getComputedStyle(probe).backgroundColor; probe.remove(); return value;
        });
        check(layout.background === paper && layout.radius > 0 && layout.padding > 0
          && layout.gap >= 8 && layout.gap === layout.parentGap && layout.sameLeft,
          `${width}・${theme}・${kind}: 紙の面・角丸・余白と、定義までの間隔`, layout);
        check((await noOverflow(page)).ok, `${width}・${theme}・${kind}: 詳細が横にはみ出さない`, await noOverflow(page));
        await shoot(page, `plugin-polish-facts-${kind}-${width}-${theme}.png`);
        if (kind === 'reg') await shoot(page, `plugin-polish-reg-detail-${width}-${theme}.png`, detail);
        if (kind === 'native') {
          // 値だけを長い表示用の試験データに替える。保存・スキャン・行の組み立ては変えず、折り返しを検査する。
          await facts.evaluate(fm => {
            const values = fm.querySelectorAll('.v');
            values[0].textContent = '~/projects/' + 'long-directory-name-'.repeat(10) + '/.claude/settings.json';
            const reason = values[values.length - 1];
            reason.textContent = [reason.textContent, reason.textContent, reason.textContent].join(' / ');
          });
          const wraps = await facts.locator('.v').evaluateAll(values => values.every(v => v.scrollWidth <= v.clientWidth + 1));
          check(wraps && (await noOverflow(page)).ok, `${width}・${theme}: 長いパスと複数の理由も折り返す`, { wraps, ...await noOverflow(page) });
          await shoot(page, `plugin-polish-facts-long-${width}-${theme}.png`, facts);
        }
        await rowOf(page, key).locator('.cx-open').click();
      }
      // 作業場所は開閉のないまとめ行。詳細を開く動作をこの CSS の修正では足さない。
      const workspace = rowOf(page, 'ws:hooks');
      check(await workspace.locator('.cx-open').count() === 0, `${width}・${theme}: 作業場所は詳細を開かないまとめ行`);
      await workspace.scrollIntoViewIfNeeded();
      await shoot(page, `plugin-polish-facts-workspace-summary-${width}-${theme}.png`);
    }
    await ctx.close();
  }

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
        lead: (() => { const l = document.querySelector('#contextPanel .cx-lead'); return l ? { hidden: l.hidden, shown: l.getClientRects().length > 0 } : null; })(),
      };
    }, { regKey, nativeKey });
    check(shape.seg === 0 && shape.blocks === 2 && shape.reg && shape.regOff && shape.native && !shape.repoStop && shape.legend,
      'Hooks は「Pleiad に登録」と「エージェントの設定」の 2 つのまとまりで、担当の 2 択は無く、作業場所の定義は設定のページに並べない', shape);
    check(shape.ws === T('hooks.matrix.wsRow') && !shape.ws.includes('\\'), '作業場所は 1 行（.claude/settings.json と .codex/hooks.json。区切りは / で、OS で変えない）', shape.ws);
    check(shape.lead && shape.lead.hidden && !shape.lead.shown, 'Hooks のタブでは、プラグインの見出しの文（反映の時点は指示・Skills・外部 MCP の話）を出さない', shape.lead);
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
    // 鍵つきのオン（Devin）と変えられるオン（Claude）が混ざる行: 行のスイッチは押せる「一部オン」。押すと変えられる分だけまとめてオフ（ToBe-A′）
    const nativeSwFacts = await nativeSw.evaluate(el => ({ role: el.getAttribute('role'), checked: el.getAttribute('aria-checked'), disabled: el.getAttribute('aria-disabled'), label: el.getAttribute('aria-label'), lk: el.querySelectorAll('.lk').length }));
    check(nativeSwFacts.role === 'checkbox' && nativeSwFacts.checked === 'mixed' && nativeSwFacts.disabled === null
      && nativeSwFacts.label.includes(T('context.rowSwitch.next.off')) && nativeSwFacts.lk === 0,
      '鍵つきでオンのマスが残っても変えられるオンがある行は、行のスイッチは押せる「一部オン」（role=checkbox・押すと変えられる分をまとめてオフ・鍵は出さない）', nativeSwFacts);
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
    await page.waitForFunction(k => ['true', 'mixed'].includes(document.querySelector(`#cx-panel-hooks .cx-row[data-key="${k}"] .cx-sw`)?.getAttribute('aria-checked')), regKey, { timeout: 10000 });
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

  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await openHooks(page);
    await registeredCrud(page, 'after', false, true);
    await registeredCrud(page, 'after', true, true);
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

  // ==================== 5. Devin の取り込みが止まり始める操作（3 回目のレビューの必須） ====================
  // 旧「そろえる」で Devin へ向けた登録がある人の、実際の移行結果（試験の側で印を書かない）。どの入口でも、保存の前に確認の帯を出す:
  //   (1) 元の対象に Devin を含む行の Devin のマス (2) Devin だけの行の行スイッチ (3) 会話の右の欄の「この場所で使う」
  {
    await client.cmd('resetHooksAgents');
    await client.cmd('savePlyHook', { value: { name: 'both', agent: 'claude', event: 'Stop', command: 'node both.mjs', targets: ['claude', 'devin'] } });
    await client.cmd('savePlyHook', { value: { name: 'only', agent: 'claude', event: 'Stop', command: 'node only.mjs', targets: ['devin'] } });
    // 取り込みが止まるか（実行時と同じ物差し: core の devinImportsStopped）を、サーバーと同じ置き場から読むだけで確かめる
    const plyHooksR = createPlyHooks(store);
    // 担当（旧「そろえる」）は画面の確認の面からしか変えられないので、試験の置き場へ同じ core で書く（毎回ファイルから読むのでサーバーにも効く）
    await plyHooksR.setOwner({ place: null, value: { owner: 'ply', disabled: [] } });
    const haR = createHooksAgents({ dataDir: store, plyHooks: plyHooksR, findNode: async () => process.execPath, grokHome: path.join(home, '.grok'),
      hooksConfig: createHooksConfig({ home, claudeHome: path.join(home, '.claude'), codexHome: path.join(home, '.codex'), geminiHome: path.join(home, '.gemini'), claudeManaged: [] }) });
    const stoppedAt = cwd => haR.devinImportsStopped(cwd);
    const waitStopped = async (cwd, want) => { for (let i = 0; i < 40; i++) { if (await stoppedAt(cwd) === want) return true; await new Promise(r => setTimeout(r, 250)); } return false; };
    const m5 = await client.cmd('hooksMatrix', { trust: false });
    const bothKey = m5.rows.find(r => r.command === 'node both.mjs')?.key, onlyKey = m5.rows.find(r => r.command === 'node only.mjs')?.key;
    check(m5.adopted === false && m5.compat?.devin === 'off' && bothKey && onlyKey && !fs.existsSync(agentsFile) && await stoppedAt(repo) === false,
      '試験の置き場: 旧「そろえる」で Devin へ向けた登録が 2 つ（元の対象に Devin を含む行・Devin だけの行）ある移行前。取り込みは止まっていない', { adopted: m5.adopted, compat: m5.compat });

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await openHooks(page, `#cx-panel-hooks [data-key="${bothKey}"]`);
    const ask = page.locator('#cx-panel-hooks .cx-ask');
    const askFacts = () => ask.evaluate(el => ({ q: el.querySelector('.q')?.textContent, aria: el.getAttribute('aria-label'), warns: [...el.querySelectorAll('.hk-warns li')].map(li => li.textContent),
      prev: el.previousElementSibling?.dataset.key, focus: document.activeElement?.textContent }));

    // (1) 元の対象に Devin を含む行の Devin のマス
    await cellOf(page, bothKey, 'devin').click();
    await ask.waitFor({ state: 'visible', timeout: 3000 });
    const a1 = await askFacts();
    check(a1.q === T('hooks.matrix.askStop') && a1.aria === T('hooks.matrix.askStopAria', { name: 'node both.mjs' }) && a1.prev === bothKey
      && a1.warns.includes(T('hooks.warn.devinImportsStop')) && a1.focus === T('hooks.matrix.confirm'),
      '(1) 元の対象に Devin を含む行の Devin のマス: 保存の前に「Devin の取り込みが止まります」の帯（注意つき・フォーカスは［実行する］）', a1);
    await shoot(page, 'hooks-r3-cell.png', page.locator('#cx-panel-hooks'));
    check(!/read_config_from|--config/.test(await ask.innerText()), '日本語の確認の帯に設定名や起動引数を出さない');
    await shoot(page, 'plugin-polish-warning-ja.png');
    await page.evaluate(async () => {
      await (await import('./i18n.mjs')).setLanguage('en');
    });
    await ask.locator('button').first().click();
    await cellOf(page, bothKey, 'devin').click();
    await ask.waitFor({ state: 'visible' });
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/locales/en/ui.json'), 'utf8'));
    check((await askFacts()).q === T('hooks.matrix.askStop', {}, en) && !/read_config_from|--config/.test(await ask.innerText()), '英語の確認の帯も設定名や起動引数を出さない');
    await shoot(page, 'plugin-polish-warning-en.png');
    await page.evaluate(async () => { await (await import('./i18n.mjs')).setLanguage('ja'); });
    await ask.locator('button').first().click();
    await cellOf(page, bothKey, 'devin').click();
    await ask.waitFor({ state: 'visible' });
    await ask.locator('button', { hasText: T('context.matrix.cancel') }).click();
    await page.waitForFunction(() => !document.querySelector('#cx-panel-hooks .cx-ask'), { timeout: 3000 });
    await page.waitForTimeout(300);
    check(!fs.existsSync(agentsFile) && await cellOf(page, bothKey, 'devin').getAttribute('aria-pressed') === 'false' && await stoppedAt(repo) === false,
      '(1)［やめる］は何も保存しない（移行もしない）');
    await cellOf(page, bothKey, 'devin').click();
    await ask.waitFor({ state: 'visible', timeout: 3000 });
    await ask.locator('button', { hasText: T('hooks.matrix.confirm') }).click();
    check(await waitStopped(repo, true) && fs.existsSync(agentsFile), '(1)［実行する］で保存し、取り込みが止まる（devinImportsStopped が true）');
    await client.cmd('setHookAgent', { key: bothKey, agent: 'devin', on: false });
    check(await waitStopped(repo, false), 'Devin のマスを切ると取り込みが戻る（次の試しの前の状態）');

    // (2) Devin だけの行の行スイッチ
    await page.reload({ waitUntil: 'load' });
    await openHooks(page, `#cx-panel-hooks [data-key="${onlyKey}"]`);
    await swOf(page, onlyKey).click();
    await ask.waitFor({ state: 'visible', timeout: 3000 });
    const a2 = await askFacts();
    check(a2.q === T('hooks.matrix.askStop') && a2.aria === T('hooks.matrix.askStopAria', { name: 'node only.mjs' }) && a2.prev === onlyKey && a2.warns.includes(T('hooks.warn.devinImportsStop')),
      '(2) Devin だけの行の行スイッチ: 保存の前に同じ帯', a2);
    await shoot(page, 'hooks-r3-row.png', page.locator('#cx-panel-hooks'));
    const file2 = fs.readFileSync(agentsFile, 'utf8');
    await ask.locator('button', { hasText: T('context.matrix.cancel') }).click();
    await page.waitForFunction(() => !document.querySelector('#cx-panel-hooks .cx-ask'), { timeout: 3000 });
    await page.waitForTimeout(300);
    check(fs.readFileSync(agentsFile, 'utf8') === file2 && await swOf(page, onlyKey).getAttribute('aria-checked') === 'false' && await stoppedAt(repo) === false
      && await page.evaluate(k => document.activeElement?.dataset?.cxFk === `sw:${k}`, onlyKey),
      '(2)［やめる］は何も保存せず、行のスイッチへフォーカスが戻る');
    await swOf(page, onlyKey).click();
    await ask.waitFor({ state: 'visible', timeout: 3000 });
    await ask.locator('button', { hasText: T('hooks.matrix.confirm') }).click();
    check(await waitStopped(repo, true), '(2)［実行する］で保存し、取り込みが止まる');
    check((await noOverflow(page)).ok, '帯を出した後も横にはみ出さない');
    await ctx.close();

    // (3) 会話の右の欄の「この場所で使う」: この場所だけ外していた Devin の行を戻すと止まり始める
    await client.cmd('setHookPlace', { place: repo, key: onlyKey, use: false });
    check(await waitStopped(repo, false), '試験の置き場: この場所だけ Devin の行を使わない（この場所では止まっていない）');
    const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', locale: 'ja-JP' });
    const p3 = await ctx3.newPage();
    p3.on('pageerror', e => errors.push(e.message));
    await p3.goto(baseUrl, { waitUntil: 'load' });
    await p3.evaluate(() => document.getElementById('onboardingDialog')?.close());
    await p3.waitForSelector(`[data-session="${managed.sessionId}"]`, { state: 'visible', timeout: 15000 });
    await p3.locator(`[data-session="${managed.sessionId}"]`).first().click();
    await p3.setViewportSize({ width: 700, height: 900 });
    await p3.locator('#sessionMore').waitFor({ state: 'visible', timeout: 10000 });
    await p3.locator('#sessionMore').click();
    await p3.getByRole('menuitem', { name: /プラグイン/ }).click();
    await p3.waitForSelector('.file-preview-content .scx [data-act="placeStart"]', { state: 'visible', timeout: 15000 });
    await p3.setViewportSize({ width: 1280, height: 900 });
    await p3.locator('.file-preview-content .scx [data-act="placeStart"]').click();
    await p3.locator('#scx-tab-hooks').click();
    const placeSw = p3.locator(`#scx-panel-hooks [data-row="${onlyKey}"] .cx-sw`);
    await placeSw.waitFor({ state: 'visible', timeout: 15000 });
    const pAsk = p3.locator('#scx-panel-hooks .scx-hooks-ask');
    await placeSw.click();
    await pAsk.waitFor({ state: 'visible', timeout: 3000 });
    // フォーカスは次の描画（requestAnimationFrame）で［実行する］へ移る
    await p3.waitForFunction(() => document.activeElement?.closest?.('.scx-hooks-ask'), null, { timeout: 3000 }).catch(() => {});
    const a3 = await pAsk.evaluate(el => ({ q: el.querySelector('.q')?.textContent, warns: [...el.querySelectorAll('.hk-warns li')].map(li => li.textContent), focus: document.activeElement?.textContent }));
    check(a3.q === T('hooks.matrix.askStop') && a3.warns.includes(T('hooks.warn.devinImportsStop')) && a3.focus === T('hooks.matrix.confirm'),
      '(3) 右の欄の「この場所で使う」: 押すと取り込みが止まり始める行は、保存の前に同じ帯', a3);
    const file3 = fs.readFileSync(agentsFile, 'utf8');
    await pAsk.locator('button', { hasText: T('context.matrix.cancel') }).click();
    await p3.waitForFunction(() => !document.querySelector('#scx-panel-hooks .scx-hooks-ask'), { timeout: 3000 });
    await p3.waitForTimeout(300);
    check(fs.readFileSync(agentsFile, 'utf8') === file3 && await placeSw.getAttribute('aria-checked') === 'false' && await stoppedAt(repo) === false,
      '(3)［やめる］は何も保存しない');
    await placeSw.click();
    await pAsk.waitFor({ state: 'visible', timeout: 3000 });
    await pAsk.locator('button', { hasText: T('hooks.matrix.confirm') }).click();
    check(await waitStopped(repo, true), '(3)［実行する］で保存し、この場所で取り込みが止まる');
    await ctx3.close();
  }

  check(errors.length === 0, 'ページ例外（pageerror）が出ない', errors);
  console.log(`PASS: ${results.length} 判定すべて通過`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (client) client.close();
  if (server) await server.stop().catch(() => {});
  try { fs.chmodSync(agentsFile, 0o644); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
