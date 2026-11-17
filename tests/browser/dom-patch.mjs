// web/dom-patch.mjs（設定 › Claude のアカウントの差し替え）を本物の Chrome で:
//   残るノードは作り直さない（フォーカス・打ちかけの文字・選択）/ キーで並べ替える / style・open・inert を触らない /
//   slot の高さは動きの途中で描き直しても、その時の高さから続く（跳ばない・中身が消えたまま残らない）/ 減らす動き設定では動かさずに差し替える。
// 実行: node tests/browser/dom-patch.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる）
// サーバーは立てない。ページと web/dom-patch.mjs は page.route で返す。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from '../lib/server.mjs';

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

const SRC = fs.readFileSync(path.join(ROOT, 'web/dom-patch.mjs'), 'utf8');
// トークンは web/tokens.css と同じ名前。動きを測りやすいよう --dur だけ長くする
const PAGE = dur => `<!doctype html><meta charset="utf-8"><style>:root{--dur:${dur};--dur-slow:${dur};--ease-out:linear;--ease-organic:linear;--surface-sel:#ddd}
[data-slot]{display:flow-root;box-sizing:border-box;padding:4px 0}.row{height:40px}</style><div id="root"></div><div id="below" class="row">below</div>
<script type="module">import * as m from '/dom-patch.mjs'; window.dp = m; window.ready = true;</script>`;

async function open(browser, dur, reducedMotion = 'no-preference') {
  const ctx = await browser.newContext({ viewport: { width: 600, height: 600 }, reducedMotion });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://dp.test/**', r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/dom-patch.mjs') return r.fulfill({ contentType: 'text/javascript', body: SRC });
    return r.fulfill({ contentType: 'text/html', body: PAGE(dur) });
  });
  await page.goto('http://dp.test/');
  await page.waitForFunction(() => window.ready);
  return { ctx, page, errors };
}

