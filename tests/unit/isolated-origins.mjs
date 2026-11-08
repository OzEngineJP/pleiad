// アプリごとの専用の出どころと、開いているファイルの変化の見張り（ADR 0295 の 3・6・7）。
//   - core/isolated-origins.mjs: page-secrets の作り直しと持続・束とフォルダーの印・Host の検査・port が替わった URL の付け替え
//   - core/page-watch.mjs: ファイル・フォルダーの登録・直下の子の変化・まとめて 1 回・会話ごとの消去
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadPageSecrets, vizMark, fileMark, isolatedHostOk, movedPageUrl, LOCALHOST_MARK } from '../../core/isolated-origins.mjs';
import { createPageWatch } from '../../core/page-watch.mjs';
import { createHtmlKeys } from '../../core/html-keys.mjs';
import { waitFor } from '../lib/holder-harness.mjs';

export const name = 'isolated-origins';
export const title = 'アプリの専用の出どころ（印・Host の検査・URL の付け替え）と開いているファイルの見張り';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-isolated-origins-'));
  try {
    // page-secrets: 無ければ作り、次は同じものを返す（鍵と印がサーバーの入れ替えをまたぐ）
    const dir = path.join(scratch, 'data');
    await fs.mkdir(dir, { recursive: true });
    const first = await loadPageSecrets(dir);
    const again = await loadPageSecrets(dir);
    t.ok('page-secrets は 32 バイトを作り、次は同じものを返す', first.key.length === 32 && first.key.equals(again.key));
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'page-secrets.json'), 'utf8'));
    t.ok('保存するのは base64 の key だけ', Buffer.from(saved.key, 'base64').equals(first.key));
    await fs.writeFile(path.join(dir, 'page-secrets.json'), '{"key":"bad"}');
    const remade = await loadPageSecrets(dir);
    t.ok('壊れたファイルは作り直す（別の key）', remade.key.length === 32 && !remade.key.equals(first.key));

    // 印: 束のハッシュとフォルダーから決まる。印の名前の形は <印>.localhost
    const hash = 'a'.repeat(64);
    t.ok('束の印はハッシュの先頭 24 字（中身が同じなら同じ印）', vizMark(hash) === `v${'a'.repeat(24)}` && vizMark(hash.toUpperCase()) === vizMark(hash)
      && LOCALHOST_MARK.test(`${vizMark(hash)}.localhost`));
    const mark = fileMark(first.key, path.join(scratch, 'work'));
    t.ok('フォルダーの印は f<16 字>（同じ秘密・同じフォルダーで同じ。別の秘密・別のフォルダーで別）',
      LOCALHOST_MARK.test(`${mark}.localhost`) && mark === fileMark(first.key, path.join(scratch, 'work'))
      && mark !== fileMark(crypto.randomBytes(32), path.join(scratch, 'work')) && mark !== fileMark(first.key, scratch));
    if (process.platform === 'win32') {
      t.ok('Windows のフォルダーは大小文字・区切りを揃えて印にする',
        mark === fileMark(first.key, path.join(scratch, 'work').replaceAll('\\', '/').toUpperCase()));
    }
    t.ok('印にフォルダーのパスは出ない（16 字の HMAC・<印>.localhost の名に収まる形）', !mark.includes('work') && /^f[0-9a-f]{16}$/.test(mark));

    // Host の検査: localhost:<port> と <印>.localhost:<port> だけ
    t.ok('Host は localhost:<port> と <印>.localhost:<port>',
      isolatedHostOk('localhost:8080', 8080) && isolatedHostOk(`${vizMark(hash)}.localhost:8080`, 8080));
    t.ok('違う port・違う名前・IP・名前なし・port なしは断る',
      !isolatedHostOk(`${vizMark(hash)}.localhost:8081`, 8080) && !isolatedHostOk('evil.example:8080', 8080)
      && !isolatedHostOk('127.0.0.1:8080', 8080) && !isolatedHostOk('localhost.evil.com:8080', 8080)
      && !isolatedHostOk(undefined, 8080) && !isolatedHostOk(`${vizMark(hash)}.localhost`, 8080)
      && !isolatedHostOk('localhost:80x', 8080));
    t.ok('port は 10 進の数字だけ（0x・空白・+・.0・指数・8 進っぽい形は断る）',
      !isolatedHostOk('localhost:0x1f90', 8080) && !isolatedHostOk('localhost: 8080', 8080)
      && !isolatedHostOk('localhost:8080 ', 8080) && !isolatedHostOk('localhost:+8080', 8080)
      && !isolatedHostOk('localhost:8080.0', 8080) && !isolatedHostOk('localhost:8.08e3', 8080)
      && !isolatedHostOk('localhost:08080', 8080) && !isolatedHostOk('localhost:0x8080', 0x8080)
      && isolatedHostOk('localhost:8080', 8080) && !isolatedHostOk('localhost:8080', 80800));

    // port が替わった URL の付け替え（movedPageUrl）。from は列でも受ける
    const secret = crypto.randomBytes(32);
    const keys = createHtmlKeys({ secret });
    const html = path.join(scratch, 'work', 'page.html');
    await fs.mkdir(path.dirname(html), { recursive: true });
    await fs.writeFile(html, '<p>x</p>');
    const key = keys.issue({ sessionId: 's1', path: html });
    const from = { pages: [4111, 4222], isolated: [4333] }, to = { pages: 5001, isolated: 5002 };
    const page = movedPageUrl(`http://localhost:4111/_pleiad/s/s1/file?path=${encodeURIComponent(html)}`, { from, to });
    const viz = movedPageUrl(`http://localhost:4333/viz/${hash}/index.html?embed=tab`, { from, to });
    const markedViz = movedPageUrl(`http://${vizMark(hash)}.localhost:4333/viz/${hash}/a.png`, { from, to });
    const file = movedPageUrl(`http://${fileMark(secret, path.dirname(html))}.localhost:4333/f/${encodeURIComponent(key)}/page.html`, { from, to, secret, htmlKeys: keys });
    t.ok('ファイルのページの port は付け替える', page === `http://localhost:5001/_pleiad/s/s1/file?path=${encodeURIComponent(html)}`);
    t.ok('束の URL は印の出どころと新しい port へ', viz === `http://${vizMark(hash)}.localhost:5002/viz/${hash}/index.html?embed=tab`
      && markedViz === `http://${vizMark(hash)}.localhost:5002/viz/${hash}/a.png`);
    t.ok('鍵の URL はフォルダーの印と新しい port へ（鍵が引ければ付け替えられる）',
      file === `http://${fileMark(secret, path.dirname(html))}.localhost:5002/f/${encodeURIComponent(key)}/page.html`);
    t.ok('Pleiad でなかった port・外の URL・引けない鍵・壊れた URL は付け替えない',
      movedPageUrl('http://localhost:9999/_pleiad/s/s1/file', { from, to }) === null
      && movedPageUrl(`https://example.com/viz/${hash}`, { from, to }) === null
      && movedPageUrl(`http://localhost:4333/f/${'A'.repeat(22)}/x.html`, { from, to }) === null
      && movedPageUrl('not a url', { from, to }) === null
      && movedPageUrl(`http://localhost:4333/viz/${hash}/index.html`, { from, to: { pages: 5001 } }) === null);

    // 開いているファイル・フォルダーの見張り（page-watch）
    const events = [];
    const watchers = new Map();   // dir -> listener（試験が自ら動かす）
    const watch = createPageWatch({
      watch: (dir, listener) => { watchers.set(dir, listener); return { close() { watchers.delete(dir); } }; },
      emit: (sessionId, file) => events.push({ sessionId, file }), debounceMs: 20 });
    const fileA = path.join(scratch, 'w', 'a.md'), fileB = path.join(scratch, 'w', 'b.md');
    watch.add('s1', fileA, 'file');
    watch.add('s2', fileA, 'file');
    watch.add('s1', fileB, 'file');
    t.ok('同じフォルダーには watch を 1 枚だけ張る', watchers.size === 1);
    const listener = watchers.get([...watchers.keys()][0]);
    listener('change', 'a.md');
    listener('change', 'a.md');   // 連続はまとめる
    await waitFor(() => events.length === 2, 2000);
    t.ok('変わったファイルを見ている会話へだけ知らせる（同じファイルを見ている 2 会話へ 1 回ずつ）',
      JSON.stringify(events.map(e => e.sessionId).sort()) === '["s1","s2"]' && events.every(e => e.file === fileA));
    events.length = 0;
    listener('change', 'b.md'); await wait(60);
    t.ok('ほかのファイルは別の会話へ', events.length === 1 && events[0].sessionId === 's1' && events[0].file === fileB);
    events.length = 0;
    watch.add('s9', path.join(scratch, 'w'), 'dir');
    listener('rename', 'anything.txt');
    await waitFor(() => events.length === 1, 2000);
    t.ok('フォルダーの見張りは直下の子のどれかが変われば知らせる', events[0].sessionId === 's9');
    events.length = 0;
    watch.removeSession('s1');
    listener('change', 'a.md'); listener('change', 'b.md'); await wait(60);
    t.ok('会話ぶんを消すと、その会話へはもう知らせない', events.every(e => e.sessionId !== 's1'));
    events.length = 0;
    // 持ち主（画面×タブ）ごとの数え方: 1 つの持ち主が外しても、同じ会話の別のタブ・別の会話の分は残る（指摘 3）
    watch.add('s3', fileA, 'file', 'screen:a/page:1');
    watch.add('s3', fileA, 'file', 'screen:a/page:2');
    watch.add('s4', fileA, 'file', 'screen:b/page:1');
    watch.remove('s3', fileA, 'file', 'screen:a/page:1');
    listener('change', 'a.md'); await waitFor(() => events.length === 4, 2000);
    t.ok('1 つの持ち主が外しても、同じ会話の別のタブと別の会話の分は残る（s2・フォルダーの s9 も）',
      JSON.stringify(events.map(e => e.sessionId).sort()) === '["s2","s3","s4","s9"]');
    events.length = 0;
    watch.removeClient('screen:a');
    listener('change', 'a.md'); await wait(60);
    t.ok('画面の持ち主ぶんを消すとその画面ぶんだけ外れる（s3 の両タブが外れ、s2・s4・s9 は残る）',
      JSON.stringify(events.map(e => e.sessionId).sort()) === '["s2","s4","s9"]');
    events.length = 0;
    watch.removeSession('s3'); watch.removeSession('s4');
    watch.close();
    t.ok('close は全部の watch を畳む', watchers.size === 0 && watch.stats().targets === 0);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
