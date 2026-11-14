// 設定 › プラグインと会話の右パネル（段 1）のブラウザ統合テスト:
//   - 4 タブ・件数・スクロール追従（sticky）・タブ切替時の先頭戻しと記憶・キーボード操作
//   - フォルダーまとまり（>8 折りたたみ・展開後の親ロゴ/パス非重複・mixed 一括切替）
//   - Skills 絞り込み（入力フォーカス維持・自動展開・0 件表示・Escape 解除）
//   - 鍵の吹き出し（静的な凡例行なし・ホバー・フォーカス・タップ・Escape・スクロール非表示・title 無し・aria-disabled）
//   - 1280 / 360・ライト / ダークで横はみ出し無し・押し先サイズ確保
//   - Devin の自分の名前（ADR 0335）: 一覧の Devin のアイコンを off → 読み込み直しても off → on に戻す・
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

let server, client, browser;
try {
  // ユーザー側（設定 › プラグインで表示）: CLAUDE.md + 9 rules + 9 .claude/skills + 2 .agents/skills + MCP + Hook
  write(path.join(home, '.claude/CLAUDE.md'), '# User Instructions\nAlways be concise.\n');
  for (let i = 0; i < 9; i++) {
    write(path.join(home, `.claude/rules/sec/rule-${i}.md`), `# Security rule ${i}\nCheck input ${i}.\n`);
  }
  for (let i = 0; i < 9; i++) {
    write(path.join(home, `.claude/skills/u-skill-${i}/SKILL.md`), `---\nname: u-skill-${i}\ndescription: User skill ${i}\n---\n# u-skill-${i}\n`);
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

  // リポジトリ側（会話の右パネルで表示）: AGENTS.md + 9 rules + 9 .claude/skills + .mcp.json
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--quiet', repo]);
  write(path.join(repo, 'AGENTS.md'), '# Repo Instructions\nFollow test rules.\n');
  for (let i = 0; i < 9; i++) {
    write(path.join(repo, `.claude/rules/arch/r-${i}.md`), `# Arch rule ${i}\nLayering ${i}.\n`);
  }
  for (let i = 0; i < 9; i++) {
    write(path.join(repo, `.claude/skills/r-skill-${i}/SKILL.md`), `---\nname: r-skill-${i}\ndescription: Repo skill ${i}\n---\n# r-skill-${i}\n`);
  }
  write(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { repoMcp: { command: 'repo-cmd' } } }));

  const bins = Object.fromEntries(['CLAUDE', 'CODEX', 'AGY', 'OPENCODE', 'DEVIN', 'GROK'].map(n => [`AGENT_HOST_${n}_BIN`, path.join(dataDir, `no-such-${n.toLowerCase()}.exe`)]));
  server = await startServer({
    dataDir: path.join(dataDir, 'data'),
    env: {
      AGENT_HOST_BACKENDS: 'fake,claude,codex,antigravity,opencode,devin,grok',
      USERPROFILE: home, HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      AGENT_HOST_GROK_HOME: path.join(home, '.grok'),
      ...bins,
      AGENT_HOST_GROK_BIN: grokStub,
    },
  });

  client = await open({ ...server, autoAllow: true });
  await client.cmd('onboardingSeen');
  await client.cmd('savePlyMcp', { name: 'reg', mode: 'add', value: { transport: 'stdio', command: 'reg-cmd', args: [] } });
  const tier = { sources: ['common', 'claude', 'codex'], excludePaths: [] };
  for (const kind of ['instruction', 'skill']) {
    await client.cmd('setContextSettings', { cwd: repo, place: null, kind, value: { owner: 'ply', user: tier, directory: tier } });
  }
  const managed = await client.cmd('newSession', { cwd: repo, backend: 'fake' });
  await client.runTurn({ ...managed, prompt: 'echo:プラグイン画面を確認' });
  for (const kind of ['instruction', 'skill', 'mcp']) {
    await client.cmd('setContextSettings', { cwd: repo, place: repo, kind, value: { owner: 'ply', user: tier, directory: tier } });
  }

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
        // 指示・Skills・外部 MCP の件数がそろうまで待つ（探索・外部 MCP は遅れて届く。Hooks は担当がエージェントに任せるので件数を出さない）
        const counted = ['instruction', 'skill', 'mcp'].every(id => {
          const cnt = document.querySelector(`#cx-tab-${id} .c`);
          return cnt && !cnt.hidden && Number(cnt.textContent) > 0;
        });
        return document.body.classList.contains('settings') && r && r.height > 0 && counted;
      }, { timeout: 1500 }).then(() => true, () => false);
      if (ready) return;
    }
    throw new Error('openSettingsContext timed out');
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
    check(tabs[0].selected === 'true' && Number(tabs[0].cnt) >= 10 && Number(tabs[1].cnt) >= 11 && Number(tabs[2].cnt) >= 3 && !tabs[3].cnt, '件数バッジが出る（担当がエージェントに任せる Hooks は件数を出さない）', tabs);
    check(await page.locator('#cx-panel-mcp #cliSetup').count() === 1, '「外の AI から Pleiad を使う」は外部 MCP タブの中に入る');
    check(await page.locator('#cx-panel-instruction #cxInstructionBudget').count() === 1 && await page.locator('#cx-panel-instruction .cx-seg').count() >= 1, '段 2・3 までの担当 2 択と量の目安を保つ');

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
    const grp = page.locator('#cx-panel-instruction .cx-row.grp', { hasText: 'rules' });
    check((await grp.locator('.cx-tw').getAttribute('aria-expanded')) === 'false', '8 件超の rules まとまりは最初閉じている');
    check((await page.locator('#cx-panel-instruction .cx-row.kid').count()) === 0, '閉じた rules の子は出ていない');
    await grp.locator('.cx-tw').click();
    const kids = page.locator('#cx-panel-instruction .cx-row.kid');
    check((await kids.count()) === 9, 'rules まとまりを開くと 9 件の子行が出る', await kids.count());
    check((await kids.locator('.cx-src').count()) === 0, 'まとまり内の子行には出どころのロゴを繰り返さない');

    await kids.first().locator('.cx-sw').click();
    await page.waitForFunction(() => document.querySelector('#cx-panel-instruction .cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'mixed', { timeout: 10000 });
    const mixSw = grp.locator('.cx-sw');
    check((await mixSw.getAttribute('role')) === 'checkbox' && (await mixSw.getAttribute('aria-label')).includes('8'), '子 1 つオフでまとまりスイッチが checkbox mixed＋一部ラベルになる', await mixSw.getAttribute('aria-label'));

    await mixSw.click();
    await page.waitForFunction(() => document.querySelector('#cx-panel-instruction .cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'true', { timeout: 10000 });
    check(true, 'mixed スイッチ押下でまとめて有効へ戻る');

    // Skills タブ + 絞り込み欄
    await page.locator('#cx-tab-skill').click();
    await page.waitForFunction(() => document.querySelectorAll('#cx-panel-skill .cx-row.grp').length >= 2, { timeout: 10000 });
    const skillGrps = await page.locator('#cx-panel-skill .cx-row.grp').evaluateAll(els => els.map(e => ({
      text: e.innerText.replace(/\s+/g, ' ').trim(),
      expanded: e.querySelector('.cx-tw')?.getAttribute('aria-expanded'),
    })));
    const grp9 = skillGrps.find(g => /\.claude[\\/]skills/.test(g.text) && /\b9\b/.test(g.text));
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

    // 絞り込み中のまとまりスイッチは、見えている（当たった）行だけを切り替える
    const userSkillExcludes = async () => {
      const v = await client.cmd('contextSettings', {});
      return v.defaults.kinds.skill.value.user.excludePaths.length;
    };
    check((await userSkillExcludes()) === 0, '絞り込みの前は Skills の除外が 0 件');
    await findInput.fill('u-skill-1');
    await page.waitForFunction(() => document.querySelectorAll('#cx-panel-skill .cx-row.kid').length === 1, { timeout: 5000 });
    const filteredGrp = page.locator('#cx-panel-skill .cx-row.grp');
    check((await filteredGrp.count()) === 1 && (await filteredGrp.locator('.cx-sw').getAttribute('aria-checked')) === 'true', '絞り込み中のまとまりスイッチは見えている行だけからオンと決まる');
    await filteredGrp.locator('.cx-sw').click();
    await page.waitForFunction(() => document.querySelector('#cx-panel-skill .cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'false', { timeout: 10000 });
    check((await userSkillExcludes()) === 1, '絞り込み中のまとまりスイッチで、当たった 1 件だけが除外に入る（9 件ではない）');
    await findInput.press('Escape');
    await page.waitForFunction(() => [...document.querySelectorAll('#cx-panel-skill .cx-row.grp .cx-sw')].some(s => s.getAttribute('aria-checked') === 'mixed'), { timeout: 5000 });
    check(true, '絞り込みを消すとまとまり全体の状態（一部）に戻る');
    await page.locator('#cx-panel-skill .cx-row.grp .cx-sw[aria-checked="mixed"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#cx-panel-skill .cx-row.grp .cx-sw')].every(s => s.getAttribute('aria-checked') === 'true'), { timeout: 10000 });
    check((await userSkillExcludes()) === 0, 'まとまりスイッチで除外が 0 件に戻る');

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
    await page.waitForFunction(() => Number(document.querySelector('#scx-tab-instruction .c')?.textContent) >= 10, { timeout: 15000 });
    const scxTabs = await page.locator('.file-preview-content .scx .cx-tabs [role="tab"]').evaluateAll(els =>
      els.map(e => ({ id: e.dataset.tab, cnt: e.querySelector('.c')?.textContent })));
    check(scxTabs.map(x => x.id).join(',') === 'instruction,skill,mcp,hooks' && Number(scxTabs[0].cnt) >= 10 && Number(scxTabs[1].cnt) >= 9,
      '右パネル「この場所だけ変える」に入ると 4 タブ・件数が出る', scxTabs);

    // 右パネルの 9 件 rules まとまり（リポジトリ dir tier）の開閉と mixed 一括切替
    const scxArchGrp = page.locator('#scx-panel-instruction .cx-row.grp', { hasText: 'rules' }).last();
    await scxArchGrp.locator('.cx-tw').click();
    const scxKids = page.locator('#scx-panel-instruction .cx-row.kid');
    check((await scxKids.count()) >= 9, '右パネルでも >8 のまとまりを開いて子行を出せる');
    await scxKids.first().locator('.cx-sw').click();
    await page.waitForFunction(() => {
      const grpSws = [...document.querySelectorAll('#scx-panel-instruction .cx-row.grp .cx-sw')];
      return grpSws.some(s => s.getAttribute('aria-checked') === 'mixed');
    }, { timeout: 10000 });
    await page.locator('#scx-panel-instruction .cx-row.grp .cx-sw[aria-checked="mixed"]').click();
    await page.waitForFunction(() => {
      const grpSws = [...document.querySelectorAll('#scx-panel-instruction .cx-row.grp .cx-sw')];
      return grpSws.every(s => s.getAttribute('aria-checked') === 'true');
    }, { timeout: 10000 });
    check(true, '右パネルでも一部オフで mixed になり、一括で元へ戻る');

    // 右パネルの sticky & Skills 絞り込み
    await page.locator('#scx-tab-skill').click();
    await page.waitForSelector('#scx-panel-skill .cx-find input', { state: 'visible', timeout: 10000 });
    const scxFind = page.locator('#scx-panel-skill .cx-find input');
    await scxFind.click();
    await scxFind.pressSequentially('r-skill-4');
    await page.waitForFunction(() => [...document.querySelectorAll('#scx-panel-skill .cx-row.kid .nm')].some(n => n.textContent === 'r-skill-4'), { timeout: 5000 });
    await scxFind.fill('no-right-skill-xyz');
    check((await page.locator('#scx-panel-skill').innerText()).includes('見つかりません'), '右パネル Skills でも 0 件で「見つかりません」が出る');
    await scxFind.press('Escape');
    check((await scxFind.inputValue()) === '', '右パネル Skills の Escape で入力が空に戻る');

    // 右パネルでも、絞り込み中のまとまりスイッチは当たった行だけを切り替える
    await scxFind.fill('r-skill-1');
    await page.waitForFunction(() => document.querySelectorAll('#scx-panel-skill .cx-row.kid').length === 1, { timeout: 5000 });
    const scxOnly = page.locator('#scx-panel-skill .cx-row.grp .cx-sw');
    check((await scxOnly.count()) === 1 && (await scxOnly.getAttribute('aria-checked')) === 'true', '右パネルの絞り込み中のスイッチは見えている行だけからオンと決まる');
    await scxOnly.click();
    await page.waitForFunction(() => document.querySelector('#scx-panel-skill .cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'false', { timeout: 10000 });
    await scxFind.press('Escape');
    await page.waitForFunction(() => [...document.querySelectorAll('#scx-panel-skill .cx-row.grp .cx-sw')].some(s => s.getAttribute('aria-checked') === 'mixed'), { timeout: 5000 });
    check(true, '右パネルでも、絞り込み中の一括切替は当たった 1 件だけで、消すと「一部」に戻る');
    await page.locator('#scx-panel-skill .cx-row.grp .cx-sw[aria-checked="mixed"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#scx-panel-skill .cx-row.grp .cx-sw')].every(s => s.getAttribute('aria-checked') === 'true'), { timeout: 10000 });

    // ==================== 3. 360px 狭幅 & ダークモードの横はみ出し・サイズ検査 ====================
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 360, height: 760 });
      await page.waitForFunction(() => innerWidth === 360);
      const rpLayout = await page.evaluate(() => {
        const sc = document.querySelector('.file-preview-content');
        const tabH = Math.min(...[...document.querySelectorAll('.scx .cx-tab')].map(e => e.getBoundingClientRect().height));
        return { pageOver: document.documentElement.scrollWidth > innerWidth, scOver: sc.scrollWidth > sc.clientWidth, tabH };
      });
      check(!rpLayout.pageOver && !rpLayout.scOver && rpLayout.tabH >= 38, `360px ${scheme} 右パネル編集で横にはみ出さない`, rpLayout);

      await openSettingsContext(page, 'instruction');
      for (const tabId of ['instruction', 'skill', 'mcp', 'hooks']) {
        await page.locator(`#cx-tab-${tabId}`).click();
        await page.waitForFunction(id => document.getElementById(`cx-tab-${id}`)?.getAttribute('aria-selected') === 'true' && !document.getElementById(`cx-panel-${id}`)?.hidden, tabId, { timeout: 5000 });
        const sLayout = await page.evaluate(() => {
          const sc = document.querySelector('.settings-content');
          const tabH = Math.min(...[...document.querySelectorAll('#contextPanel .cx-tab')].map(e => e.getBoundingClientRect().height));
          const agSizes = [...document.querySelectorAll('#contextPanel [data-kind=mcp] .cx-ag')].filter(e => e.offsetParent).map(e => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height));
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

  // ==================== 4. Devin の自分の名前（ADR 0335） ====================
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
        document.getElementById('openContext')?.click();
        document.getElementById('cx-tab-mcp')?.click();
      });
      if (await dvCell(page, 'devBoth').waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) return;
    }
    throw new Error('openDevinList timed out');
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
  if (server) await server.stop().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
}