const browser = await chromium.launch({ executablePath: chromiumPath() });
try {
  // ---- 残るノード・並べ替え・触らない属性
  {
    const { ctx, page, errors } = await open(browser, '200ms');
    const r = await page.evaluate(() => {
      const root = document.getElementById('root');
      const html = (order, label) => order.map(k => `<div data-k="${k}" class="c-${k}"><input data-n="${k}"><span data-t>${label}${k}</span></div>`).join('');
      window.dp.patch(root, html(['a', 'b', 'c'], 'x'));
      const a = root.querySelector('[data-k="a"]'), inA = a.querySelector('input'), c = root.querySelector('[data-k="c"]');
      inA.focus(); inA.value = 'typed'; inA.setSelectionRange(1, 3);
      c.style.height = '12px'; c.setAttribute('inert', ''); c.setAttribute('open', '');
      window.dp.patch(root, html(['c', 'a'], 'y'));
      const keys = [...root.children].map(e => e.dataset.k);
      return {
        keys, sameA: root.querySelector('[data-k="a"]') === a, sameC: root.querySelector('[data-k="c"]') === c,
        focused: document.activeElement === inA, value: inA.value, sel: [inA.selectionStart, inA.selectionEnd],
        text: a.textContent, keptStyle: c.style.height, keptInert: c.hasAttribute('inert'), keptOpen: c.hasAttribute('open'),
        textFade: a.querySelector('[data-t]').getAnimations().length,
      };
    });
    check(r.keys.join() === 'c,a', '消えたキーは外し、残るキーは新しい順に並ぶ', r.keys);
    check(r.sameA && r.sameC, '残るキーのノードは作り直さない');
    check(r.focused && r.value === 'typed' && r.sel.join() === '1,3', '並べ替えても、フォーカス・打ちかけの文字・選択の範囲が残る', r);
    check(r.text === 'ya', '文字は新しい HTML に合わせる', r.text);
    check(r.keptStyle === '12px' && r.keptInert && r.keptOpen, 'style・inert・open は新しい HTML に無くても外さない（動きの途中の値を壊さない）', r);
    check(r.textFade === 1, 'data-t の文字が変わると淡く入れ替わる', r.textFade);
    const v = await page.evaluate(() => {
      const root = document.getElementById('root');
      window.dp.patch(root, '<input data-k="i" value="one">');
      const i = root.firstChild; i.value = 'user';
      window.dp.patch(root, '<input data-k="i" value="one">'); const kept = i.value;
      window.dp.patch(root, '<input data-k="i" value="two">');
      return { kept, changed: i.value };
    });
    check(v.kept === 'user' && v.changed === 'two', '入力欄の値は、HTML の value が変わったときだけ入れ直す', v);
    check(errors.length === 0, 'ページの誤りが無い（1）', errors);
    await ctx.close();
  }

  // ---- slot の高さ: 出る → 途中で消す → 途中で出し直す（描き直しが動きの途中に来る）
  {
    const { ctx, page, errors } = await open(browser, '400ms');
    const body = '<div class="row">1</div><div class="row">2</div>';
    await page.evaluate(() => window.dp.patch(document.getElementById('root'), '<div data-slot="s"></div>'));
    const base = await page.evaluate(() => document.getElementById('below').getBoundingClientRect().top);
    // 出る
    await page.evaluate(b => window.dp.patch(document.getElementById('root'), `<div data-slot="s">${b}</div>`), body);
    const frames = [];
    const sample = () => page.evaluate(() => ({ h: document.querySelector('[data-slot]').getBoundingClientRect().height, below: document.getElementById('below').getBoundingClientRect().top }));
    await page.waitForTimeout(150); frames.push(await sample());
    // 動きの途中で消す（同じ slot を空にする）
    const atLeave = await page.evaluate(() => {
      const s = document.querySelector('[data-slot]'); const h = s.getBoundingClientRect().height;
      window.dp.patch(document.getElementById('root'), '<div data-slot="s"></div>');
      return { before: h, after: s.getBoundingClientRect().height, inert: s.inert, kids: s.childNodes.length };
    });
    check(Math.abs(atLeave.before - atLeave.after) < 1.5, '出る動きの途中で消しても、その時の高さから縮み始める（跳ばない）', atLeave);
    check(atLeave.inert && atLeave.kids === 2, '縮む間は中身を残し、操作できないようにする', atLeave);
    await page.waitForTimeout(120); frames.push(await sample());
    // 縮む途中で出し直す
    const atBack = await page.evaluate(b => {
      const s = document.querySelector('[data-slot]'); const h = s.getBoundingClientRect().height;
      window.dp.patch(document.getElementById('root'), `<div data-slot="s">${b}</div>`);
      return { before: h, after: s.getBoundingClientRect().height, inert: s.inert, kids: s.childNodes.length };
    }, body);
    check(Math.abs(atBack.before - atBack.after) < 1.5, '縮む途中で出し直しても、その時の高さから伸び直す（跳ばない）', atBack);
    check(!atBack.inert && atBack.kids === 2, '出し直したら操作でき、中身は 1 組だけ', atBack);
    for (let i = 0; i < 6; i++) { await page.waitForTimeout(80); frames.push(await sample()); }
    await page.waitForTimeout(300);
    const end = await page.evaluate(() => { const s = document.querySelector('[data-slot]'); return { h: s.getBoundingClientRect().height, overflow: s.style.overflow, anims: s.getAnimations().length, below: document.getElementById('below').getBoundingClientRect().top }; });
    check(end.h === 88 && end.overflow === '' && end.anims === 0, '動きが終わると中身の高さに落ち着き、途中の値（overflow）が残らない', end);
    check(end.below === base + 80, '下の行は中身の高さの分だけ下がった所に落ち着く', { base, end: end.below });
    // 下の行は slot の高さに沿ってだけ動く（slot の高さ + 一定 = 下の行の位置）
    const offs = frames.map(f => Math.round(f.below - f.h));
    check(new Set(offs).size === 1, '動きの途中、下の行は slot の高さに沿って動くだけ（別に跳ばない）', frames);
    check(errors.length === 0, 'ページの誤りが無い（2）', errors);
    await ctx.close();
  }

  // ---- 減らす動き設定（トークンが 0ms）: 動かさずに差し替える
  {
    const { ctx, page, errors } = await open(browser, '0ms', 'reduce');
    const r = await page.evaluate(() => {
      const root = document.getElementById('root');
      window.dp.patch(root, '<div data-slot="s"></div><span data-k="t" data-t>a</span>');
      window.dp.patch(root, '<div data-slot="s"><div class="row" data-in>1</div></div><span data-k="t" data-t>b</span>');
      const s = root.querySelector('[data-slot]');
      const shown = { h: s.getBoundingClientRect().height, anims: document.getAnimations().length };
      window.dp.patch(root, '<div data-slot="s"></div><span data-k="t" data-t>b</span>');
      window.dp.flash(root);
      return { shown, gone: { h: s.getBoundingClientRect().height, kids: s.childNodes.length, inert: s.inert }, anims: document.getAnimations().length, ms: window.dp.ms('--dur') };
    });
    check(r.ms === 0 && r.shown.anims === 0 && r.anims === 0, '0ms では出る・消える・文字の入れ替え・光らせるのどれも動きを作らない', r);
    check(r.shown.h === 48 && r.gone.h === 8 && r.gone.kids === 0 && !r.gone.inert, '0ms では中身がすぐ出て、すぐ消える', r);
    check(errors.length === 0, 'ページの誤りが無い（3）', errors);
    await ctx.close();
  }
  console.log(results.map(r => `ok  ${r}`).join('\n'));
  console.log(`PASS: ${results.length} 判定すべて通過`);
} catch (e) {
  console.log(results.map(r => `ok  ${r}`).join('\n'));
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
