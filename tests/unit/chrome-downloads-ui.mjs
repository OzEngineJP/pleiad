// 会話の Chrome のウィンドウのダウンロードの画面（web/chrome-downloads.mjs。docs/inapp-browser.md「ダウンロード」、ADR 0328）。
// 一覧の置き場と字は素の Node で、ボタン・一覧・スマホの入口は B1_BROWSER_TEST=1 のときだけ本物のブラウザーで確かめる。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { TAB_EVENTS } from '../../core/chrome/relay.mjs';
import { createDownloadStore, downloadProgress, downloadSubText, renderChromeDownloadLine } from '../../web/chrome-downloads.mjs';
import { renderPresent } from '../../web/render.mjs';

export const name = 'chrome-downloads-ui';
export const title = 'Chrome のウィンドウのダウンロードの画面: 会話ごとの一覧と未確認の印・進み具合・行の字・会話の 1 行（本物のブラウザーではボタン・一覧・止める・スマホの入口）';

const MB = 1024 * 1024;
const rec = (id, state, extra = {}) => ({ id, name: `${id}.zip`, state, received: 0, total: 0, path: null, startedAt: 1, stoppable: false, ...extra });

export default async function (t) {
  // ---- 進行中の全体の割合
  t.ok('進行中が無ければ割合は無い', downloadProgress([]) === null && downloadProgress([rec('a', 'completed', { received: 5, total: 5 })]) === null);
  t.ok('進行中の合計で割る（終わったものは数えない）', downloadProgress([rec('a', 'downloading', { received: 10, total: 40 }), rec('b', 'downloading', { received: 20, total: 60 }), rec('c', 'completed', { received: 9, total: 9 })]) === 0.3);
  t.ok('全体の大きさが分からないものしか無ければ割合は無い', downloadProgress([rec('a', 'downloading', { received: 10, total: 0 })]) === null);
  t.ok('分かるものだけで割る・1 を超えない', downloadProgress([rec('a', 'downloading', { received: 10, total: 0 }), rec('b', 'downloading', { received: 90, total: 60 })]) === 1);

  // ---- 一覧の行の 2 行目
  t.ok('進行中: 受け取った量 / 全体', downloadSubText(rec('a', 'downloading', { received: 20.2 * MB, total: 48.2 * MB })) === '20.2 MB / 48.2 MB');
  t.ok('進行中で全体が分からなければ、受け取った量だけ', downloadSubText(rec('a', 'downloading', { received: 3 * MB })) === '3 MB');
  t.ok('完了: 大きさ · 保存先のフォルダー（\\ でも / でも）', downloadSubText(rec('a', 'completed', { received: 48.2 * MB, total: 48.2 * MB, path: 'D:\\work\\reports\\a.zip' })) === '48.2 MB · D:\\work\\reports'
    && downloadSubText(rec('a', 'completed', { received: 2 * MB, path: '/home/u/dl/a.zip' })) === '2 MB · /home/u/dl');
  t.ok('完了で保存先が無ければ大きさだけ', downloadSubText(rec('a', 'completed', { received: 0, total: 2 * MB })) === '2 MB');
  t.ok('失敗と、止めたもの', downloadSubText(rec('a', 'failed')) === 'ダウンロードできませんでした' && downloadSubText(rec('a', 'canceled')) === '止めました');

  // ---- 会話ごとの一覧と未確認の印
  const store = createDownloadStore();
  t.ok('知らない会話の一覧は空・印も無い', store.list('s').length === 0 && store.unseen('s') === false);
  store.set('s', [rec('a', 'completed'), rec('b', 'downloading')]);
  t.ok('最初に届いた一覧の、もう終わっているものには印を付けない', store.list('s').length === 2 && store.unseen('s') === false);
  store.set('s', [rec('a', 'completed'), rec('b', 'downloading', { received: 5 })]);
  t.ok('進み具合だけの変化では印を付けない', store.unseen('s') === false);
  store.set('s', [rec('a', 'completed'), rec('b', 'completed')]);
  t.ok('見ている間に終わったら印を付ける', store.unseen('s') === true);
  t.ok('ほかの会話には付かない', store.unseen('other') === false);
  store.seen('s');
  t.ok('一覧を見たら印を消す', store.unseen('s') === false);
  store.set('s', [rec('c', 'failed'), rec('a', 'completed'), rec('b', 'completed')]);
  t.ok('前の一覧に無いまま終わって届いたもの（すぐ失敗した）にも印を付ける', store.unseen('s') === true);
  store.set('s', [rec('a', 'completed'), rec('b', 'completed')]);
  t.ok('一覧から消えたものの印は残さない', store.unseen('s') === false);
  store.set('s', [rec('d', 'canceled'), rec('a', 'completed')]);
  store.forget('s');
  t.ok('忘れる（見始めた・つなぎ直した）と一覧も印も消える', store.list('s').length === 0 && store.unseen('s') === false);
  store.set('s', [rec('d', 'canceled')]);
  t.ok('忘れた後に届く一覧は、最初のものとして受ける（印を付けない）', store.unseen('s') === false);
  store.set('s', null);
  t.ok('配列でないものは空として受ける', store.list('s').length === 0);

  // ---- 会話の 1 行（present kind: chromeDownload）
  const done = renderChromeDownloadLine({ kind: 'chromeDownload', chromeDownload: { name: 'report-2026-10.zip', state: 'completed', size: 48.2 * MB, path: 'D:\\work\\reports\\report-2026-10.zip' } });
  t.ok('完了の行: 「名前 をダウンロードしました · 大きさ」', done.className === 'cc-line' && done.textContent === 'report-2026-10.zip をダウンロードしました · 48.2 MB', done.textContent);
  const file = done.querySelector('.cc-file');
  t.ok('完了の行のファイル名は、パスを持つボタン（押すと開く・右クリックでファイルの操作）', file?.tagName === 'BUTTON' && file.textContent === 'report-2026-10.zip' && file.getAttribute('data-file-path') === 'D:\\work\\reports\\report-2026-10.zip' && file.type === 'button', done.outerHTML);
  t.ok('印は読み上げない', done.querySelector('.cc-line-ic').getAttribute('aria-hidden') === 'true');
  const noPath = renderChromeDownloadLine({ chromeDownload: { name: 'a.zip', state: 'completed', size: 1024, path: null } });
  t.ok('保存先の分からない完了は、名前を文字のまま出す', noPath.textContent === 'a.zip をダウンロードしました · 1 KB' && noPath.querySelector('.cc-file') === null, noPath.outerHTML);
  const failed = renderChromeDownloadLine({ chromeDownload: { name: 'report-2026-08.zip', state: 'failed' } });
  const stopped = renderChromeDownloadLine({ chromeDownload: { name: 'report-2026-10.zip', state: 'canceled' } });
  t.ok('失敗の行と止めた行（押せるものは無い）', failed.textContent === 'report-2026-08.zip をダウンロードできませんでした' && stopped.textContent === 'report-2026-10.zip のダウンロードを止めました'
    && failed.querySelector('.cc-file') === null && stopped.querySelector('.cc-file') === null, `${failed.textContent} / ${stopped.textContent}`);
  const odd = renderChromeDownloadLine({ chromeDownload: { name: '<img src=x onerror=1>.zip', state: 'completed', size: 1, path: 'C:/x/<b>.zip' } });
  t.ok('名前は文字として出す（HTML にしない）', odd.querySelector('.cc-file').textContent === '<img src=x onerror=1>.zip' && !odd.outerHTML.includes('<img src=x'), odd.outerHTML);
  t.ok('renderPresent が行へ回す（カードにしない）', renderPresent({ kind: 'chromeDownload', chromeDownload: { name: 'a.zip', state: 'failed' } }).className === 'cc-line');

  // ---- 画面の入口の配線: サーバーが出すタブの出来事（TAB_EVENTS）は、どれも右の欄（browser-unify）へ回す。
  // ここから漏れた出来事は、サーバーに記録があっても画面に出ない（fixture の試験では見つからない）。
  const client = readFileSync(new URL('../../web/client.mjs', import.meta.url), 'utf8');
  const route = client.split(/\r?\n/).find(line => line.includes("'tab:info'") && line.includes('loadBrowserUnify')) || '';
  const unrouted = TAB_EVENTS.filter(type => !route.includes(`'${type}'`));
  t.ok('client.mjs は、タブの出来事をどれも右の欄へ回す（tab:downloads を含む）', route !== '' && unrouted.length === 0, `回していない: ${unrouted.join(', ') || '（行が見つからない）'}`);

  if (process.env.B1_BROWSER_TEST !== '1') { t.note('ボタン・一覧・スマホの入口は B1_BROWSER_TEST=1 のときだけ本物のブラウザーで確かめる。'); return; }
  const require = createRequire(import.meta.url);
  const playwright = process.env.B1_PLAYWRIGHT_PACKAGE
    ? createRequire(process.env.B1_PLAYWRIGHT_PACKAGE)('playwright-core') : require('playwright-core');
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.B1_CHROME ? { executablePath: process.env.B1_CHROME } : {}), args: ['--use-angle=d3d11', '--num-raster-threads=4'] });
  try { await require('../browser/chrome-downloads.cjs')({ browser, check: (label, result, detail) => t.ok(label, result, detail), screenshots: process.env.B1_SCREENSHOTS }); }
  finally { await browser.close(); }
}
