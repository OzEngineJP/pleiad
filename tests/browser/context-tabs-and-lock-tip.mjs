// 設定 › プラグインと会話の右パネル（段 2）のブラウザ統合テスト:
//   - 4 タブ・件数・スクロール追従（sticky）・タブ切替時の先頭戻しと記憶・キーボード操作
//   - 指示・Skills・Hooks は「名前 × 6 エージェント」一覧、担当 2 択と「探す形式」は無し（段 3 で Hooks も表になった）
//   - Pleiad の指示（Grok 押下可 + 委譲と連動は linked 鍵）、作業場所 summaryRow、量の目安の折りたたみ
//   - 他エージェントへ広げる前の行内確認（.cx-ask）、鍵の吹き出し（own / workspace / relay / nolinks）、リロード永続化
//   - フォルダーまとまり（>8 折りたたみ・展開後の親ロゴ/パス非重複・mixed 一括切替）
//   - Skills 絞り込み（入力フォーカス維持・自動展開・0 件表示・Escape 解除）
//   - 会話の右パネル編集（行スイッチのみ・エージェント列/担当 2 択なし）・1280 / 360・ライト / ダークで横はみ出し無し・押し先サイズ確保
//   - Devin の自分の名前（ADR 0336）: 一覧の Devin のアイコンを off → 読み込み直しても off → on に戻す・
//     リンクを作れない PC の鍵（nolinks）・会話の右パネルの止められなかった行の鍵（workspace）。偽の Devin（tests/lib/fake-devin.mjs）と別の置き場で
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-cxtabs-ui-'));
const home = path.join(dataDir, 'home');
const repo = path.join(dataDir, 'repo');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const shotDir = process.env.SHOT_DIR || '';
const shoot = async (page, name) => {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, name), fullPage: false });
};

