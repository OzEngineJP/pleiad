// 閉じたレールと P の印・脇の下端・引き出しの ✕（web/client.mjs の initSidebar・setSidebar、ADR 0289）の実ブラウザーの確かめ:
//   広い画面（1280）:
//   - 開いている間、P の印（#sideMark）は「Pleiad」の絵（role=img・tabindex=-1・pointer-events なし）。レールは出ない
//   - 閉じると列は 52px のレール。P は「サイドバーを開く」のボタン（tabindex 0・件数の名前）、レールの 検索・ルーティン・設定・Plus の丸が押せる
//   - P に載せると開くの印（pm-op）に替わる。P を押すと開いて焦点は閉じるボタンへ。閉じると焦点は P へ
//   - Ctrl+B で閉じ・開き。レールの検索は開いて検索欄に焦点、ルーティンは開いてルーティンの見出しを開いて木の項目を指す
//   - 下端は左に Plus の丸と名・右端に設定。Plus が使えなければ左を出さず設定だけ
//   狭い画面（360）:
//   - ハンバーガー（#openSidebar）は左端から 8px 離れ、hover の丸が端に触れない。開くと引き出しの右上に ✕、押すと閉じる
// 実行: node tests/browser/sidebar-rail.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる）
// 本物のサーバー（fake のバックエンド・一時のデータ置き場・別ポート）だけと話す
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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-side-rail-'));
let server, browser;
try {
  const work = path.join(scratch, 'work');
  fs.mkdirSync(work);
  server = await startServer({ dataDir: path.join(scratch, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  const ws = await open({ port: server.port, token: server.token });
  await ws.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:レールの確かめ' });
  ws.close();

  browser = await chromium.launch({ executablePath: chromiumPath() });
  const newPage = async (viewport, extra = {}) => {
    const ctx = await browser.newContext({ viewport, locale: 'ja-JP', ...extra });
    const page = await ctx.newPage();
    page.on('pageerror', e => { throw e; });
    await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
    await page.locator('#prompt').waitFor();
    await page.waitForTimeout(1200);   // 初期設定のダイアログは届くデータの後で開く。開き切ってから閉じる
    await page.evaluate(() => document.getElementById('closeOnboarding')?.click());   // 「あとで」で閉じる（開いていなければ押されない）
    return { ctx, page };
  };
  const closed = (page) => page.evaluate(() => document.documentElement.classList.contains('side-closed'));
  const settled = (page) => page.waitForFunction(() => !document.body.classList.contains('side-moving'), null, { timeout: 3000 });
  const pmState = (page) => page.evaluate(() => {
    const pm = document.getElementById('sideMark');
    const st = getComputedStyle(pm);
    return { role: pm.getAttribute('role'), label: pm.getAttribute('aria-label'), tab: pm.tabIndex, pe: st.pointerEvents,
      mk: getComputedStyle(pm.querySelector('.pm-mk')).display, op: getComputedStyle(pm.querySelector('.pm-op')).display };
  });
  const railShown = (page) => page.evaluate(() => {
    const rail = document.getElementById('sideRail');
    const st = getComputedStyle(rail);
    const r = rail.getBoundingClientRect();
    return { display: st.display, vis: st.visibility, op: st.opacity, w: r.width, hidden: rail.getAttribute('aria-hidden'),
      tabs: [...rail.querySelectorAll('button')].map(b => b.tabIndex) };
  });

  // ==================== 広い画面（1280） ====================
  {
    const { ctx, page } = await newPage({ width: 1280, height: 800 });
    // 開いている間: P は名札の絵、レールは出ない
    await page.evaluate(() => { document.documentElement.classList.remove('side-closed'); });
    let pm = await pmState(page);
    check(pm.role === 'img' && pm.label === 'Pleiad' && pm.tab === -1 && pm.pe === 'none', '開いている間、P は「Pleiad」の絵で押せない', pm);
    let rail = await railShown(page);
    check(rail.vis === 'hidden' && rail.hidden === 'true' && rail.tabs.every(x => x === -1), '開いている間、レールは出ず Tab も止まらない', rail);
    // 閉じるボタンは通知の右（脇の右上の端）
    const heads = await page.evaluate(() => {
      const bell = document.getElementById('notifBell').getBoundingClientRect();
      const close = document.getElementById('closeSidebar').getBoundingClientRect();
      const side = document.getElementById('sidebar').getBoundingClientRect();
      return { bell, close, side };
    });
    check(heads.close.left > heads.bell.left && heads.side.right - heads.close.right < 12, '閉じるボタンは通知の右（脇の右上の端）',
      { gap: heads.close.left - heads.bell.right, edge: heads.side.right - heads.close.right });
    check(await page.evaluate(() => getComputedStyle(document.getElementById('closeSidebar').querySelector('.ic-x')).display === 'none'
      && getComputedStyle(document.getElementById('closeSidebar').querySelector('.ic-side')).display !== 'none'), '広い画面の閉じる印は脇の絵（ic-side）。✕ は出さない');
    // 下端: 左に Plus の丸と名、右端に設定
    const foot = await page.evaluate(() => {
      const me = document.getElementById('sidePlus').getBoundingClientRect();
      const gear = document.getElementById('settings').getBoundingClientRect();
      const foot = document.querySelector('.side-foot').getBoundingClientRect();
      return { me, gear, foot };
    });
    check(foot.me.left < foot.gear.left && foot.foot.right - foot.gear.right < 12, '下端は左に Plus、右端に設定',
      { edge: foot.foot.right - foot.gear.right });
    // Ctrl+B で閉じる
    await page.keyboard.press('Control+b');
    await page.waitForFunction(() => document.documentElement.classList.contains('side-closed'));
    await settled(page);
    // 列は 52px、脇は隠れてレール・P・Plus の丸だけ残る
    const col = await page.evaluate(() => getComputedStyle(document.body).gridTemplateColumns.split(' ')[0]);
    check(col === '52px', '閉じると列は 52px のレール', col);
    pm = await pmState(page);
    check(pm.role !== 'img' && /サイドバーを開く/.test(pm.label ?? '') && pm.tab === 0 && pm.pe === 'auto', '閉じている間、P は「サイドバーを開く」のボタン', pm);
    rail = await railShown(page);
    check(rail.display === 'flex' && rail.vis === 'visible' && rail.hidden === 'false' && rail.tabs.every(x => x === 0) && rail.w === 52, '閉じている間、レールが出てボタンは Tab で届く', rail);
    check(await page.evaluate(() => {
      const off = document.getElementById('sidebar').classList.contains('plus-off');
      const av = document.getElementById('sideAvatar');
      // Plus が使えなければ丸は出さない。あれば閉じたレールの下に残る
      return off ? getComputedStyle(av).display === 'none' : av.getBoundingClientRect().width > 0;
    }), '閉じている間、Plus の丸の出し入れは status に従う（使えなければ出さない）');
    // 焦点は P へ移る（閉じるボタンを押した場合）
    await page.keyboard.press('Control+b');   // 開き直す
    await page.waitForFunction(() => !document.documentElement.classList.contains('side-closed'));
    await settled(page);
    await page.locator('#closeSidebar').click();
    await settled(page);
    check(await page.evaluate(() => document.activeElement?.id === 'sideMark'), '閉じると焦点は P（サイドバーを開く）へ', await page.evaluate(() => document.activeElement?.id));
    // P に載せると開くの印に替わる
    await page.locator('#sideMark').hover();
    pm = await pmState(page);
    check(pm.mk === 'none' && pm.op === 'block', 'P に載せると開くの印（pm-op）に替わる', pm);
    // P を押すと開いて、焦点は閉じるボタンへ
    await page.locator('#sideMark').click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('side-closed'));
    await settled(page);
    check(await page.evaluate(() => document.activeElement?.id === 'closeSidebar'), 'P で開くと焦点は閉じるボタンへ', await page.evaluate(() => document.activeElement?.id));
    // レールの検索: 脇を開いて検索欄に焦点
    await page.locator('#closeSidebar').click();
    await settled(page);
    await page.locator('#railSearch').click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('side-closed'));
    check(await page.evaluate(() => document.activeElement?.id === 'q'), 'レールの検索は脇を開いて検索欄に焦点', await page.evaluate(() => document.activeElement?.id));
    // レールのルーティン: 脇を開いてルーティンの見出しを開いて木の項目を指す
    await page.locator('#closeSidebar').click();
    await settled(page);
    await page.locator('#railRoutines').click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('side-closed'));
    await page.waitForTimeout(400);
    const rt = await page.evaluate(() => {
      const head = document.getElementById('csRoutinesHead');
      return { open: head?.getAttribute('aria-expanded') !== 'false' && !head?.closest('.collapsed'),
        key: document.querySelector('#sidebar [data-key="c:routines"]') != null,
        active: document.querySelector('#groups .is-active, #groups [data-active], #groups [aria-current]')?.dataset?.key };
    });
    check(rt.key, 'ルーティンの見出しは木の項目 c:routines', rt);
    check(await page.evaluate(() => localStorage.getItem('agent-host-side-routines-open') === '1'
      || document.getElementById('csRoutinesHead')?.getAttribute('aria-expanded') === 'true'
      || document.querySelector('.cs-sec[data-sec="routines"] .cs-rows, .cs-sec[data-sec="routines"] .rows') != null), 'レールの時計はルーティンの見出しを開く', rt);
    // Plus が使えなければ（偽のバックエンド）、下端は設定だけ
    const plusOff = await page.evaluate(() => ({
      off: document.getElementById('sidebar').classList.contains('plus-off'),
      me: getComputedStyle(document.getElementById('sidePlus')).visibility,
      av: getComputedStyle(document.getElementById('sideAvatar')).display,
      gear: document.getElementById('settings').getBoundingClientRect().width > 0,
    }));
    if (plusOff.off) {
      check(plusOff.me === 'hidden' && plusOff.av === 'none' && plusOff.gear, 'Plus が使えなければ左を出さず設定だけ', plusOff);
    } else {
      check(await page.evaluate(() => document.getElementById('sidePlusName').textContent.length > 0), 'Plus があれば丸と名（頭文字・メールまたはログインの文）');
    }
    await ctx.close();
  }

  // ==================== 狭い画面（360） ====================
  {
    const { ctx, page } = await newPage({ width: 360, height: 760 }, { hasTouch: true, isMobile: true });
    // ハンバーガーは左端に全体が見える（hover の地が欠けない）: 左はみ出し無し
    const ham = await page.evaluate(() => {
      const b = document.getElementById('openSidebar');
      const r = b.getBoundingClientRect();
      return { left: r.left, w: r.width, display: getComputedStyle(b).display };
    });
    check(ham.display !== 'none' && ham.left >= 8 && ham.w >= 40, 'ハンバーガーは 44px で左端から 8px 離れる', ham);
    // 開くと引き出しの右上に ✕（ic-side は隠す）
    await page.locator('#openSidebar').click();
    await page.waitForFunction(() => document.documentElement.classList.contains('side-open'));
    await page.waitForTimeout(400);
    check(await page.evaluate(() => document.activeElement?.id === 'closeSidebar'), '開くと焦点は ✕（閉じるボタン）へ', await page.evaluate(() => document.activeElement?.id));
    const x = await page.evaluate(() => {
      const c = document.getElementById('closeSidebar');
      const r = c.getBoundingClientRect();
      const side = document.getElementById('sidebar').getBoundingClientRect();
      return { displayX: getComputedStyle(c.querySelector('.ic-x')).display, displaySide: getComputedStyle(c.querySelector('.ic-side')).display,
        edge: side.right - r.right, w: r.width };
    });
    check(x.displayX === 'block' && x.displaySide === 'none' && x.edge >= 8 && x.edge < 12 && x.w >= 40, '引き出しの右上の端に ✕（44px・右端から 8px）', x);
    // 引き出しの見出しに P の印と下端の一行
    check(await page.evaluate(() => {
      const pm = document.getElementById('sideMark');
      const foot = document.querySelector('.side-foot').getBoundingClientRect();
      return pm.getBoundingClientRect().width > 0 && foot.height >= 44;
    }), '引き出しは見出しに P、下端にアカウントと設定の一行');
    await page.locator('#closeSidebar').click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('side-open'));
    check(true, '✕ で閉じる');
    // 閉じた後は広い画面のレールの物（#sideRail・#sideAvatar）は出ない
    const rail = await railShown(page);
    check(rail.display === 'none' || rail.vis === 'hidden', '狭い画面に閉じたレールは出ない', rail);
    check(await page.evaluate(() => getComputedStyle(document.getElementById('sideAvatar')).display === 'none'), '狭い画面に重ね置きの Plus の丸は出ない');
    await ctx.close();
  }
} finally {
  await browser?.close();
  await server?.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`OK ${results.length} 件`);
for (const r of results) console.log(`  OK ${r}`);
