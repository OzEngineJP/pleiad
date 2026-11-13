// 設定 › プラグイン › 外部 MCP の打鍵（実ブラウザー。承認済み 2026-11-14、ADR 0325・docs/design-system.md「設定 › 外部 MCP」）:
//   名前 × エージェントの一覧 → 全体のスイッチ → アイコン → 広げる前の確認 → 鍵 → コネクター（読み取り中・読めた後）→ キーボード。
//   ライト・ダーク・1280・360 で横にはみ出さない。
// 実行: node tests/browser/external-mcp.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる。EXTERNAL_MCP_SHOTS=<ディレクトリ> で場面ごとに撮る）
// 本物のサーバー（fake の身代わり・一時のデータ置き場と home・別ポート）だけと話す。実データ・実設定・実際の Claude には触れない
// （AGENT_HOST_CLAUDE_BIN を存在しない実行ファイルにして、コネクターの読み取りは必ず失敗させ、覚えの一覧だけを使う）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const SHOTS = process.env.EXTERNAL_MCP_SHOTS || '';
const results = [];
const check = (ok, label, detail) => { if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); results.push(label); };

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-extmcp-ui-'));
const home = path.join(dataDir, 'scan-home');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
let server, browser;
try {
  // 各エージェントの設定（テスト用の home）。Claude と Codex の両方にある both、Claude だけの cl、Codex だけの cx
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { cl: { command: 'cl-cmd' }, both: { command: 'both-cmd' } } }));
  write(path.join(home, '.codex/config.toml'), '[mcp_servers.cx]\nurl = "https://x.invalid/mcp"\n[mcp_servers.both]\ncommand = "both-cmd"\n');
  // Claude のプラグイン（有効）と、前に読めたコネクターの覚え
  const claudeHome = path.join(dataDir, 'claude-home'), inst = path.join(claudeHome, 'plugins', 'cache', 'notion');
  write(path.join(inst, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'Notion' }));
  write(path.join(inst, '.mcp.json'), JSON.stringify({ mcpServers: { notion: { type: 'http', url: 'https://x.invalid/mcp' } } }));
  write(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'notion@mk': [{ installPath: inst }] } }));
  write(path.join(dataDir, 'claude-connectors.json'), JSON.stringify({ connectors: ['Slack'], at: Date.now() }));

  // どのエージェントの実行ファイルも存在しないものにする（ロゴと一覧のためだけに有効にし、本物は起動しない）
  const bins = Object.fromEntries(['CLAUDE', 'CODEX', 'AGY', 'OPENCODE', 'DEVIN', 'GROK'].map(n => [`AGENT_HOST_${n}_BIN`, path.join(dataDir, `no-such-${n.toLowerCase()}.exe`)]));
  server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake,claude,codex,antigravity,opencode,devin,grok', USERPROFILE: home, HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: claudeHome, ...bins } });
  // Pleiad の登録 1 件（本物の操作で足す）
  const client = await open(server);
  await client.cmd('savePlyMcp', { name: 'reg', mode: 'add', value: { transport: 'stdio', command: 'reg-cmd', args: [] } });
  if (process.env.EXTERNAL_MCP_ROWS) console.log(fs.readdirSync(dataDir), JSON.stringify(await client.cmd('mcpMatrix', { cwd: home })).slice(-200));
  client.close();
  const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  browser = await chromium.launch({ executablePath: chromiumPath() });

  async function session({ width = 1280, scheme = 'light' } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height: 1400 }, colorScheme: scheme, locale: 'ja-JP' });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    // 設定の画面（body.settings）は歯車で開閉する。閉じているときだけ押し、使えるエージェントの確認で案内が重なったら閉じる
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        document.getElementById('onboardingDialog')?.close();
        if (!document.body.classList.contains('settings')) document.getElementById('settings')?.click();
        document.getElementById('openContext')?.click();
      });
      await page.waitForTimeout(500);
      if (await page.locator('#contextPanel [data-kind=mcp] .cx-sw').first().isVisible()) break;
    }
    await page.waitForSelector('#contextPanel [data-kind=mcp] .cx-sw', { state: 'visible', timeout: 20000 });
    if (process.env.EXTERNAL_MCP_DUMP) await page.screenshot({ path: process.env.EXTERNAL_MCP_DUMP, fullPage: true });
    if (process.env.EXTERNAL_MCP_DUMP) console.log(await page.locator('#contextPanel [data-kind=mcp]').evaluate(e => [...e.querySelectorAll('.cx-row')].map(r => `${r.className} :: ${r.innerText.split(String.fromCharCode(10)).join(' / ')}`).join(String.fromCharCode(10))));
    await page.waitForTimeout(600);
    if (process.env.EXTERNAL_MCP_DUMP) await page.screenshot({ path: process.env.EXTERNAL_MCP_DUMP.replace('.png', '-2.png') });
    return { ctx, page };
  }
  const card = '#contextPanel [data-kind=mcp]';
  const shot = async (page, name) => { if (SHOTS) {
    // 要素の screenshot は「安定するまで待つ」で固まることがあるので、枠を取って clip で撮る（animations は止めない）
    if (!(await page.locator(card).isVisible())) { await page.screenshot({ path: path.join(SHOTS, `external-mcp-hidden-${name}.png`) }); console.log('HIDDEN', name, await page.evaluate(() => document.getElementById('contextPanel')?.className + ' ' + document.getElementById('contextPanel')?.hidden + ' ' + document.body.className)); }
    await page.locator(card).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const box = await page.locator(card).boundingBox();
    await page.screenshot({ path: path.join(SHOTS, `external-mcp-${name}.png`), fullPage: true, animations: 'allow', clip: { x: Math.max(0, box.x - 8), y: box.y + await page.evaluate(() => scrollY) - 8, width: box.width + 16, height: box.height + 16 } });
  } };
  const row = (page, name) => page.locator(`${card} .cx-row.ag`, { has: page.locator('.nm', { hasText: new RegExp(`^${name}$`) }) });

  const { ctx, page } = await session();
  const text = await page.locator(card).innerText();
  check(!text.includes('エージェントに任せる') && !text.includes('Pleiad がそろえる'), '担当の 2 択は無い');
  check(text.includes('Pleiad に登録') && text.includes('エージェントの設定'), '2 つの組（Pleiad に登録・エージェントの設定）');
  if (process.env.EXTERNAL_MCP_ROWS) console.log(await page.locator(`${card} .cx-row`).evaluateAll(rs => rs.map(r => r.className + ' | ' + r.querySelector('.nm')?.textContent + ' | ' + r.innerText.length)));
  check(await row(page, 'reg').count() === 1 && await row(page, 'cl').count() === 1 && await row(page, 'cx').count() === 1, '名前ごとに 1 行（登録・Claude だけ・Codex だけ）');
  check(await row(page, 'both').locator('.cx-src[role=img]').count() === 1 && await row(page, 'both').locator('.cx-src .sm.be-claude, .cx-src .sm.be-codex').count() === 2 && await row(page, 'both').locator('.cx-src a, .cx-src button').count() === 0, 'Claude と Codex の設定にある名前は、出どころのロゴに両方が入る（1 つの img で、押せない）');
  check(await row(page, 'reg').locator('.cx-src').count() === 0, 'Pleiad に登録の行には Pleiad の印も出どころのロゴも無い（どのエージェントの設定にも無い）');
  check(await row(page, 'Slack').count() === 1 && await row(page, 'notion').count() === 1, 'コネクター（覚えの一覧）とプラグインの MCP も同じ一覧に出る');
  check((await row(page, 'notion').innerText()).includes('Notion のプラグイン'), 'プラグインの行は名前の下にプラグイン名');
  const slackCells = row(page, 'Slack').locator('.cx-ag');
  check(await slackCells.count() >= 1 && await row(page, 'Slack').locator('.cx-ag.na[aria-hidden=true]').count() >= 1 && await row(page, 'Slack').locator('.cx-ag.na[tabindex], .cx-ag.na button').count() === 0, 'コネクターは Claude だけ押せて、他の列は短い線（押せず、タブにも入らない）');
  check(text.includes('claude.ai のコネクター') && text.includes('Pleiad からは止められません'), '凡例は 1 つ（コネクターの雲・鍵）');
  await shot(page, 'light-1280');

  // 全体のスイッチ: 切ると全部 off、入れると前の並びに戻る
  const reg = row(page, 'reg'), sw = reg.locator('.cx-sw');
  check(await sw.getAttribute('aria-checked') === 'false', '任せるままだった登録は全部 off（今と同じ）');
  check(await reg.locator('.cx-ag button, button.cx-ag').count() === 0, '切れている名前にはアイコンは出ない（押せない）');
  await sw.click();
  await page.waitForTimeout(800);
  check(await row(page, 'reg').locator('.cx-ag[aria-pressed=true]').count() >= 1 && await row(page, 'reg').locator('.cx-sw').getAttribute('aria-checked') === 'true', '全体のスイッチを入れると、その名前が使えるエージェントに渡る');
  await row(page, 'reg').locator('.cx-ag[aria-pressed=true]').first().click();
  await page.waitForTimeout(800);
  check(await row(page, 'reg').locator('.cx-ag[aria-pressed=true]').count() >= 0, 'アイコンを外せる（確認なし）');
  await row(page, 'reg').locator('.cx-sw').evaluate(e => { if (e.getAttribute('aria-checked') !== 'true') e.click(); });
  await page.waitForTimeout(800);
  await row(page, 'reg').locator('.cx-sw').click();
  await page.waitForTimeout(800);
  check(await row(page, 'reg').locator('.cx-ag[aria-pressed=true]').count() === 0, '全体のスイッチを切ると全部 off');
  await row(page, 'reg').locator('.cx-sw').click();
  await page.waitForTimeout(800);
  check(await row(page, 'reg').locator('.cx-ag[aria-pressed=true]').count() >= 1, '入れると、切る前の並びに戻る');

  // 広げる前の確認: 他のエージェントの設定にだけある名前を別のエージェントで入れると、その場で 1 回聞く
  const cx = row(page, 'cx'), codexIdx = 1;
  await cx.locator('.cx-ag').nth(0).click();
  await page.waitForSelector(`${card} .cx-ask`, { timeout: 5000 });
  const ask = await page.locator(`${card} .cx-ask`).innerText();
  if (process.env.EXTERNAL_MCP_ROWS) console.log('ASK', JSON.stringify(ask));
  check(ask.includes('Codex の設定の cx を、Claude にもつなぎます') && ask.includes('やめる') && ask.includes('つなぐ'), '広げる前に「Codex の設定の cx を、Claude にもつなぎます」と聞く');
  await shot(page, 'ask');
  await page.locator(`${card} .cx-ask button`, { hasText: 'やめる' }).click();
  await page.waitForTimeout(400);
  check(await page.locator(`${card} .cx-ask`).count() === 0 && await row(page, 'cx').locator('.cx-ag[aria-pressed=true]').count() === 1, 'やめるなら何も変わらない（Codex の分だけ on）');
  await row(page, 'cx').locator('.cx-ag').nth(0).click();
  await page.locator(`${card} .cx-ask button`, { hasText: 'つなぐ' }).click();
  await page.waitForTimeout(800);
  check(await row(page, 'cx').locator('.cx-ag[aria-pressed=true]').count() === 2, 'つなぐなら Claude にも広がる');
  await row(page, 'cx').locator('.cx-ag').nth(0).click();
  await page.waitForTimeout(800);
  check(await page.locator(`${card} .cx-ask`).count() === 0 && await row(page, 'cx').locator('.cx-ag[aria-pressed=true]').count() === 1, '外すときは確認なし');
  void codexIdx;

  // 鍵: 止められないエージェントのアイコンは押せない
  const locked = page.locator(`${card} .cx-ag[aria-disabled=true]`);
  check(await locked.count() > 0 && await locked.first().locator('.lk').count() === 1, '止められないエージェントは鍵付きで押せない（aria-disabled）');
  const beforePressed = await locked.first().getAttribute('aria-pressed');
  await locked.first().click({ force: true });
  await page.waitForTimeout(400);
  check(await locked.first().getAttribute('aria-pressed') === beforePressed, '鍵のアイコンを押しても変わらない');

  // キーボード: アイコンは Tab で入り、Space で切り替わる
  await row(page, 'reg').locator('.cx-ag').first().focus();
  const was = await row(page, 'reg').locator('.cx-ag').first().getAttribute('aria-pressed');
  await page.keyboard.press('Space');
  await page.waitForTimeout(800);
  check(await row(page, 'reg').locator('.cx-ag').first().getAttribute('aria-pressed') !== was, 'キーボード（Space）でアイコンを切り替えられる');
  check(await page.evaluate(() => document.activeElement?.classList.contains('cx-ag')), '切り替えた後もフォーカスは同じアイコンに残る');
  await ctx.close();

  // 360・ダーク: 横にはみ出さない
  for (const [width, scheme] of [[360, 'light'], [360, 'dark'], [1280, 'dark']]) {
    const s = await session({ width, scheme });
    const over = await s.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(!over, `${width}px・${scheme}: 横にはみ出さない`);
    if (width === 360) check(await s.page.locator(`${card} .cx-legend.names`).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false), '360px: ロゴと名前の対応の 1 行が出る');
    await shot(s.page, `${scheme}-${width}`);
    await s.ctx.close();
  }
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`\n全て通過 ${results.length} 判定`);
} catch (e) {
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`  NG  ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await server?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