let server, client, browser, lkServer, lkClient;
try {
  // ユーザー側（設定 › プラグインで表示）: CLAUDE.md + GEMINI.md + 9 rules（探す場所に足した ~/team-rules）+ 9 .codex/skills + 2 .agents/skills + MCP + Hook
  // 押して切り替える rules・Skills は、Devin・Grok が自分で読まない置き場に置く（鍵つきのオンが無い行は、まとまりのスイッチが「全部オン／オフ」になって試しやすい）。
  // .claude/ などエージェントの置き場の物は Devin か Grok のマスが鍵つきでオンなので、行のスイッチは変えられるオンだけをまとめてオフにし、
  // 鍵つきのオンが残る（横棒＋鍵。ADR 0337 §決定 4 の 2026-11-17 改訂）。rules はどの置き場も Devin か Grok が読むので、探す場所に足したフォルダーに置く
  const teamRoot = path.join(home, 'team-rules');
  write(path.join(home, '.claude/CLAUDE.md'), '# User Instructions\nAlways be concise.\n');
  write(path.join(home, '.gemini/GEMINI.md'), '# Gemini User Instructions\nExplain briefly.\n');
  for (let i = 0; i < 9; i++) {
    write(path.join(teamRoot, `.claude/rules/sec/rule-${i}.md`), `# Security rule ${i}\nCheck input ${i}.\n`);
  }
  for (let i = 0; i < 9; i++) {
    write(path.join(home, `.codex/skills/u-skill-${i}/SKILL.md`), `---\nname: u-skill-${i}\ndescription: User skill ${i}\n---\n# u-skill-${i}\n`);
  }
  for (const name of ['extra-a', 'extra-b']) {
    write(path.join(home, `.agents/skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: Agent skill ${name}\n---\n# ${name}\n`);
  }
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { clOnly: { command: 'cl-cmd' }, both: { command: 'both-cmd' } } }));
  write(path.join(home, '.codex/config.toml'), '[mcp_servers.cxOnly]\nurl = "https://example.invalid/mcp"\n[mcp_servers.both]\ncommand = "both-cmd"\n');
  write(path.join(home, '.claude/settings.json'), JSON.stringify({
    hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo hook-ok' }] }] },
  }));
  write(path.join(home, '.grok/auth.json'), JSON.stringify({ apiKey: 'test-key' }));
  const grokStub = path.join(dataDir, process.platform === 'win32' ? 'grok-stub.cmd' : 'grok-stub');
  write(grokStub, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') fs.chmodSync(grokStub, 0o755);

  // リポジトリ側（会話の右パネルで表示）: AGENTS.md + 9 rules（.claude/rules。Devin・Grok の鍵つきのオンが残るので、行のスイッチは変えられるオンだけを外す）+ 9 .codex/skills + .mcp.json
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--quiet', repo]);
  write(path.join(repo, 'AGENTS.md'), '# Repo Instructions\nFollow test rules.\n');
  for (let i = 0; i < 9; i++) {
    write(path.join(repo, `.claude/rules/arch/r-${i}.md`), `# Arch rule ${i}\nLayering ${i}.\n`);
  }
  for (let i = 0; i < 9; i++) {
    write(path.join(repo, `.codex/skills/r-skill-${i}/SKILL.md`), `---\nname: r-skill-${i}\ndescription: Repo skill ${i}\n---\n# r-skill-${i}\n`);
  }
  write(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { repoMcp: { command: 'repo-cmd' } } }));

  const bins = Object.fromEntries(['CLAUDE', 'CODEX', 'AGY', 'OPENCODE', 'DEVIN', 'GROK'].map(n => [`AGENT_HOST_${n}_BIN`, path.join(dataDir, `no-such-${n.toLowerCase()}.exe`)]));
  server = await startServer({
    dataDir: path.join(dataDir, 'data'),
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
  await client.cmd('setContextSettings', { place: null, kind: 'instruction', roots: [teamRoot] });
  await client.cmd('savePlyMcp', { name: 'reg', mode: 'add', value: { transport: 'stdio', command: 'reg-cmd', args: [] } });
  const tier = { sources: ['common', 'claude', 'codex', 'antigravity'], excludePaths: [] };
  for (const kind of ['instruction', 'skill']) {
    await client.cmd('setContextSettings', { cwd: repo, place: null, kind, value: { owner: 'native', user: tier, directory: tier } });
  }
  // 探す場所に足したフォルダーの物は、どのエージェントも自分では読まないので、既定ではどこにも渡らない（件数に数えない）。
  // 利用者が Claude へ広げた状態にしておく（Claude のマスは鍵が無いので、行のスイッチを押せる）
  {
    const m = await client.cmd('docMatrix', { kind: 'instruction', cwd: home, place: null });
    const teamKeys = m.rows.filter(r => String(r.path ?? r.key).replace(/\\/g, '/').includes('/team-rules/')).map(r => r.key);
    if (teamKeys.length !== 9) throw new Error(`探す場所に足した rules が 9 件見つからない: ${teamKeys.length}`);
    for (const key of teamKeys) await client.cmd('setDocAgent', { kind: 'instruction', key, agent: 'claude', on: true, cwd: home, place: null });
  }
  const managed = await client.cmd('newSession', { cwd: repo, backend: 'fake' });
  await client.runTurn({ ...managed, prompt: 'echo:プラグイン画面を確認' });
  await client.cmd('setContextSettings', { cwd: repo, place: repo, kind: 'mcp', value: { owner: 'ply', user: tier, directory: tier } });

  browser = await chromium.launch({ executablePath: chromiumPath() });
  const errors = [];
  const baseUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;

  async function openSettingsContext(page, tabId) {
    await page.waitForSelector('#settings', { state: 'attached', timeout: 15000 });
    for (let i = 0; i < 10; i++) {
      await page.evaluate(tid => {
        document.getElementById('onboardingDialog')?.close();
        if (!document.body.classList.contains('settings')) document.getElementById('settings')?.click();
        document.getElementById('openContext')?.click();
        if (tid) document.getElementById(`cx-tab-${tid}`)?.click();
      }, tabId ?? null);
      const ready = await page.waitForFunction(() => {
        const tab = document.querySelector('#contextPanel .cx-tabs [role="tab"]');
        const r = tab?.getBoundingClientRect();
        // 指示・Skills・外部 MCP の件数がそろうまで待つ（探索・外部 MCP は遅れて届く。Hooks の件数は下で別に確かめる）
        const counted = ['instruction', 'skill', 'mcp'].every(id => {
          const cnt = document.querySelector(`#cx-tab-${id} .c`);
          return cnt && !cnt.hidden && Number(cnt.textContent) > 0;
        });
        return document.body.classList.contains('settings') && r && r.height > 0 && counted;
      }, null, { timeout: 1500 }).then(() => true, () => false);
      if (ready) return;
    }
    const diag = await page.evaluate(() => ({
      settingsCls: document.body.classList.contains('settings'),
      status: document.querySelector('#contextPanel .cx-status')?.textContent ?? '',
      tabs: [...document.querySelectorAll('#contextPanel .cx-tabs [role="tab"]')].map(e => ({ id: e.id, cnt: e.querySelector('.c')?.textContent, hidden: e.querySelector('.c')?.hidden })),
      instEmpty: document.querySelector('#cx-panel-instruction .cx-empty')?.textContent ?? '',
      skillEmpty: document.querySelector('#cx-panel-skill .cx-empty')?.textContent ?? '',
      mcpEmpty: document.querySelector('#cx-panel-mcp .cx-empty')?.textContent ?? '',
    }));
    throw new Error(`openSettingsContext timed out errors=${JSON.stringify(errors)} diag=${JSON.stringify(diag)}`);
  }
  const closeSettings = async page => {
    await page.evaluate(() => {
      if (document.body.classList.contains('settings')) document.getElementById('backToChat')?.click();
      document.getElementById('onboardingDialog')?.close();
    });
    await page.waitForFunction(() => !document.body.classList.contains('settings'), { timeout: 5000 });
    await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  };

  // ==================== 1. Desktop 1280 Light: 設定 › プラグイン ====================
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'light', locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('__plyTabCleared')) {
        sessionStorage.setItem('__plyTabCleared', '1');
        localStorage.removeItem('ply-context-tab');
        localStorage.removeItem('ply-session-context-tab');
      }
    });
    await page.goto(baseUrl, { waitUntil: 'load' });
    await openSettingsContext(page);

    const tabs = await page.locator('#contextPanel .cx-tabs [role="tab"]').evaluateAll(els =>
      els.map(e => ({ id: e.dataset.tab, selected: e.getAttribute('aria-selected'), cnt: e.querySelector('.c')?.textContent, h: e.getBoundingClientRect().height })));
    check(tabs.map(x => x.id).join(',') === 'instruction,skill,mcp,hooks', '設定 › プラグインが 4 タブを正しい順で出す', tabs);
    check(tabs[0].selected === 'true' && Number(tabs[0].cnt) >= 12 && Number(tabs[1].cnt) >= 11 && Number(tabs[2].cnt) >= 3 && tabs[3].cnt === '1', '件数バッジが出る（Hooks は実行する行の数＝利用者の settings.json の 1 件）', tabs);
    check(await page.locator('#cx-panel-mcp #cliSetup').count() === 1, '「外の AI から Pleiad を使う」は外部 MCP タブの中に入る');
    const foldOpen0 = await page.locator('#cx-panel-instruction details.cx-fold').evaluate(el => el.open);
    check(
      await page.locator('#cx-panel-instruction .cx-seg').count() === 0
      && await page.locator('#cx-panel-skill .cx-seg').count() === 0
      && await page.locator('#cx-panel-hooks .cx-seg').count() === 0
      && foldOpen0 === false
      && await page.locator('#cx-panel-instruction details.cx-fold #cxInstructionBudget').count() === 1
      && await page.locator('#cx-panel-instruction [data-key="__workspace__"] .cx-sw').count() === 1
      && await page.locator('#cx-panel-skill [data-key="__workspace__"] .cx-sw').count() === 1
      && await page.locator('#cx-panel-instruction .cx-legend.names').count() >= 1,
      '段 2・3: 指示・Skills・Hooks に担当 2 択が無く、量の目安は初期折りたたみ、作業場所 summaryRow・凡例を表示',
    );
    const instTotal = await page.locator('#cx-panel-instruction .cx-sec > .cx-doc-total').textContent();
    check(/^約 [\d,]+ トークン$/.test(instTotal ?? ''), '「エージェントの設定」の見出しの右に、渡っているファイルの指示の量の合計を出す（モックどおり）', instTotal);
    await page.locator('#cx-panel-instruction details.cx-fold > summary').click();
    check(await page.locator('#cx-panel-instruction details.cx-fold').evaluate(el => el.open) === true, '量の目安の折りたたみを開くと中身が見える');
    await page.locator('#cx-panel-instruction details.cx-fold > summary').click();

    // Pleiad の指示: Grok を含む 6 エージェント押下可、委譲と連動（linked）は鍵つき・行スイッチ無し
    const plyGrokBtn = page.locator('#cx-panel-instruction .cx-ply .cx-row.ag').first().locator('.cx-ag[data-agent="grok"]');
    const beforePlyGrok = await plyGrokBtn.getAttribute('aria-pressed');
    const plyLinked = page.locator('#cx-panel-instruction .cx-ply .cx-row.ag').filter({ has: page.locator('.cbadge', { hasText: /連動|linked/i }) }).first();
    check(
      await plyGrokBtn.getAttribute('aria-disabled') === null
      && await plyLinked.locator('.cx-sw').count() === 0
      && await plyLinked.locator('.cx-ag[aria-disabled="true"][data-tip]').count() >= 1,
      'Pleiad の指示: Grok ボタンは押下可で、連動行には行スイッチが無く鍵つき',
    );
    await plyGrokBtn.click();
    await page.waitForFunction((want) => {
      const b = document.querySelector('#cx-panel-instruction .cx-ply .cx-row.ag .cx-ag[data-agent="grok"]');
      return b && b.getAttribute('aria-pressed') === want;
    }, beforePlyGrok === 'true' ? 'false' : 'true', { timeout: 5000 });
    check(true, 'Pleiad の指示で Grok アイコンの切り替えが保存される');
    await plyGrokBtn.click();
    await page.waitForFunction((want) => {
      const b = document.querySelector('#cx-panel-instruction .cx-ply .cx-row.ag .cx-ag[data-agent="grok"]');
      return b && b.getAttribute('aria-pressed') === want;
    }, beforePlyGrok, { timeout: 5000 });

    // スクロールしてもタブ帯が上に残る（sticky）。高さが画面を超えるよう一時的にビューポートを低くして確認する
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.waitForFunction(() => innerHeight === 500);
    await page.evaluate(() => { document.querySelector('.settings-content').scrollTop = 240; });
    await page.waitForFunction(() => document.querySelector('.settings-content').scrollTop > 100, { timeout: 5000 });
    const stickyPos = await page.evaluate(() => {
      const scEl = document.querySelector('.settings-content');
      const sc = scEl.getBoundingClientRect();
      const tb = document.querySelector('#contextPanel .cx-tabs').getBoundingClientRect();
      return { scTop: Math.round(sc.top), tbTop: Math.round(tb.top), tbBottom: Math.round(tb.bottom), scrollTop: scEl.scrollTop, scrollH: scEl.scrollHeight, clientH: scEl.clientHeight };
    });
    await page.setViewportSize({ width: 1280, height: 820 });
    check(stickyPos.scrollTop > 100 && stickyPos.tbTop >= stickyPos.scTop - 2 && stickyPos.tbBottom > stickyPos.tbTop, '下にスクロールしても 4 タブが上に残る（sticky）', stickyPos);

    // キーボード操作: ArrowRight / End / ArrowRight(wrap) / ArrowLeft(wrap) / Home
    await page.locator('#cx-tab-instruction').focus();
    await page.keyboard.press('ArrowRight');
    check((await page.evaluate(() => document.activeElement?.id)) === 'cx-tab-skill' && await page.locator('#cx-panel-skill').isVisible(), 'ArrowRight で隣の Skills タブへ移る');
    await page.keyboard.press('End');
    check((await page.evaluate(() => document.activeElement?.id)) === 'cx-tab-hooks' && await page.locator('#cx-panel-hooks').isVisible(), 'End で末尾の Hooks タブへ移る');
    await page.keyboard.press('ArrowRight');
    check((await page.evaluate(() => document.activeElement?.id)) === 'cx-tab-instruction', 'ArrowRight で末尾から先頭へ循環する');
    await page.keyboard.press('ArrowLeft');
    check((await page.evaluate(() => document.activeElement?.id)) === 'cx-tab-hooks', 'ArrowLeft で先頭から末尾へ循環する');
    await page.keyboard.press('Home');
    check((await page.evaluate(() => document.activeElement?.id)) === 'cx-tab-instruction', 'Home で先頭タブへ戻る');

    // タブ切替で先頭スクロール戻り + localStorage 記憶とリロード復元
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.evaluate(() => { document.querySelector('.settings-content').scrollTop = 200; });
    await page.locator('#cx-tab-mcp').click();
    const afterSwitch = await page.evaluate(() => ({
      scrollTop: document.querySelector('.settings-content').scrollTop,
      stored: localStorage.getItem('ply-context-tab'),
    }));
    await page.setViewportSize({ width: 1280, height: 820 });
    check(afterSwitch.scrollTop === 0 && afterSwitch.stored === 'mcp', 'タブ切替で親スクロールが 0 に戻り、最後のタブを localStorage に覚える', afterSwitch);

    await page.reload({ waitUntil: 'load' });
    await openSettingsContext(page);
    check((await page.locator('#cx-tab-mcp').getAttribute('aria-selected')) === 'true', '再読み込み後に最後に開いていた mcp タブが復元される');
    await page.locator('#cx-tab-instruction').click();

    // フォルダーまとまり（>8 で初期折りたたみ・子に親ロゴ重複なし・一部で checkbox mixed・一括切替）
    const grp = page.locator('#cx-panel-instruction .cx-row.grp', { hasText: 'team-rules' });
    check((await grp.locator('.cx-tw').getAttribute('aria-expanded')) === 'false', '8 件超の rules まとまりは最初閉じている');
    check((await page.locator('#cx-panel-instruction .cx-row.kid').count()) === 0, '閉じた rules の子は出ていない');
    await grp.locator('.cx-tw').click();
    const kids = page.locator('#cx-panel-instruction .cx-row.kid');
    check((await kids.count()) === 9, 'rules まとまりを開くと 9 件の子行が出る', await kids.count());
    check((await kids.locator('.cx-src').count()) === 0, 'まとまり内の子行には出どころのロゴを繰り返さない');

    await kids.first().locator('.cx-sw').click();
    await page.waitForFunction(() => document.querySelector('#cx-panel-instruction .cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'mixed', { timeout: 10000 });
    const mixSw = grp.locator('.cx-sw');
    check((await mixSw.getAttribute('role')) === 'checkbox' && (await mixSw.getAttribute('aria-label')).includes('一部オン'), '子 1 つオフでまとまりスイッチが checkbox mixed＋「一部オン」のラベルになる', await mixSw.getAttribute('aria-label'));
    check((await mixSw.getAttribute('aria-label')).includes('変更できる分をまとめてオフにする'), '一部オンのまとまりを押すと何が起きるか（変えられる分をまとめてオフ）をラベルに持つ', await mixSw.getAttribute('aria-label'));

    // 一部オンのまとまりを押すと、変えられるオンだけがまとめてオフになる（オンを広げない）。もう一度押すと外す前の選択（最初にオフだった 1 件は入れない）に戻る
    await mixSw.click();
    await page.waitForFunction(() => document.querySelector('#cx-panel-instruction .cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'false', { timeout: 10000 });
    check((await mixSw.getAttribute('aria-label')).includes('外す前の選択に戻す'), 'mixed を押すとまとめてオフ。次に押すと「外す前の選択に戻す」とラベルに出る', await mixSw.getAttribute('aria-label'));
    await mixSw.click();
    await page.waitForFunction(() => document.querySelector('#cx-panel-instruction .cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'mixed', { timeout: 10000 });
    check((await kids.first().locator('.cx-sw').getAttribute('aria-checked')) === 'false', 'もう一度押すと外す前の選択に戻る。最初にオフだった 1 件は入れない（オンを新しく足さない）');
    // 最初にオフだった子を単独で押す: まとめて外したとき、今回は外していない子の古い戻し先は消してあるので、記録なし＝出どころ優先の初期値
    // （探す場所に足したフォルダーの物は Pleiad が出どころ＝鍵の無い全エージェント）に戻る。ほかの子は Claude だけのままなので、まとまりは一部オンのまま
    const firstKidSw = kids.first().locator('.cx-sw');
    await firstKidSw.click();
    await page.waitForFunction(() => document.querySelector('#cx-panel-instruction .cx-row.kid .cx-sw')?.getAttribute('aria-checked') === 'true', { timeout: 10000 });
    check((await grp.locator('.cx-sw').getAttribute('aria-checked')) === 'mixed', '子を 1 つだけ入れ直しても、ほかの子は広がらずまとまりは一部オンのまま（オンを新しく足さない）');
    await shoot(page, 'context-agents-1280-light-inst.png');

    // GEMINI.md: Antigravity の鍵、Grok へ広げる前の確認（.cx-ask）→ やめる → 渡す → リロード後も永続
    const agyRow = page.locator('#cx-panel-instruction .cx-row.ag', { hasText: 'GEMINI.md' });
    const agyOwn = agyRow.locator('.cx-ag[data-agent="antigravity"]');
    const agyGrok = agyRow.locator('.cx-ag[data-agent="grok"]');
    check(
      await agyOwn.getAttribute('aria-disabled') === 'true' && (await agyOwn.getAttribute('data-tip')).includes('止められません')
      && await agyGrok.getAttribute('aria-disabled') !== 'true' && await agyGrok.getAttribute('aria-pressed') === 'false',
      'GEMINI.md の Antigravity セルは鍵付きで、Grok セルは切り替えられる',
    );
    await agyOwn.hover();
    await page.waitForSelector('.cx-tip.on', { state: 'visible', timeout: 3000 });
    await shoot(page, 'context-agents-1280-light-inst-locktip.png');
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => !document.querySelector('.cx-tip.on'), { timeout: 3000 });
    await agyGrok.click();
    await page.waitForSelector('#cx-panel-instruction .cx-ask', { state: 'visible', timeout: 5000 });
    await shoot(page, 'context-agents-1280-light-inst-ask.png');
    await page.locator('#cx-panel-instruction .cx-ask button').first().click();
    await page.waitForFunction(() => !document.querySelector('#cx-panel-instruction .cx-ask'), { timeout: 5000 });
    const focusedAfterCancel = await page.evaluate(() => document.activeElement?.getAttribute('data-agent'));
    check(
      focusedAfterCancel === 'grok' && await agyGrok.getAttribute('aria-pressed') === 'false',
      '広げる確認「やめる」で未保存のまま元の Grok セルへフォーカスを戻す',
      focusedAfterCancel,
    );
    await agyGrok.click();
    await page.waitForSelector('#cx-panel-instruction .cx-ask .btn-primary', { state: 'visible', timeout: 5000 });
    await page.locator('#cx-panel-instruction .cx-ask .btn-primary').click();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#cx-panel-instruction .cx-row.ag')];
      const r = rows.find(x => x.textContent.includes('GEMINI.md'));
      return !document.querySelector('#cx-panel-instruction .cx-ask') && r?.querySelector('.cx-ag[data-agent="grok"]')?.getAttribute('aria-pressed') === 'true';
    }, { timeout: 10000 });
    check(true, '広げる確認「渡す」で GEMINI.md の Grok セルがオンになり保存される');

    await page.reload({ waitUntil: 'load' });
    await openSettingsContext(page, 'instruction');
    check(
      await agyGrok.getAttribute('aria-pressed') === 'true',
      '再読み込み後も setDocAgent で広げた設定（GEMINI.md → Grok）が保持される',
    );
    // 元の状態へ戻す（オフ時は確認なし）
    await agyGrok.click();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#cx-panel-instruction .cx-row.ag')];
      const r = rows.find(x => x.textContent.includes('GEMINI.md'));
      return r?.querySelector('.cx-ag[data-agent="grok"]')?.getAttribute('aria-pressed') === 'false';
    }, { timeout: 10000 });

    // Skills タブ + 絞り込み欄
    await page.locator('#cx-tab-skill').click();
    await page.waitForFunction(() => document.querySelectorAll('#cx-panel-skill .cx-row.grp').length >= 2, { timeout: 10000 });
    await shoot(page, 'context-agents-1280-light-skills.png');
    // 探すのと読むのを 1 回の evaluate で行う。locator.evaluateAll は探すのと読むのが別の呼び出しで、その間に直前の保存の書き直しが
    // 来ると、外れた古い行の innerText（区切りの無い文字）を読んで落ちた
    const skillGrps = await page.evaluate(() => [...document.querySelectorAll('#cx-panel-skill .cx-row.grp')].map(e => ({
      text: e.innerText.replace(/\s+/g, ' ').trim(),
      expanded: e.querySelector('.cx-tw')?.getAttribute('aria-expanded'),
    })));
    const grp9 = skillGrps.find(g => /\.codex[\\/]skills/.test(g.text) && /\b9\b/.test(g.text));
    const grp2 = skillGrps.find(g => /\.agents[\\/]skills/.test(g.text) && /\b2\b/.test(g.text));
    check(grp9 && grp9.expanded === 'false' && grp2 && grp2.expanded === 'true',
      'Skills の 9 件まとまりは初期折りたたみ、2 件まとまりは最初から開いている', skillGrps);
    check((await page.locator('#cx-panel-skill .cx-row.kid').count()) === 2, '2 件まとまりの子 2 行だけが見えている', skillGrps);

    const findInput = page.locator('#cx-panel-skill .cx-find input');
    await findInput.click();
    await page.evaluate(() => { window.__findRef = document.querySelector('#cx-panel-skill .cx-find input'); });
    await findInput.pressSequentially('u-skill-6');
    await page.waitForFunction(() => document.querySelectorAll('#cx-panel-skill .cx-row.kid').length === 1, { timeout: 5000 });
    const findState = await page.evaluate(() => ({
      sameNode: document.querySelector('#cx-panel-skill .cx-find input') === window.__findRef,
      focused: document.activeElement === window.__findRef,
      kidText: document.querySelector('#cx-panel-skill .cx-row.kid .nm')?.textContent,
    }));
    check(findState.sameNode && findState.focused && findState.kidText === 'u-skill-6', 'Skills 絞り込み中も input 要素とフォーカスを維持し、当たったまとまりが開く', findState);

    await findInput.fill('never-match-xyz');
    check((await page.locator('#cx-panel-skill').innerText()).includes('見つかりません'), 'Skills 0 件で「見つかりません」を出す');
    await findInput.press('Escape');
    check((await findInput.inputValue()) === '' && !(await page.locator('#cx-panel-skill').innerText()).includes('見つかりません'), '絞り込み欄の Escape で条件を消す');

    // 絞り込み中のまとまりスイッチは、見えている（当たった）行だけを切り替える（Stage 2: docMatrix 保存・旧 excludePaths は汚さない）
    const skillMatrixState = async () => {
      const m = await client.cmd('docMatrix', { kind: 'skill', cwd: home, place: 'default' });
      const u1 = m.rows.find(r => r.name === 'u-skill-1');
      const otherOff = m.rows.filter(r => r.name.startsWith('u-skill-') && r.name !== 'u-skill-1' && !r.rowSwitchOn).length;
      const legacy = await client.cmd('contextSettings', {});
      return {
        touched: m.touched,
        u1On: Boolean(u1?.rowSwitchOn),
        otherOff,
        legacyExcludes: legacy.defaults.kinds.skill.value.user.excludePaths.length,
      };
    };
    const beforeFilterSkill = await skillMatrixState();
    check(beforeFilterSkill.u1On && beforeFilterSkill.legacyExcludes === 0, '絞り込みの前は Skills が有効で旧 excludePaths は 0 件', beforeFilterSkill);
    await findInput.fill('u-skill-1');
    const pollUntil = async (readFn, pred, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const statusErr = (await page.locator('#contextPanel .cx-status').textContent().catch(() => ''))?.trim();
        if (statusErr) throw new Error(`Settings error status appeared: ${statusErr}`);
        const val = await readFn();
        if (pred(val) || Date.now() >= deadline) return val;
        await new Promise(r => setTimeout(r, 50));
      }
    };
    await page.waitForFunction(() => document.querySelectorAll('#cx-panel-skill .cx-row.kid').length === 1, null, { timeout: 5000 });
    const filteredGrp = page.locator('#cx-panel-skill .cx-row.grp');
    // .codex/skills の行は Codex だけがオン（鍵なしのマス 5 つのうち 1 つ）なので、まとまりスイッチは「一部オン」（横棒）。押すとオンを広げず、変えられるオンだけをまとめてオフにする
    check((await filteredGrp.count()) === 1 && (await filteredGrp.locator('.cx-sw').getAttribute('aria-checked')) === 'mixed'
      && (await filteredGrp.locator('.cx-sw').getAttribute('aria-label')).includes('変更できる分をまとめてオフにする'),
    '絞り込み中のまとまりスイッチは見えている行だけから「一部オン」と決まり、押すとオンを広げずまとめてオフにする',
    await filteredGrp.locator('.cx-sw').getAttribute('aria-label'));
    await filteredGrp.locator('.cx-sw').click();
    await page.waitForFunction(() => document.querySelector('#cx-panel-skill .cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'false', null, { timeout: 10000 });
    const afterFilterOff = await pollUntil(skillMatrixState, s => s.touched && !s.u1On && s.otherOff === 0 && s.legacyExcludes === 0);
    check(afterFilterOff.touched && !afterFilterOff.u1On && afterFilterOff.otherOff === 0 && afterFilterOff.legacyExcludes === 0,
      '絞り込み中のまとまりスイッチで、当たった u-skill-1 だけが context-agents にオフ保存され旧 excludePaths は増えない', afterFilterOff);
    await findInput.press('Escape');
    await page.waitForFunction(() => [...document.querySelectorAll('#cx-panel-skill .cx-row.grp .cx-sw')].some(s => s.getAttribute('aria-checked') === 'mixed'), null, { timeout: 5000 });
    check(true, '絞り込みを消すとまとまり全体の状態（一部）に戻る');
    // 外した u-skill-1 は、もう一度絞り込んでまとまりスイッチを押すと、外す前の選択（Codex だけオン）に戻る。ほかの行は巻き込まない
    await findInput.fill('u-skill-1');
    await page.waitForFunction(() => document.querySelectorAll('#cx-panel-skill .cx-row.kid').length === 1, null, { timeout: 5000 });
    const restoreSw = page.locator('#cx-panel-skill .cx-row.grp .cx-sw');
    check((await restoreSw.getAttribute('aria-checked')) === 'false' && (await restoreSw.getAttribute('aria-label')).includes('外す前の選択に戻す'),
      '外した u-skill-1 だけに絞ると、まとまりスイッチはオフで、押すと「外す前の選択に戻す」', await restoreSw.getAttribute('aria-label'));
    await restoreSw.click();
    await page.waitForFunction(() => document.querySelector('#cx-panel-skill .cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'mixed', null, { timeout: 10000 });
    const afterRestoreSkill = await pollUntil(skillMatrixState, s => s.u1On && s.otherOff === 0);
    check(afterRestoreSkill.u1On && afterRestoreSkill.otherOff === 0, 'まとまりスイッチで u-skill-1 が外す前の選択に戻り、ほかの行は変わらない', afterRestoreSkill);
    await findInput.press('Escape');

    // 外部 MCP タブ + 鍵の吹き出し（追補 1）
    await page.locator('#cx-tab-mcp').click();
    await page.waitForSelector('#contextPanel [data-kind=mcp] .cx-ag[data-tip]', { state: 'visible', timeout: 15000 });
    const mcpText = await page.locator('#contextPanel [data-kind=mcp]').innerText();
    check(!mcpText.includes('Pleiad からは止められません'), '外部 MCP の静的な鍵の凡例行を消している');

    const lockedCell = page.locator('#contextPanel [data-kind=mcp] .cx-ag[aria-disabled="true"][data-tip]').first();
    const lockAttr = await lockedCell.evaluate(e => ({
      hasTitle: e.hasAttribute('title'),
      disabledProp: e.disabled,
      ariaDisabled: e.getAttribute('aria-disabled'),
      pressed: e.getAttribute('aria-pressed'),
      tip: e.dataset.tip,
      aria: e.getAttribute('aria-label'),
    }));
    check(!lockAttr.hasTitle && !lockAttr.disabledProp && lockAttr.ariaDisabled === 'true' && Boolean(lockAttr.tip) && lockAttr.aria.includes(lockAttr.tip),
      '鍵アイコンは title を持たず aria-disabled="true" で、読み上げ名に理由を含む', lockAttr);

    // ホバーで出て外れて閉じる（一覧は読み取りが終わると描き直すので、描き直しで外れた瞬間に当たったら、枠が取れるまで待ち直す）
    let box = null;
    for (let i = 0; i < 20 && !box; i++) {
      await lockedCell.waitFor({ state: 'visible', timeout: 5000 });
      box = await lockedCell.boundingBox();
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('.cx-tip.on', { state: 'visible', timeout: 3000 });
    check((await page.locator('.cx-tip.on').innerText()) === lockAttr.tip, '鍵アイコンのホバーで吹き出しに理由が出る');
    await shoot(page, 'context-agents-1280-light-mcp-locktip.png');
    // 描き直し（外部 MCP の一覧は読み込み中 2.5 秒ごとに描き直す）で相手の鍵が外されたら、吹き出しも消える
    await lockedCell.evaluate(e => {
      const row = e.closest('.cx-row.ag');
      const holder = document.createComment('lock-tip-test');
      row.replaceWith(holder);
      window.__lockRow = { row, holder };
    });
    await page.waitForFunction(() => !document.querySelector('.cx-tip.on'), { timeout: 3000 });
    check(true, '相手の鍵が描き直しで DOM から外れると、吹き出しは古い位置に残らず消える');
    await page.evaluate(() => { const { row, holder } = window.__lockRow; holder.replaceWith(row); });
    // 描き直しの後も、鍵にマウスを載せ直せば吹き出しが出る。
    // 一度外へ出してから載せる: 同じ要素を戻しただけだと、ブラウザーがホバーの相手を更新する前後で pointerover が出るかどうかが変わり、試験が不安定になる
    await page.mouse.move(2, 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('.cx-tip.on', { state: 'visible', timeout: 3000 });
    await page.evaluate(() => {
      const a = document.querySelector('.cx-tip.on') && document.querySelector('[data-tip]:hover');
      if (a) a.replaceWith(a.cloneNode(true));
    });
    await page.waitForFunction(() => {
      const on = document.querySelector('.cx-tip.on');
      if (!on) return true;
      const a = document.querySelector('[data-tip]:hover');
      return Boolean(a) && a.isConnected && on.textContent === a.dataset.tip;
    }, { timeout: 3000 });
    check(true, '鍵が新しい要素に置き換わっても、吹き出しは消えるか、新しい鍵の理由で出し直される');
    await page.mouse.move(10, 10);
    await page.waitForFunction(() => !document.querySelector('.cx-tip.on'), { timeout: 3000 });
    check(true, 'ホバーが外れると吹き出しが閉じる');

    // キーボードフォーカス (:focus-visible) で即出て、Escape で閉じてもフォーカス維持
    await lockedCell.evaluate(e => {
      const row = e.closest('.cx-row.ag');
      const btns = [...row.querySelectorAll('button')];
      const idx = btns.indexOf(e);
      (idx > 0 ? btns[idx - 1] : row.querySelector('.cx-sw')).focus();
    });
    await page.keyboard.press('Tab');
    await page.waitForSelector('.cx-tip.on', { state: 'visible', timeout: 2000 });
    check(true, 'Tab フォーカス（:focus-visible）で吹き出しが出る');
    await page.keyboard.press('Escape');
    const afterEscFocus = await page.evaluate(() => ({
      tipOn: Boolean(document.querySelector('.cx-tip.on')),
      kept: document.activeElement?.classList.contains('cx-ag') && document.activeElement?.getAttribute('aria-disabled') === 'true',
    }));
    check(!afterEscFocus.tipOn && afterEscFocus.kept, 'Escape で吹き出しが閉じ、同じ鍵アイコンにフォーカスが残る', afterEscFocus);

    // クリック/タップしても状態は変わらず吹き出しトグル、スクロールして隠れたら閉じる
    await lockedCell.dispatchEvent('pointerdown', { pointerType: 'touch' });
    await lockedCell.click({ force: true });
    await page.waitForSelector('.cx-tip.on', { state: 'visible', timeout: 2000 });
    check((await lockedCell.getAttribute('aria-pressed')) === lockAttr.pressed, '鍵アイコンを押しても状態は変わらず吹き出しが開く');
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.evaluate(() => { const sc = document.querySelector('.settings-content'); sc.scrollTop = sc.scrollHeight; });
    await page.waitForFunction(() => !document.querySelector('.cx-tip.on'), { timeout: 2000 });
    await page.setViewportSize({ width: 1280, height: 820 });
    check(true, 'スクロールで鍵アイコンが隠れると吹き出しを閉じる');

    // ==================== 2. Desktop 1280 Light: 会話の右パネル ====================
    await closeSettings(page);
    await page.waitForSelector(`[data-session="${managed.sessionId}"]`, { state: 'visible', timeout: 15000 });
    await page.locator(`[data-session="${managed.sessionId}"]`).first().click();
    await page.setViewportSize({ width: 700, height: 820 });
    await page.locator('#sessionMore').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#sessionMore').click();
    await page.getByRole('menuitem', { name: /プラグイン/ }).click();
    await page.waitForSelector('.file-preview-content .scx [data-act="placeStart"]', { state: 'visible', timeout: 15000 });
    await page.setViewportSize({ width: 1280, height: 820 });
    check((await page.locator('.file-preview-content .scx .cx-tabs').count()) === 0, '右パネル通常面（編集前）には 4 タブを出さない');

    await page.locator('.file-preview-content .scx [data-act="placeStart"]').click();
    await page.waitForFunction(() => Number(document.querySelector('#scx-tab-instruction .c')?.textContent) >= 10, null, { timeout: 15000 });
    const scxTabs = await page.locator('.file-preview-content .scx .cx-tabs [role="tab"]').evaluateAll(els =>
      els.map(e => ({ id: e.dataset.tab, cnt: e.querySelector('.c')?.textContent })));
    check(scxTabs.map(x => x.id).join(',') === 'instruction,skill,mcp,hooks' && Number(scxTabs[0].cnt) >= 10 && Number(scxTabs[1].cnt) >= 9,
      '右パネル「この場所だけ変える」に入ると 4 タブ・件数が出る', scxTabs);
    // Hooks の表（hooks.matrix の cwd つき）は遅れて届く
    await page.waitForFunction(() => document.querySelector('#scx-panel-hooks [data-row] .cx-sw'), null, { timeout: 15000 }).catch(() => {});
    check(
      await page.locator('#scx-panel-instruction .cx-seg, #scx-panel-skill .cx-seg').count() === 0
      && await page.locator('#scx-panel-instruction .cx-ags, #scx-panel-skill .cx-ags').count() === 0
      && await page.locator('#scx-panel-hooks .cx-seg, #scx-panel-hooks .cx-ags').count() === 0
      && await page.locator('#scx-panel-hooks [data-row] .cx-sw').count() === 1
      && await page.locator('#scx-panel-instruction .cx-row', { hasText: 'CLAUDE.md' }).first().locator('.cx-sw').count() === 1
      && await page.locator('#scx-panel-instruction .cx-row', { hasText: 'AGENTS.md' }).first().locator('.cx-sw').count() === 1,
      '右パネル編集: 指示・Skills・Hooks には担当 2 択とエージェント列を出さず、利用者 CLAUDE.md・作業場所 AGENTS.md・利用者の Hook の行スイッチを出す',
      await page.locator('#scx-panel-hooks').textContent(),
    );
    const scxTok = await page.locator('#scx-panel-instruction .cx-row', { hasText: 'AGENTS.md' }).first().locator('.cx-tok').textContent().catch(() => null);
    check(/^約 [\d,]+$/.test(scxTok ?? '') && await page.locator('#scx-panel-skill .cx-tok').count() === 0,
      '右パネル編集: 指示の行の右に量を出し（モックどおり）、Skills には出さない', scxTok);
    await shoot(page, 'context-agents-1280-light-panel-inst.png');

    // 右パネルの 9 件 rules まとまりの開閉と mixed 一括切替（リポジトリの .claude/rules は鍵で押せないので、探す場所に足した team-rules で試す）
    const scxArchGrp = page.locator('#scx-panel-instruction .cx-row.grp', { hasText: 'team-rules' }).last();
    await scxArchGrp.locator('.cx-tw').click();
    const scxKids = page.locator('#scx-panel-instruction .cx-row.kid');
    check((await scxKids.count()) >= 9, '右パネルでも >8 のまとまりを開いて子行を出せる');
    // 右パネルも左と同じ動き（ADR 0337 §決定 4 の 2026-11-17 改訂）: 子を 1 つ外す → まとまりは一部オン → 押すと変えられるオンをまとめてオフ
    // → もう一度押すと外す前の選択に戻る（最初に外していた 1 件はオンにしない）
    const scxGrpSw = scxArchGrp.locator('.cx-sw');
    const scxFirstKid = scxKids.first().locator('.cx-sw');
    await scxFirstKid.click();
    await page.waitForFunction(() => document.querySelector('#scx-panel-instruction .cx-row.kid .cx-sw')?.getAttribute('aria-checked') === 'false', null, { timeout: 10000 });
    check((await scxGrpSw.getAttribute('aria-checked')) === 'mixed' && (await scxGrpSw.getAttribute('aria-label')).includes('変更できる分をまとめてオフにする'),
      '右パネルでも、子を 1 つ外すとまとまりは一部オン（押すと変えられる分をまとめてオフ）', await scxGrpSw.getAttribute('aria-label'));
    await scxGrpSw.click();
    await page.waitForFunction(() => {
      const kids = [...document.querySelectorAll('#scx-panel-instruction .cx-row.kid .cx-sw')];
      return kids.length >= 9 && kids.every(s => s.getAttribute('aria-checked') === 'false');
    }, null, { timeout: 10000 });
    check((await scxGrpSw.getAttribute('aria-checked')) === 'false' && (await scxGrpSw.getAttribute('aria-label')).includes('外す前の選択に戻す'),
      '右パネルでも、まとまりを押すと全部の子がオフになり、次は「外す前の選択に戻す」', await scxGrpSw.getAttribute('aria-label'));
    await scxGrpSw.click();
    await page.waitForFunction(() => (document.querySelectorAll('#scx-panel-instruction .cx-row.kid .cx-sw')[1])?.getAttribute('aria-checked') !== 'false', null, { timeout: 10000 });
    check((await scxFirstKid.getAttribute('aria-checked')) === 'false' && (await scxGrpSw.getAttribute('aria-checked')) === 'mixed',
      '右パネルでも、もう一度押すと外す前の選択に戻る（最初に外していた 1 件はオンにしない）');

    // 右パネルの sticky & Skills 絞り込み
    await page.locator('#scx-tab-skill').click();
    await page.waitForSelector('#scx-panel-skill .cx-find input', { state: 'visible', timeout: 10000 });
    await shoot(page, 'context-agents-1280-light-panel-skills.png');
    const scxFind = page.locator('#scx-panel-skill .cx-find input');
    await scxFind.click();
    await scxFind.pressSequentially('r-skill-4');
    await page.waitForFunction(() => [...document.querySelectorAll('#scx-panel-skill .cx-row.kid .nm')].some(n => n.textContent === 'r-skill-4'), null, { timeout: 5000 });
    await scxFind.fill('no-right-skill-xyz');
    check((await page.locator('#scx-panel-skill').innerText()).includes('見つかりません'), '右パネル Skills でも 0 件で「見つかりません」が出る');
    await scxFind.press('Escape');
    check((await scxFind.inputValue()) === '', '右パネル Skills の Escape で入力が空に戻る');

    // 右パネルでも、絞り込み中のまとまりスイッチは当たった行だけを切り替える
    await scxFind.fill('r-skill-1');
    await page.waitForFunction(() => document.querySelectorAll('#scx-panel-skill .cx-row.kid').length === 1, null, { timeout: 5000 });
    const scxOnly = page.locator('#scx-panel-skill .cx-row.grp .cx-sw');
    // .codex/skills の行は Codex だけがオン（鍵なしのマス 5 つのうち 1 つ）なので、見えている 1 行だけから「一部オン」と決まる
    check((await scxOnly.count()) === 1 && (await scxOnly.getAttribute('aria-checked')) === 'mixed', '右パネルの絞り込み中のスイッチは見えている行だけから「一部オン」と決まる', await scxOnly.getAttribute('aria-label'));
    await scxOnly.click();
    await page.waitForFunction(() => document.querySelector('#scx-panel-skill .cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'false', null, { timeout: 10000 });
    await scxFind.press('Escape');
    await page.waitForFunction(() => [...document.querySelectorAll('#scx-panel-skill .cx-row.grp .cx-sw')].some(s => s.getAttribute('aria-checked') === 'mixed'), null, { timeout: 5000 });
    check(true, '右パネルでも、絞り込み中の一括切替は当たった 1 件だけで、消すと「一部」に戻る');
    // 外した 1 件は、もう一度絞り込んでスイッチを押すと外す前の選択に戻る
    await scxFind.fill('r-skill-1');
    await page.waitForFunction(() => document.querySelectorAll('#scx-panel-skill .cx-row.kid').length === 1, null, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#scx-panel-skill .cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'false', null, { timeout: 5000 });
    await scxOnly.click();
    await page.waitForFunction(() => document.querySelector('#scx-panel-skill .cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'mixed', null, { timeout: 10000 });
    await scxFind.press('Escape');

    // ==================== 3. 360px 狭幅 & ダークモードの横はみ出し・サイズ検査 ====================
    await page.setViewportSize({ width: 360, height: 760 });
    await page.waitForFunction(() => innerWidth === 360);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      if (scheme === 'dark') {
        await page.locator('#scx-tab-instruction').click();
        await page.waitForFunction(() => !document.getElementById('scx-panel-instruction')?.hidden
          && getComputedStyle(document.getElementById('scx-tab-skill')).backgroundColor === 'rgba(0, 0, 0, 0)', null, { timeout: 5000 });
        await shoot(page, 'context-agents-360-dark-panel-inst.png');
      }
      const rpLayout = await page.evaluate(() => {
        const sc = document.querySelector('.file-preview-content');
        const tabH = Math.min(...[...document.querySelectorAll('.scx .cx-tab')].map(e => e.getBoundingClientRect().height));
        return { pageOver: document.documentElement.scrollWidth > innerWidth, scOver: sc.scrollWidth > sc.clientWidth, tabH };
      });
      check(!rpLayout.pageOver && !rpLayout.scOver && rpLayout.tabH >= 38, `360px ${scheme} 右パネル編集で横にはみ出さない`, rpLayout);
    }
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await openSettingsContext(page, 'instruction');
      for (const tabId of ['instruction', 'skill', 'mcp', 'hooks']) {
        await page.locator(`#cx-tab-${tabId}`).click();
        await page.waitForFunction(id => document.getElementById(`cx-tab-${id}`)?.getAttribute('aria-selected') === 'true' && !document.getElementById(`cx-panel-${id}`)?.hidden, tabId, { timeout: 5000 });
        if (scheme === 'light' && tabId === 'instruction') await shoot(page, 'context-agents-360-light-inst.png');
        if (scheme === 'dark' && tabId === 'skill') await shoot(page, 'context-agents-360-dark-skills.png');
        const sLayout = await page.evaluate(() => {
          const sc = document.querySelector('.settings-content');
          const tabH = Math.min(...[...document.querySelectorAll('#contextPanel .cx-tab')].map(e => e.getBoundingClientRect().height));
          const agSizes = [...document.querySelectorAll('#contextPanel button.cx-ag')].filter(e => e.offsetParent).map(e => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height));
          return {
            pageOver: document.documentElement.scrollWidth > innerWidth,
            scOver: sc.scrollWidth > sc.clientWidth,
            tabH,
            minAg: agSizes.length ? Math.min(...agSizes) : 99,
          };
        });
        check(!sLayout.pageOver && !sLayout.scOver && sLayout.tabH >= 38 && sLayout.minAg >= 38, `360px ${scheme} 設定 (${tabId}) で横にはみ出さず押し先サイズが十分`, sLayout);
      }
      await closeSettings(page);
    }
    await ctx.close();
  }

  // ==================== 3b. 行のスイッチの鍵（ADR 0337 §決定 4）: 当たりの分け・吹き出し（タッチ・focus・ホバー）・4 タブ ====================
  // 鍵の当たり（12×12 の鍵の左へ 4px・下へ 1px 足した 16×13）は、スイッチの押せる面（360 幅で 44×44）から切り抜く。
  // 鍵の見える位置は同じまま、スイッチの中央・端を押せば切り替わり、鍵を押したときだけ吹き出しが開く。
  // 4 タブすべてに「鍵つきのオンだけが残る行」と押せない行を置くため、専用のサーバー（別のデータ置き場・home）を立てる。
  // 鍵つきでオンのマスを持つ物（エージェントの置き場の物）の、変えられるオンだけを外して、鍵つきのオンが残る行にする。
  const lkRoot = path.join(dataDir, 'lock-part');
  const lkHome = path.join(lkRoot, 'home');
  write(path.join(lkHome, '.claude/CLAUDE.md'), '# User Instructions\nAlways be concise.\n');
  write(path.join(lkHome, '.claude/skills/lock-skill/SKILL.md'), '---\nname: lock-skill\ndescription: Lock skill\n---\n# lock-skill\n');
  write(path.join(lkHome, '.claude.json'), JSON.stringify({ mcpServers: { lockMcp: { command: 'lock-cmd' } } }));
  write(path.join(lkHome, '.claude/settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo lock-hook' }] }] } }));
  // 鍵つきのオンだけで、変えられるマスも戻し先も無い行（押せない行）
  write(path.join(lkHome, '.codex/AGENTS.md'), '# Codex\nBrief.\n');
  write(path.join(lkHome, '.gemini/GEMINI.md'), '# Gemini\nBrief.\n');
  write(path.join(lkHome, '.grok/auth.json'), JSON.stringify({ apiKey: 'test-key' }));
  const lkGrokStub = path.join(lkRoot, process.platform === 'win32' ? 'grok-stub.cmd' : 'grok-stub');
  write(lkGrokStub, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') fs.chmodSync(lkGrokStub, 0o755);
  const lkBins = Object.fromEntries(['CLAUDE', 'CODEX', 'AGY', 'OPENCODE', 'DEVIN', 'GROK'].map(n => [`AGENT_HOST_${n}_BIN`, path.join(lkRoot, `no-such-${n.toLowerCase()}.exe`)]));
  lkServer = await startServer({
    dataDir: path.join(lkRoot, 'data'),
    env: {
      AGENT_HOST_BACKENDS: 'fake,claude,codex,antigravity,opencode,devin,grok',
      USERPROFILE: lkHome, HOME: lkHome, PLEIAD_SCAN_HOME: lkHome,
      CODEX_HOME: path.join(lkHome, '.codex'), CLAUDE_CONFIG_DIR: path.join(lkHome, '.claude'),
      AGENT_HOST_GROK_HOME: path.join(lkHome, '.grok'),
      ...lkBins,
      AGENT_HOST_GROK_BIN: lkGrokStub,
    },
  });
  lkClient = await open({ ...lkServer, autoAllow: true });
  await lkClient.cmd('onboardingSeen');
  {
    const dm = await lkClient.cmd('docMatrix', { kind: 'instruction', cwd: lkHome, place: null });
    const instKey = dm.rows.find(r => String(r.key).replace(/\\/g, '/').endsWith('/.claude/claude.md'))?.key;
    if (!instKey) throw new Error(`3b 用の CLAUDE.md の行が見つからない: ${JSON.stringify(dm.rows.map(r => r.key))}`);
    await lkClient.cmd('setDocRow', { kind: 'instruction', key: instKey, on: false, cwd: lkHome, place: null });
    await lkClient.cmd('setDocRow', { kind: 'skill', key: 'skill:lock-skill', on: false, cwd: lkHome, place: null });
    await lkClient.cmd('setMcpRow', { name: 'lockMcp', on: false, place: null, cwd: lkHome });
    // Hooks は画面と同じ呼び出し（cwd なし）で一覧を取る。user の Hook の行は Devin が鍵つきでオンなので、切れるオンだけを外す
    const hm = await lkClient.cmd('hooksMatrix', { trust: false });
    const hookKey = hm.rows.find(r => r.group === 'own')?.key;
    if (!hookKey) throw new Error(`3b 用の Hook の行が見つからない: ${JSON.stringify(hm.rows.map(r => r.key))}`);
    await lkClient.cmd('setHookRow', { key: hookKey, on: false, revision: hm.revision });
  }
  const lkUrl = `http://127.0.0.1:${lkServer.port}/?token=${lkServer.token}`;
  const TAB_IDS = ['instruction', 'skill', 'mcp', 'hooks'];
  const lockSwSel = tabId => `#cx-panel-${tabId} .cx-sw:has(>.lk[data-tip-pass])`;
  const INTERNAL_ID = /(^|[^A-Za-z])(devin|grok|antigravity|opencode|codex|claude)(?![A-Za-z])/;
  const lockTipFacts = page => page.evaluate(() => {
    const tip = document.querySelector('.cx-tip');
    const r = tip?.getBoundingClientRect();
    return { on: Boolean(tip?.classList.contains('on')), text: tip?.textContent ?? '', left: r?.left ?? 0, right: r?.right ?? 0, top: r?.top ?? 0, bottom: r?.bottom ?? 0, vw: innerWidth, vh: innerHeight };
  });
  const lockTipSane = (f, label) => {
    check(f.on && f.text.length > 0, `${label}: 吹き出しが開く`, f);
    check(f.left >= 0 && f.right <= f.vw && f.top >= 0 && f.bottom <= f.vh, `${label}: 吹き出しが画面の外へはみ出さない`, f);
    check(!f.text.includes('／') && !INTERNAL_ID.test(f.text), `${label}: 理由は行ごと（「／」でつながない）で、内部のキー（devin・grok など）が出ない`, f.text);
  };
  // 押すと行が描き直され、鍵の当たりを持たない形に変わることもあるので、行のキー（data-cx-fk、無ければ行の data-key）で同じスイッチを探す
  const rowSelOf = loc => loc.evaluate(sw => {
    if (sw.dataset.cxFk) return `.cx-sw[data-cx-fk=${JSON.stringify(sw.dataset.cxFk)}]`;
    const r = sw.closest('[data-key],[data-row]');
    const attr = r.hasAttribute('data-key') ? 'data-key' : 'data-row';
    return `[${attr}=${JSON.stringify(r.getAttribute(attr))}] .cx-sw`;
  });
  const lockedTabs = { 360: [], 1280: [] };
  const blockedTabs = [];
  const gotoTab = async (page, tabId) => {
    await page.locator(`#cx-tab-${tabId}`).click();
    await page.waitForFunction(id => document.getElementById(`cx-tab-${id}`)?.getAttribute('aria-selected') === 'true' && !document.getElementById(`cx-panel-${id}`)?.hidden, tabId, { timeout: 5000 });
    if (tabId === 'hooks') await page.waitForSelector('#cx-panel-hooks .cx-sw', { timeout: 15000 });
  };
  // Tab キーで、フォーカスを tabId のタブから行のスイッチ（sel）まで進める（タップのあとの focus() は :focus-visible にならないので、いったん外して入り直す）
  const tabToSwitch = async (page, tabId, sel) => {
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.locator(`#cx-tab-${tabId}`).focus();
    for (let i = 0; i < 120; i++) {
      await page.keyboard.press('Tab');
      if (await page.locator(sel).first().evaluate(sw => document.activeElement === sw)) return true;
    }
    return false;
  };
  // ---- 360 幅・タッチ
  {
    const tctx = await browser.newContext({ viewport: { width: 360, height: 760 }, colorScheme: 'light', locale: 'ja-JP', hasTouch: true });
    const page = await tctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(lkUrl, { waitUntil: 'load' });
    await page.evaluate(() => { window.__clicks = []; document.addEventListener('click', e => window.__clicks.push(`${e.target?.tagName}.${e.target?.className} pt=${e.pointerType ?? ''} @${Math.round(e.clientX)},${Math.round(e.clientY)}`), true); });
    await openSettingsContext(page, 'instruction');
    for (const tabId of TAB_IDS) {
      await gotoTab(page, tabId);

      // ---- 押せない行（aria-disabled）: ボタンのままキーボードのフォーカスを受け、理由が読める（鍵の理由は読み上げ名・吹き出しの両方に出る）
      const blocked = page.locator(`#cx-panel-${tabId} .cx-sw[aria-disabled="true"]`);
      const blockedCount = await blocked.count();
      console.log(`3b 360 ${tabId}: 押せない行 ${blockedCount} 行`);
      if (blockedCount) {
        blockedTabs.push(tabId);
        await blocked.first().scrollIntoViewIfNeeded();
        const bSel = `#cx-panel-${tabId} ${await rowSelOf(blocked.first())}`;
        const bInfo = await page.locator(bSel).first().evaluate(sw => ({ tag: sw.tagName, disabled: sw.disabled === true, tabindex: sw.tabIndex, label: sw.getAttribute('aria-label') ?? '', tip: sw.dataset.tip ?? '', checked: sw.getAttribute('aria-checked') }));
        check(bInfo.tag === 'BUTTON' && !bInfo.disabled && bInfo.tabindex >= 0, `360 ${tabId}: 押せない行のスイッチも、キーボードのフォーカスを受けるボタンのまま（disabled にしない）`, bInfo);
        const lines = bInfo.tip.split('\n').map(x => x.trim()).filter(Boolean);
        check(lines.length > 0 && lines.every(l => bInfo.label.includes(l.replace(/[。．.]$/, ''))), `360 ${tabId}: 押せない行の理由が読み上げ名（aria-label）に入っている`, bInfo);
        const bReached = await tabToSwitch(page, tabId, bSel);
        check(bReached, `360 ${tabId}: Tab で押せない行のスイッチへ届く`);
        await page.waitForFunction(() => document.querySelector('.cx-tip.on'), null, { timeout: 3000 });
        const bTip = await lockTipFacts(page);
        lockTipSane(bTip, `360 ${tabId} 押せない行（focus）`);
        check(bTip.text === bInfo.tip, `360 ${tabId}: 押せない行の吹き出しは理由そのまま`, [bTip.text, bInfo.tip]);
        await page.waitForTimeout(400); // 吹き出しのフェードが終わってから撮る
        await shoot(page, `rowblocked-${tabId}-360-light-focus.png`);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        const bAfter = await page.locator(bSel).first().evaluate(sw => ({ label: sw.getAttribute('aria-label') ?? '', checked: sw.getAttribute('aria-checked') }));
        check(bAfter.label === bInfo.label && bAfter.checked === bInfo.checked, `360 ${tabId}: 押せない行は Enter を押しても切り替わらない`, [bInfo, bAfter]);
        await page.keyboard.press('Escape');
      }

      // ---- 鍵つきでオンが残る行（変えられるオンだけ外した後）
      const count = await page.locator(lockSwSel(tabId)).count();
      console.log(`3b 360 ${tabId}: 鍵つきでオンが残る行 ${count} 行`);
      check(count > 0, `360 ${tabId}: 鍵つきでオンが残る行がある（4 タブすべてで確かめる）`, count);
      lockedTabs[360].push(tabId);
      await page.locator(lockSwSel(tabId)).first().scrollIntoViewIfNeeded();
      const rowSel = await rowSelOf(page.locator(lockSwSel(tabId)).first());
      const nth = () => page.locator(`#cx-panel-${tabId} ${rowSel}`).first();
      const labelOf = () => nth().getAttribute('aria-label');
      const geo = await nth().evaluate(sw => {
        const lk = sw.querySelector(':scope > .lk[data-tip-pass]');
        const s = sw.getBoundingClientRect(), l = lk.getBoundingClientRect();
        const hit = (x, y) => { const e = document.elementFromPoint(x, y); return !e ? 'none' : lk.contains(e) ? 'lk' : sw.contains(e) ? 'sw' : 'other'; };
        const zone = { x0: l.left - 4, x1: l.right, y0: l.top, y1: l.bottom + 1 };
        const box = { x0: s.left - 5, x1: s.right + 5, y0: s.top - 12, y1: s.bottom + 12 };
        const bad = { glyphNotLk: 0, lkOutsideZone: 0, zoneNotLk: 0 }, counts = { sw: 0, lk: 0, other: 0, none: 0 };
        const ext = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9 };
        for (let x = Math.floor(box.x0); x < box.x1; x++) {
          for (let y = Math.floor(box.y0); y < box.y1; y++) {
            const h = hit(x + 0.5, y + 0.5);
            counts[h]++;
            if (h === 'lk') { ext.x0 = Math.min(ext.x0, x + 0.5); ext.x1 = Math.max(ext.x1, x + 0.5); ext.y0 = Math.min(ext.y0, y + 0.5); ext.y1 = Math.max(ext.y1, y + 0.5); }
            const inGlyph = x + 0.5 >= l.left && x + 0.5 < l.right && y + 0.5 >= l.top && y + 0.5 < l.bottom;
            // 当たりは画素に丸められるので、周りの 16×13 から 1px のずれまでは許す（外へ 1px 広げた枠の外・内へ 1px 縮めた枠の内で数える）
            const inLoose = x + 0.5 >= zone.x0 - 1 && x + 0.5 < zone.x1 + 1 && y + 0.5 >= zone.y0 - 1 && y + 0.5 < zone.y1 + 1;
            const inTight = x + 0.5 >= zone.x0 + 1 && x + 0.5 < zone.x1 - 1 && y + 0.5 >= zone.y0 + 1 && y + 0.5 < zone.y1 - 1;
            if (inGlyph && h !== 'lk') bad.glyphNotLk++;
            if (h === 'lk' && !inLoose) bad.lkOutsideZone++;
            if (inTight && h !== 'lk') bad.zoneNotLk++;
          }
        }
        const pt = (dx, dy) => ({ x: s.left + dx, y: s.top + dy });
        const pts = {
          center: pt(s.width / 2, s.height / 2),
          leftEdge: pt(-3, s.height / 2),
          topEdge: pt(s.width / 2, -8),
          aboveGlyph: pt(s.width - 5, s.height - 3),
          leftOfGlyph: pt(s.width - 22, s.height + 8),
        };
        const kinds = Object.fromEntries(Object.entries(pts).map(([k, p]) => [k, hit(p.x, p.y)]));
        return { s: { x: s.left, y: s.top, w: s.width, h: s.height }, l: { x: l.left, y: l.top, w: l.width, h: l.height }, zone, ext, bad, counts, pts, kinds, lkCenter: { x: l.left + l.width / 2, y: l.top + l.height / 2 }, tip: lk.dataset.tip };
      });
      check(geo.bad.glyphNotLk === 0 && geo.bad.lkOutsideZone === 0 && geo.bad.zoneNotLk === 0, `360 ${tabId}: 鍵の当たりは鍵の周り（16×13）だけで、スイッチの押せる面と重ならない`, geo);
      check(Object.values(geo.kinds).every(k => k === 'sw'), `360 ${tabId}: スイッチの中央・端（上・左・鍵のすぐ上・鍵のすぐ左下）は、鍵ではなくスイッチへ当たる`, geo.kinds);
      const before = await labelOf();
      // 押した直後は保存・読み直しで行が何度か描き直される。同じスイッチの要素が 4 回続けて（250ms ごと）変わらなくなってから次へ進む
      const settle = async () => {
        const sel = `#cx-panel-${tabId} ${rowSel}`;
        await page.evaluate(([s]) => { window.__swRef = document.querySelector(s); }, [sel]);
        for (let i = 0, stable = 0; stable < 4 && i < 60; i++) {
          await page.waitForTimeout(250);
          const same = await page.evaluate(([s]) => Boolean(window.__swRef) && document.querySelector(s) === window.__swRef, [sel]);
          if (same) stable++; else { stable = 0; await page.evaluate(([s]) => { window.__swRef = document.querySelector(s); }, [sel]); }
        }
      };
      // 行が描き直されて動くことがあるので、押す前に落ち着くのを待ち、今のスイッチの位置から押す点を測り直す
      const flip = async (where, from) => {
        await settle();
        await nth().scrollIntoViewIfNeeded();
        const at = await nth().evaluate((sw, w) => {
          const s = sw.getBoundingClientRect();
          const d = { center: [s.width / 2, s.height / 2], leftEdge: [-3, s.height / 2], topEdge: [s.width / 2, -8], aboveGlyph: [s.width - 5, s.height - 3] }[w];
          return { x: s.left + d[0], y: s.top + d[1] };
        }, where);
        await page.touchscreen.tap(at.x, at.y);
        const sel = `#cx-panel-${tabId} ${rowSel}`;
        let moved = false, asked = false;
        for (let i = 0; i < 40 && !moved; i++) {
          moved = await page.evaluate(([s, prev]) => { const e = document.querySelector(s); return Boolean(e) && e.getAttribute('aria-label') !== prev; }, [sel, from]);
          if (moved) break;
          // 広げる・Devin の取り込みが止まるときの行内確認（.cx-ask）が出たら、「実行する」を押して進める
          const ask = page.locator('#contextPanel .cx-ask .btn-primary');
          if (await ask.count()) { asked = true; await ask.first().tap(); } else await page.waitForTimeout(250);
        }
        if (!moved) {
          const diag = await page.evaluate(s => ({ clicks: window.__clicks.slice(-6), found: document.querySelectorAll(s).length, label: document.querySelector(s)?.getAttribute('aria-label'), html: document.querySelector(s)?.outerHTML?.slice(0, 400), status: document.querySelector('#contextPanel .cx-status')?.textContent ?? '', ask: document.querySelector('#contextPanel .cx-ask')?.textContent ?? '' }), sel);
          throw new Error(`360 ${tabId}: ${where} をタップしても切り替わらない ${JSON.stringify({ where, at, asked, diag })}`);
        }
        return labelOf();
      };
      let cur = await flip('center', before);
      check(cur !== before, `360 ${tabId}: スイッチの中央をタップすると切り替わる`, [before, cur]);
      cur = await flip('leftEdge', cur);
      check(cur === before, `360 ${tabId}: スイッチの左の端をタップすると切り替わり、もとへ戻る`, [before, cur]);
      cur = await flip('aboveGlyph', cur);
      check(cur !== before, `360 ${tabId}: スイッチの右下（鍵のすぐ上）の端をタップしても切り替わる（吹き出しだけが開かない）`, [before, cur]);
      const tipAfterSwitchTap = await lockTipFacts(page);
      check(!tipAfterSwitchTap.on, `360 ${tabId}: スイッチを押したときは吹き出しを開かない`, tipAfterSwitchTap);
      cur = await flip('topEdge', cur);
      check(cur === before, `360 ${tabId}: スイッチの上の端をタップするともとへ戻る`, [before, cur]);
      // 鍵をタップ: 吹き出しが開き、切り替えない。押した直後の保存・描き直しが落ち着いてから押す（描き直しで鍵の要素が差し替わると吹き出しは閉じる）
      await settle();
      await nth().scrollIntoViewIfNeeded();
      const lkNow = await nth().evaluate(sw => { const r = sw.querySelector(':scope > .lk[data-tip-pass]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.touchscreen.tap(lkNow.x, lkNow.y);
      await page.waitForFunction(() => document.querySelector('.cx-tip.on'), null, { timeout: 3000 });
      await page.waitForTimeout(400);
      check((await labelOf()) === before, `360 ${tabId}: 鍵をタップしても切り替わらない`, await labelOf());
      const touchTip = await lockTipFacts(page);
      lockTipSane(touchTip, `360 ${tabId}（タッチ）`);
      check(touchTip.text.replace(/\s+/g, ' ').trim().length > 0 && geo.tip === touchTip.text, `360 ${tabId}（タッチ）: 吹き出しの文は鍵の理由そのまま`, [geo.tip, touchTip.text]);
      await shoot(page, `rowlock-${tabId}-360-light-touch.png`);
      // 外を押して消す → キーボード（Tab）で行のスイッチへ届いたときも、同じ吹き出しが開く
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.cx-tip.on'), null, { timeout: 3000 });
      const reached = await tabToSwitch(page, tabId, `#cx-panel-${tabId} ${rowSel}`);
      check(reached, `360 ${tabId}: Tab で行のスイッチへ届く`);
      await page.waitForFunction(() => document.querySelector('.cx-tip.on'), null, { timeout: 3000 });
      const focusTip = await lockTipFacts(page);
      lockTipSane(focusTip, `360 ${tabId}（focus）`);
      check(focusTip.text === touchTip.text, `360 ${tabId}: focus で開く吹き出しはタッチと同じ文`, [focusTip.text, touchTip.text]);
      await page.waitForTimeout(400);
      await shoot(page, `rowlock-${tabId}-360-light-focus.png`);
      await page.keyboard.press('Escape');
      const over = await page.evaluate(() => ({ pageOver: document.documentElement.scrollWidth > innerWidth, scOver: (sc => sc.scrollWidth > sc.clientWidth)(document.querySelector('.settings-content')) }));
      check(!over.pageOver && !over.scOver, `360 ${tabId}: 吹き出しを開いても横にはみ出さない`, over);
    }
    await tctx.close();
  }
  // ---- 1280 幅・マウスのホバー
  {
    const hctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'light', locale: 'ja-JP' });
    const page = await hctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(lkUrl, { waitUntil: 'load' });
    await openSettingsContext(page, 'instruction');
    for (const tabId of TAB_IDS) {
      await gotoTab(page, tabId);
      const count = await page.locator(lockSwSel(tabId)).count();
      console.log(`3b 1280 ${tabId}: 鍵つきでオンが残る行 ${count} 行`);
      check(count > 0, `1280 ${tabId}: 鍵つきでオンが残る行がある（4 タブすべてで確かめる）`, count);
      lockedTabs[1280].push(tabId);
      const lk = page.locator(`${lockSwSel(tabId)} > .lk[data-tip-pass]`).first();
      await lk.scrollIntoViewIfNeeded();
      await lk.hover();
      await page.waitForFunction(() => document.querySelector('.cx-tip.on'), null, { timeout: 3000 });
      const f = await lockTipFacts(page);
      lockTipSane(f, `1280 ${tabId}（ホバー）`);
      await page.waitForTimeout(400);
      await shoot(page, `rowlock-${tabId}-1280-light-hover.png`);
      await page.mouse.move(2, 2);
    }
    await hctx.close();
  }
  console.log(`3b 鍵の吹き出しを確かめたタブ: 360 = ${lockedTabs[360].join(',')} / 1280 = ${lockedTabs[1280].join(',')} / 押せない行: ${blockedTabs.join(',')}`);
  check(TAB_IDS.every(id => lockedTabs[360].includes(id) && lockedTabs[1280].includes(id)), '3b 鍵の吹き出しを 4 タブすべて（360・1280）で確かめた', lockedTabs);
  check(blockedTabs.length > 0, '3b 押せない行（鍵つきのオンだけで戻し先も無い行）のキーボード・理由を確かめた', blockedTabs);

  // ==================== 4. Devin の自分の名前（ADR 0336） ====================
  // 別のデータ置き場・home・Devin の設定の置き場（DEVIN_CONFIG_HOME）で、偽の Devin を使うサーバーを立てる。
  // devBoth は Claude と Devin の設定に、wsdup は Devin のユーザーの設定と作業場所（repoD/.devin）の両方にある
  const dvRoot = path.join(dataDir, 'devin-part');
  const dvHome = path.join(dvRoot, 'home'), dvConf = path.join(dvRoot, 'devin-config'), repoD = path.join(dvRoot, 'repoD');
  write(path.join(dvHome, '.claude.json'), JSON.stringify({ mcpServers: { devBoth: { command: 'both-cmd' } } }));
  write(path.join(dvConf, 'devin', 'mcp_config.json'), JSON.stringify({ mcpServers: { devBoth: { command: 'both-devin' }, wsdup: { command: 'wsdup-user' } } }));
  fs.mkdirSync(repoD, { recursive: true });
  execFileSync('git', ['init', '--quiet', repoD]);
  write(path.join(repoD, '.devin', 'mcp_config.json'), JSON.stringify({ mcpServers: { wsdup: { command: 'wsdup-ws' } } }));
  const dvBins = Object.fromEntries(['CLAUDE', 'CODEX', 'AGY', 'OPENCODE', 'GROK'].map(n => [`AGENT_HOST_${n}_BIN`, path.join(dvRoot, `no-such-${n.toLowerCase()}.exe`)]));
  const dvEnv = extra => ({
    AGENT_HOST_BACKENDS: 'fake,claude,devin', USERPROFILE: dvHome, HOME: dvHome,
    CLAUDE_CONFIG_DIR: path.join(dvHome, '.claude'), CODEX_HOME: path.join(dvHome, '.codex'), DEVIN_CONFIG_HOME: dvConf,
    // 一覧の探索の home（tests/lib/server.mjs は既定でデータ置き場の scan-home にする）。Claude の .claude.json を出どころにして、Devin を外しても行が残るようにする
    PLEIAD_SCAN_HOME: dvHome,
    AGENT_HOST_DEVIN_BIN: `node "${path.join(ROOT, 'tests/lib/fake-devin.mjs')}"`, ...dvBins, ...extra,
  });
  const dvRow = (page, name) => page.locator(`#contextPanel [data-kind=mcp] .cx-row[data-key="${name}"]`);
  const dvCell = (page, name) => dvRow(page, name).locator('.cx-ag[data-agent="devin"]');
  // 指示・Skills は 0 件なので、openSettingsContext（3 つの件数を待つ）ではなく、外部 MCP のタブと Devin のアイコンを待つ
  const openDevinList = async page => {
    await page.waitForSelector('#settings', { state: 'attached', timeout: 15000 });
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => {
        document.getElementById('onboardingDialog')?.close();
        if (!document.body.classList.contains('settings')) document.getElementById('settings')?.click();
        // 開いたままのときは開き直さない（外部 MCP の一覧が届く前に開き直すと、取り直しが始まってしまう）。
        // ただし、サーバーにつながる前に開いて読めなかったとき（「未接続」）は、開き直して読み直す（main の試験の動きと同じ）
        const panel = document.getElementById('contextPanel');
        const failed = !!panel?.querySelector('.cx-status')?.textContent && !panel.querySelector('[data-kind=mcp] .cx-row');
        if (panel?.hidden !== false || failed) document.getElementById('openContext')?.click();
        document.getElementById('cx-tab-mcp')?.click();
      });
      if (await dvCell(page, 'devBoth').waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) return;
    }
    const diag = await page.evaluate(() => ({
      bodyClass: document.body.className,
      panelHidden: document.getElementById('contextPanel')?.hidden ?? null,
      status: document.getElementById('contextPanel')?.querySelector('.cx-status')?.textContent ?? null,
      text: document.getElementById('contextPanel')?.innerText?.slice(0, 300) ?? null,
    })).catch(() => null);
    throw new Error(`openDevinList timed out ${JSON.stringify({ diag, errors })}`);
  };
  const dvServers = [];
  const dvClients = [];
  try {
    // ---- 4a. リンクを作れる PC: Devin の自分の名前のアイコンは押せる。off → 保存 → 読み込み直しても off → on に戻す
    const dvServer = await startServer({ dataDir: path.join(dvRoot, 'data'), env: dvEnv({}) });
    dvServers.push(dvServer);
    const dvClient = await open({ ...dvServer, autoAllow: true });
    dvClients.push(dvClient);
    await dvClient.cmd('onboardingSeen');
    const dvUrl = `http://127.0.0.1:${dvServer.port}/?token=${dvServer.token}`;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(dvUrl, { waitUntil: 'load' });
    await openDevinList(page);
    const cell = dvCell(page, 'devBoth');
    check(await cell.getAttribute('aria-disabled') === null && await cell.locator('.lk').count() === 0 && await cell.getAttribute('aria-pressed') === 'true',
      'Devin の自分の名前のアイコンは鍵が無く押せる（初めは on）', { disabled: await cell.getAttribute('aria-disabled'), pressed: await cell.getAttribute('aria-pressed') });
    await cell.click();
    await page.waitForFunction(() => document.querySelector('#contextPanel [data-kind=mcp] .cx-row[data-key="devBoth"] .cx-ag[data-agent="devin"]')?.getAttribute('aria-pressed') === 'false', null, { timeout: 10000 }).catch(async e => { console.log('ROW', await dvRow(page, 'devBoth').evaluate(r => r.outerHTML).catch(() => 'none')); throw e; });
    const offSaved = async () => {
      const m = await dvClient.cmd('mcpMatrix', { cwd: dvHome });
      return m.rows.find(r => r.key === 'devBoth')?.cells?.devin?.state;
    };
    let saved;
    for (let i = 0; i < 40 && (saved = await offSaved()) !== 'off'; i++) await new Promise(r => setTimeout(r, 250));
    check(saved === 'off', 'Devin のアイコンを押すと off になり、保存される（サーバーの一覧も off）', saved);
    await page.reload({ waitUntil: 'load' });
    await openDevinList(page);
    check(await dvCell(page, 'devBoth').getAttribute('aria-pressed') === 'false' && await dvRow(page, 'devBoth').locator('.cx-ag[data-agent="claude"]').getAttribute('aria-pressed') === 'true',
      '読み込み直しても Devin は off のまま（Claude は on のまま）');
    await dvCell(page, 'devBoth').click();
    await page.waitForFunction(() => document.querySelector('#contextPanel [data-kind=mcp] .cx-row[data-key="devBoth"] .cx-ag[data-agent="devin"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 10000 });
    for (let i = 0; i < 40 && (saved = await offSaved()) !== 'on'; i++) await new Promise(r => setTimeout(r, 250));
    check(saved === 'on', 'もう一度押すと on に戻り、保存される', saved);

    // ---- 4b. 会話の右パネル: 作業場所にも定義がある名前（wsdup）を Devin で off にした会話。Devin は作業場所の定義を自分で読むので止められない
    const wsReason = 'Devin が作業場所から直接読むため、Pleiad からは止められません';
    const wsRowSel = '.file-preview-content .scx .scx-item';
    const nameOf = (r) => r.querySelector('.t > div')?.textContent;
    const openSessionPanel = async (sessionId) => {
      await page.reload({ waitUntil: 'load' });
      await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
      await page.waitForSelector(`[data-session="${sessionId}"]`, { state: 'visible', timeout: 15000 });
      await page.locator(`[data-session="${sessionId}"]`).first().click();
      await page.setViewportSize({ width: 700, height: 900 });
      await page.locator('#sessionMore').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('#sessionMore').click();
      await page.getByRole('menuitem', { name: /プラグイン/ }).click();
      await page.waitForFunction(sel => [...document.querySelectorAll(sel)].some(r => r.querySelector('.t > div')?.textContent === 'wsdup' && r.querySelector('.cx-ag[aria-disabled="true"]')), wsRowSel, { timeout: 15000 })
        .catch(async e => { console.log('PANEL', await page.evaluate(() => document.querySelector('.file-preview-content')?.innerText ?? 'none')); throw e; });
      await page.setViewportSize({ width: 1280, height: 900 });
    };
    const wsRowOf = () => page.locator(wsRowSel).filter({ has: page.locator('.cx-ag[aria-disabled="true"]') }).filter({ hasText: /wsdup/ }).first();
    const lockFacts = async (row) => {
      const lock = row.locator('.cx-ag[aria-disabled="true"]');
      return {
        name: await row.evaluate(nameOf),
        dot: await row.locator('.cx-dot').getAttribute('class'),
        sub: await row.locator('.p').first().innerText(),
        tip: await lock.getAttribute('data-tip'), aria: await lock.getAttribute('aria-label'), title: await lock.getAttribute('title'),
        glyph: await lock.locator('.lk').count(), agent: await lock.getAttribute('data-agent'),
      };
    };
    const lockOk = f => f.name === 'wsdup' && f.agent === 'devin' && f.glyph === 1 && f.tip === wsReason && f.aria === `Devin で wsdup を使う（${wsReason}）` && !f.title;
    const hoverTip = async (row, label) => {
      await row.locator('.cx-ag[aria-disabled="true"]').hover();
      await page.waitForSelector('.cx-tip.on', { state: 'visible', timeout: 2000 });
      check((await page.locator('.cx-tip.on').innerText()).includes(wsReason), label);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.cx-tip.on'), null, { timeout: 2000 });
    };

    // 4b-1. 止められなかった名前しか無い会話: 中継も止める名前も無いのでエージェント任せの道（記録の unstopped だけ残す）。
    // エージェント任せの一覧の wsdup の行の右端に、設定の一覧と同じ鍵。ほかの行（devBoth）には付けない
    await dvClient.cmd('setMcpAgent', { name: 'wsdup', agent: 'devin', on: false, cwd: dvHome });
    const turn = await dvClient.runTurn({ backend: 'devin', cwd: repoD, prompt: 'hello', model: 'swe-2-medium' }, { ms: 60000 });
    check(turn.outcome === 'ok', '偽の Devin で会話を 1 ターン進める', turn.outcome);
    const rec1 = await dvClient.cmd('sessionContext', { sessionId: turn.sessionId });
    check(rec1.report.status === 'native' && JSON.stringify(rec1.report.unstopped) === JSON.stringify([{ name: 'wsdup', nativeLock: 'workspace' }]),
      'エージェント任せの記録に、止められなかった名前（wsdup / workspace）を残す', rec1.report);
    await openSessionPanel(turn.sessionId);
    const n1 = await lockFacts(wsRowOf());
    check(lockOk(n1) && /\boff\b/.test(n1.dot) && n1.sub.includes('mcp_config.json'),
      '右パネル（エージェント任せの一覧）: wsdup の行に一覧と同じ鍵つきの Devin のアイコン（吹き出しの文・読み上げ名・title 無し）。点と下段のパスは今のまま', n1);
    const others = await page.locator(wsRowSel).evaluateAll(rows => rows.filter(r => r.querySelector('.t > div')?.textContent === 'devBoth').map(r => r.querySelectorAll('.cx-ag').length));
    check(others.length > 0 && others.every(n => n === 0), '右パネル（エージェント任せの一覧）: off にしていない名前（devBoth）には鍵を付けない', others);
    await hoverTip(wsRowOf(), '右パネル（エージェント任せの一覧）: 鍵のアイコンへ載せると workspace の理由の吹き出しが出る');

    // 4b-2. 止める名前（devBoth）もある会話: Pleiad が解いた記録のまま。wsdup の行は「つながっている」点・理由の文・同じ鍵
    await dvClient.cmd('setMcpAgent', { name: 'devBoth', agent: 'devin', on: false, cwd: dvHome });
    const turn2 = await dvClient.runTurn({ backend: 'devin', cwd: repoD, prompt: 'hello', model: 'swe-2-medium' }, { ms: 60000 });
    check(turn2.outcome === 'ok', '偽の Devin で、止める名前のある会話を 1 ターン進める', turn2.outcome);
    await openSessionPanel(turn2.sessionId);
    const n2 = await lockFacts(wsRowOf());
    check(lockOk(n2) && /\bon\b/.test(n2.dot) && n2.sub.includes('このエージェント自身の設定にあるので'),
      '右パネル（Pleiad の一覧）: off なのに止められなかった行は、点が on・下段にエージェントが自分で読む理由・一覧と同じ鍵', n2);
    await hoverTip(wsRowOf(), '右パネル（Pleiad の一覧）: 鍵のアイコンへ載せると workspace の理由の吹き出しが出る');
    await dvClient.cmd('setMcpAgent', { name: 'devBoth', agent: 'devin', on: true, cwd: dvHome });
    await ctx.close();
    dvClient.close();
    dvClients.length = 0;
    await dvServer.stop();
    dvServers.length = 0;

    // ---- 4c. リンクを作れない PC（AGENT_HOST_FAKE_NO_LINKS=1）: Devin の自分の名前は鍵（nolinks）と理由の文
    const nlServer = await startServer({ dataDir: path.join(dvRoot, 'data-nolinks'), env: dvEnv({ AGENT_HOST_FAKE_NO_LINKS: '1' }) });
    dvServers.push(nlServer);
    const nlClient = await open({ ...nlServer, autoAllow: true });
    dvClients.push(nlClient);
    await nlClient.cmd('onboardingSeen');
    const nlCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', locale: 'ja-JP' });
    const nlPage = await nlCtx.newPage();
    nlPage.on('pageerror', e => errors.push(e.message));
    await nlPage.goto(`http://127.0.0.1:${nlServer.port}/?token=${nlServer.token}`, { waitUntil: 'load' });
    await openDevinList(nlPage);
    const nlReason = 'Windows の開発者モードがオフのため、Pleiad からは止められません';
    const nl = dvCell(nlPage, 'devBoth');
    const nlFacts = { disabled: await nl.getAttribute('aria-disabled'), tip: await nl.getAttribute('data-tip'), aria: await nl.getAttribute('aria-label'), title: await nl.getAttribute('title'), glyph: await nl.locator('.lk').count(), pressed: await nl.getAttribute('aria-pressed') };
    check(nlFacts.disabled === 'true' && nlFacts.glyph === 1 && nlFacts.tip === nlReason && nlFacts.aria === `Devin で devBoth を使う（${nlReason}）` && !nlFacts.title,
      'リンクを作れない PC: Devin の自分の名前は鍵つきで押せず、理由は nolinks の文（読み上げ名にも入る）', nlFacts);
    await nl.hover();
    await nlPage.waitForSelector('.cx-tip.on', { state: 'visible', timeout: 2000 });
    check((await nlPage.locator('.cx-tip.on').innerText()).includes(nlReason), 'リンクを作れない PC: 鍵へ載せると nolinks の理由の吹き出しが出る');
    await nl.click({ force: true });
    await nlPage.waitForSelector('.cx-tip.on', { state: 'visible', timeout: 2000 });
    check(await nl.getAttribute('aria-pressed') === nlFacts.pressed, 'リンクを作れない PC: 鍵のアイコンを押しても状態は変わらない');
    check(await dvRow(nlPage, 'devBoth').locator('.cx-ag[data-agent="claude"]').getAttribute('aria-disabled') === null, 'リンクを作れない PC でも、Claude のアイコンは押せるまま');
    await nlCtx.close();
  } finally {
    for (const c of dvClients) c.close();
    for (const s of dvServers) await s.stop().catch(() => {});
  }

  check(errors.length === 0, 'ページ例外（pageerror）が出ない', errors);
  console.log(`PASS: ${results.length} 判定すべて通過`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (client) client.close();
  if (lkClient) lkClient.close();
  if (server) await server.stop().catch(() => {});
  if (lkServer) await lkServer.stop().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
}
