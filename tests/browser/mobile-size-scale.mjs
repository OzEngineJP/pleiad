// スマホの大きさの段階（ADR 0256・docs/design-system.md「スマホの大きさの段階」）と、スラッシュの候補の幅の実ブラウザーの確かめ:
//   - 360px（タッチ）: 本文・入力欄 17、上部の題 20、操作 15、補足 13、ツールの対象 16・動詞 14、端末の出力と添付の札 14
//   - 主要なアイコン 20・補助 16、押せる所は実体の箱で 44（上部のボタン・添付・送信・チップ・メニューの行・ツールの行・脇の行）。擬似要素で広げず、隣と重ならない
//   - 上部の帯は 60px
//   - スラッシュの候補（#skillList・スレッドの #thSkillList）の左右端は入力欄の箱（#cbox・#thCbox）と同じ。スマホは画面の端から 4px
//   - 1280px: 役割の変数は今の段階（--fs-*）のまま。PC の字の大きさは変わらない
// 実行: node tests/browser/mobile-size-scale.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる）
// 本物のサーバー（fake のバックエンド・一時のデータ置き場・別ポート）だけと話す。ツールの行のある会話 1 件と、返信のあるスレッドのチャンネルを WS で作る
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-size-scale-'));
let server, browser, ws;
try {
  const work = path.join(scratch, 'work');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(scratch, 'note.txt'), 'hello');
  server = await startServer({ dataDir: path.join(scratch, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  ws = await open({ port: server.port, token: server.token });
  const invoke = (op, args) => ws.cmd('invoke', { op, args });
  const steps = [
    { text: '調べます。' },
    { tool: 'Bash', input: { command: 'npm test', description: 'Run tests' }, result: 'ok 1 composer fits\n# pass 1' },
    { tool: 'Read', input: { file_path: path.join(work, 'style.css') }, result: 'body{}' },
    { text: 'まとめです。' },
  ];
  const scriptFile = path.join(scratch, 'steps.json');
  fs.writeFileSync(scriptFile, JSON.stringify({ steps }));
  const { sessionId } = await ws.runTurn({ backend: 'fake', cwd: work, prompt: `steps:@${scriptFile}` });
  const channel = await invoke('channels.create', { name: 'dev' });
  const root = await invoke('channels.post', { channelId: channel.id, text: 'スレッド', new: true });
  await invoke('channels.post', { channelId: channel.id, threadId: root.id, text: '返信' });
  ws.close();

  browser = await chromium.launch({ executablePath: chromiumPath() });
  const errors = [];
  const newPage = async (width, mobile) => {
    const ctx = await browser.newContext({ viewport: { width, height: mobile ? 760 : 900 }, locale: 'ja-JP', ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
    await page.locator('#prompt').waitFor();
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
    return { ctx, page };
  };
  // 脇の行は playwright の click が効かないことがあるので、evaluate の中で押す（docs/dev-verification.md）
  const openSession = async (page, mobile) => {
    if (mobile) { await page.locator('#openSidebar').click(); await page.waitForTimeout(400); }
    await page.waitForFunction(id => document.querySelector(`.row[data-session="${id}"]`), sessionId, { timeout: 20_000 });
    await page.evaluate(id => document.querySelector(`.row[data-session="${id}"]`).click(), sessionId);
    await page.waitForFunction(() => document.querySelector('#thread .rhead, #thread .tc-head'), null, { timeout: 20_000 });
    await page.waitForTimeout(300);
  };
  const css = (page, sel, prop, pseudo = null) => page.evaluate(([s, p, ps]) => {
    const n = document.querySelector(s);
    return n && getComputedStyle(n, ps)[p];
  }, [sel, prop, pseudo]);
  const box = (page, sel) => page.evaluate(s => {
    const n = document.querySelector(s);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
  }, sel);
  // スラッシュの候補を開いて、一覧と入力欄の箱の左右端を返す
  const slashEdges = async (page, prefix) => {
    const id = (part) => (prefix ? prefix + part[0].toUpperCase() + part.slice(1) : part);
    await page.locator(`#${id('prompt')}`).click();
    await page.keyboard.type('/');
    await page.waitForFunction(s => document.getElementById(s)?.hidden === false, id('skillList'), { timeout: 10_000 });
    const edges = { list: await box(page, `#${id('skillList')}`), cbox: await box(page, `#${id('cbox')}`) };
    await page.keyboard.press('Escape');
    await page.keyboard.press('Backspace');
    return edges;
  };
  const openThread = async (page, mobile) => {
    const sideOpen = () => page.evaluate(() => document.documentElement.classList.contains('side-open'));
    if (mobile && !(await sideOpen())) { await page.locator('#openSidebar').click(); await page.waitForTimeout(400); }
    const row = `[data-side-key="chsec:${channel.id}"] .row[data-thread]`;
    await page.waitForFunction(s => document.querySelector(s), row, { timeout: 20_000 });
    await page.evaluate(s => document.querySelector(s).click(), row);
    await page.waitForFunction(() => document.getElementById('thPrompt')?.getBoundingClientRect().width > 0, null, { timeout: 20_000 });
    await page.waitForTimeout(300);
  };

  // ---- 360px（タッチ）
  {
    const { ctx, page } = await newPage(360, true);
    await openSession(page, true);
    await page.evaluate(() => { document.documentElement.classList.remove('side-open'); for (const b of document.querySelectorAll('#thread .rhead')) b.click(); });
    await page.waitForTimeout(300);
    await page.evaluate(() => { for (const d of document.querySelectorAll('#thread details.tc-details')) d.open = true; });
    await page.waitForTimeout(300);

    check(await css(page, '#prompt', 'fontSize') === '17px', 'スマホ: 入力欄は 17px');
    check(await css(page, '#titleEdit', 'fontSize') === '20px', 'スマホ: 上部の題は 20px');
    check(await css(page, '#log .m.ai > .body', 'fontSize') === '17px', 'スマホ: 本文は 17px');
    check(await css(page, '#thread .tc-main', 'fontSize') === '16px', 'スマホ: ツールの対象は 16px');
    check(await css(page, '#thread .tc-label', 'fontSize') === '14px', 'スマホ: ツールの動詞は 14px');
    check(await css(page, '#thread .tc-term', 'fontSize') === '14px', 'スマホ: 端末の出力は 14px', await css(page, '#thread .tc-term', 'fontSize'));
    check(await css(page, '#log .who', 'fontSize') === '13px', 'スマホ: 発言者（補足）は 13px');
    check(await css(page, '#thread .tic', 'width') === '20px', 'スマホ: ツールのアイコン（主要）は 20px');
    const rows = await page.evaluate(() => [...document.querySelectorAll('#thread :is(.rhead,.tc-details > .tc-head)')].filter(n => n.getBoundingClientRect().height > 0).map(n => Math.round(n.getBoundingClientRect().height)));
    check(rows.length > 0 && rows.every(h => h >= 44), 'スマホ: ツールの行は 44px 以上', rows);

    // 上部の帯とボタン
    check((await box(page, 'main > .top')).h === 60, 'スマホ: 上部の帯は 60px', await box(page, 'main > .top'));
    const top = await page.evaluate(() => [...document.querySelectorAll('main > .top > .btn-icon')].filter(n => n.getBoundingClientRect().width > 0).map(n => {
      const r = n.getBoundingClientRect();
      return { id: n.id, l: r.left, r: r.right, w: Math.round(r.width), h: Math.round(r.height), icon: n.querySelector('svg.i') && Math.round(n.querySelector('svg.i').getBoundingClientRect().width), before: getComputedStyle(n, '::before').content };
    }).sort((a, b) => a.l - b.l));
    check(top.length >= 2 && top.every(b => b.w === 44 && b.h === 44), 'スマホ: 上部のボタンは実体で 44×44', top);
    check(top.every(b => b.icon === null || b.icon === 20), 'スマホ: 上部のアイコンは 20px', top);
    check(top.every(b => b.before === 'none'), 'スマホ: 上部のボタンは擬似要素で当たりを広げない', top);
    check(top.every((b, i) => i === 0 || top[i - 1].r <= b.l + 0.5), 'スマホ: 上部のボタンの当たりが隣と重ならない', top);

    // 入力欄の下の行
    const crow = await page.evaluate(() => ['attach', 'send', 'modelChip', 'cwdChip'].map(id => {
      const n = document.getElementById(id);
      const r = n.getBoundingClientRect();
      return { id, l: r.left, r: r.right, w: Math.round(r.width), h: Math.round(r.height), fs: getComputedStyle(n).fontSize, icon: n.querySelector('svg.i') && Math.round(n.querySelector('svg.i').getBoundingClientRect().width), before: getComputedStyle(n, '::before').content };
    }));
    const [attach, send, ...chips] = crow;
    check(attach.w === 44 && attach.h === 44 && send.w === 44 && send.h === 44, 'スマホ: 添付と送信は実体で 44×44', crow);
    check(attach.icon === 20 && send.icon === 20, 'スマホ: 添付と送信のアイコンは 20px', crow);
    check(chips.every(c => c.h === 44 && c.fs === '15px'), 'スマホ: チップは高さ 44・字 15px', chips);
    check(crow.every(c => c.before === 'none'), 'スマホ: 入力欄の下の行は擬似要素で当たりを広げない', crow);
    const row = [...crow].filter(c => c.w > 0).sort((a, b) => a.l - b.l);
    check(row.every((c, i) => i === 0 || row[i - 1].r <= c.l + 0.5), 'スマホ: 入力欄の下の行の当たりが隣と重ならない', row);

    // 添付の札
    await page.setInputFiles('#fileIn', path.join(scratch, 'note.txt'));
    await page.waitForFunction(() => document.querySelector('#cbox .md-att-up'), null, { timeout: 10_000 });
    check(await css(page, '#cbox .md-att-up', 'fontSize') === '14px', 'スマホ: 添付の札は 14px');
    const att = await box(page, '#cbox .md-att-act.btn-icon');
    check(att && att.w === 44 && att.h === 44, 'スマホ: 添付の札の × は 44×44', att);

    // スラッシュの候補
    const edges = await slashEdges(page, '');
    check(edges.list.l === edges.cbox.l && edges.list.r === edges.cbox.r, 'スマホ: 候補の左右端は入力欄の箱と同じ', edges);
    check(edges.list.l === 4 && edges.list.r === 356, 'スマホ: 候補は画面の端から 4px', edges);

    // ⋯ のメニュー
    await page.evaluate(() => document.getElementById('sessionMore').click());
    await page.waitForFunction(() => document.querySelector('.pop.menu:not([hidden]) .li'), null, { timeout: 10_000 });
    const menu = await page.evaluate(() => {
      const pop = document.querySelector('.pop.menu:not([hidden])');
      return { fs: getComputedStyle(pop).fontSize, rows: [...pop.querySelectorAll('.li')].map(n => Math.round(n.getBoundingClientRect().height)), icon: Math.round(pop.querySelector('.li :is(svg.i,.conversation-menu-icon)').getBoundingClientRect().width) };
    });
    check(menu.fs === '15px', 'スマホ: メニューの字は 15px', menu);
    check(menu.rows.every(h => h >= 44), 'スマホ: メニューの行は 44px 以上', menu);
    check(menu.icon === 20, 'スマホ: メニューのアイコンは 20px', menu);
    await page.keyboard.press('Escape');

    // 脇の行
    await page.locator('#openSidebar').click();
    await page.waitForTimeout(400);
    const side = await page.evaluate(() => [...document.querySelectorAll('#groups .row[data-session]')].filter(n => n.querySelector('.row-title')).map(n => ({ h: Math.round(n.getBoundingClientRect().height), title: getComputedStyle(n.querySelector('.row-title')).fontSize })));
    check(side.length > 0 && side.every(r => r.h >= 44 && r.title === '16px'), 'スマホ: 脇の行は 44px 以上・題は 16px', side);

    // スレッドの入力欄の候補
    await openThread(page, true);   // スレッドの行を押すと引き出しは閉じる
    await page.waitForFunction(() => !document.documentElement.classList.contains('side-open'));
    const th = await slashEdges(page, 'th');
    check(th.list.l === th.cbox.l && th.list.r === th.cbox.r, 'スマホ: スレッドの候補の左右端は入力欄の箱と同じ', th);
    await ctx.close();
  }

  // ---- 1280px（PC）
  {
    const { ctx, page } = await newPage(1280, false);
    const tokens = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      const v = (n) => s.getPropertyValue(n).trim();
      return { body: v('--fs-body'), title: v('--fs-title'), ui: v('--fs-ui'), meta: v('--fs-meta'), verb: v('--fs-verb'), target: v('--fs-target'), term: v('--fs-term'), icon: v('--icon'), iconS: v('--icon-s'), hit: v('--hit') };
    });
    check(JSON.stringify(tokens) === JSON.stringify({ body: '14px', title: '15px', ui: '12px', meta: '11px', verb: '11px', target: '12px', term: '12px', icon: '16px', iconS: '12px', hit: '30px' }),
      'PC: 役割の変数は今の段階のまま', tokens);
    await openSession(page, false);
    await page.evaluate(() => { for (const b of document.querySelectorAll('#thread .rhead')) b.click(); });
    await page.waitForTimeout(300);
    check(await css(page, '#prompt', 'fontSize') === '14px', 'PC: 入力欄は 14px のまま');
    check(await css(page, '#thread .tc-main', 'fontSize') === '12px', 'PC: ツールの対象は 12px のまま');
    check(await css(page, '#thread .tc-label', 'fontSize') === '11px', 'PC: ツールの動詞は 11px のまま');
    check(await css(page, '#thread .tic', 'width') === '16px', 'PC: ツールのアイコンは 16px のまま');
    const edges = await slashEdges(page, '');
    check(edges.list.l === edges.cbox.l && edges.list.r === edges.cbox.r, 'PC: 候補の左右端は入力欄の箱と同じ（760 の列）', edges);
    check(await css(page, '#skillList', 'fontSize') === '12px', 'PC: 候補の字は 12px のまま');
    await openThread(page, false);
    const th = await slashEdges(page, 'th');
    check(th.list.l === th.cbox.l && th.list.r === th.cbox.r, 'PC: スレッドの候補の左右端は入力欄の箱と同じ', th);
    await ctx.close();
  }

  check(errors.length === 0, '画面の例外なし', errors);
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`mobile-size-scale: ${results.length} 件 通過`);
} catch (e) {
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.error(`NG  ${e.message}`);
  if (server) console.error(server.tail(20));
  process.exitCode = 1;
} finally {
  ws?.close();
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
