// 既定のアプリで開く（ADR 0291 の 3・ADR 0010）: 許す拡張子の一覧が 1 つだけで、サーバー（core/os-open.mjs・WS の openDefault）と
// デスクトップ版の本体（desktop/file-bridge.cjs）の両方がそれで検査すること。リンク・ジャンクションは実体の名前で決めること。
// OS の窓は開かない（起動は組み立てと偽の起動器で確かめ、サーバーは AGENT_HOST_OS_OPEN=dry で起動する）。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { DEFAULT_APP_EXTENSIONS, defaultAppAllowed, launchPlan, defaultOpener, parentPortOpener, bridgeError } from '../../core/os-open.mjs';
import { startServer } from '../lib/server.mjs';
import { open as openWs } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { checkRequest, createFileHandler } = require('../../desktop/file-bridge.cjs');

export const name = 'os-open';
export const title = '既定のアプリで開く: 許す拡張子の一覧（サーバーと本体で同じ）・実体で判断・ホストの画面だけ・連打の制限';

// ADR 0291 の 3 の最初の一覧
const ADR_LIST = ['.txt', '.md', '.pdf', '.rtf', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.csv', '.tsv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic', '.tiff',
  '.mp3', '.wav', '.flac', '.m4a', '.ogg', '.mp4', '.mov', '.webm', '.mkv'];
// 既定のアプリで開くと中身が実行されうるもの・マクロを含みうるもの・ブラウザーの側のもの
const DANGEROUS = ['.exe', '.bat', '.cmd', '.com', '.lnk', '.ps1', '.psm1', '.msi', '.msix', '.appx', '.js', '.jse', '.mjs', '.py', '.pyw',
  '.vbs', '.vbe', '.wsf', '.wsh', '.hta', '.reg', '.url', '.scr', '.pif', '.cpl', '.jar', '.application', '.appref-ms', '.settingcontent-ms',
  '.library-ms', '.search-ms', '.chm', '.iso', '.img', '.vhd', '.zip', '.docm', '.xlsm', '.pptm', '.dotm', '.html', '.htm', '.app', '.command', '.sh', '.desktop'];

export default async function (t) {
  // ---- 一覧
  assert.deepEqual([...DEFAULT_APP_EXTENSIONS].sort(), [...ADR_LIST].sort());
  assert(Object.isFrozen(DEFAULT_APP_EXTENSIONS));
  assert(DEFAULT_APP_EXTENSIONS.every(ext => /^\.[a-z0-9]+$/.test(ext)), '小文字の . 付きだけ');
  t.ok('一覧は ADR 0291 の 3 の文書・画像・音・動画の 30 種と同じで、凍らせてある', true, `${DEFAULT_APP_EXTENSIONS.length} 種`);

  for (const ext of DANGEROUS) assert.equal(defaultAppAllowed(`C:\\w\\a${ext}`), false, ext);
  assert(DANGEROUS.every(ext => !DEFAULT_APP_EXTENSIONS.includes(ext)));
  t.ok('実行されうる種類（.exe .bat .cmd .lnk .ps1 .msi .js .py .vbs .hta .reg .url .scr .com .jar .wsf など）・マクロ（.docm .xlsm）・HTML は断る', true, `${DANGEROUS.length} 種`);

  const yes = ['C:\\w\\a.pdf', 'C:/w/report.PDF', '/Users/u/movie.Mp4', 'D:\\w\\a.exe.pdf', 'D:\\w\\写真.HEIC', '/home/u/a b.csv'];
  const no = ['C:\\w\\a.pdf.exe', 'C:\\w\\a.PDF.LNK', 'C:\\w\\.pdf', 'C:\\w\\pdf', 'C:\\w\\a.pdf.', 'C:\\w\\a.pdf ', 'C:\\w\\a.txt:evil.exe',
    'C:\\w\\a.exe:x.pdf', 'C:\\w\\a\u0000.pdf', 'C:\\w\\', '', null, 42];
  for (const file of yes) assert.equal(defaultAppAllowed(file), true, file);
  for (const file of no) assert.equal(defaultAppAllowed(file), false, String(file));
  t.ok('最後の拡張子で決める（a.pdf.exe は断る）・大文字も同じ・名前の無い .pdf・末尾の . と空白・代替ストリームは断る', true);

  // ---- 起動の組み立て（起動はしない）
  const env = { SystemRoot: 'C:\\Windows' };
  const win = launchPlan('default', 'C:/a b/資料&%PATH%.pdf', { platform: 'win32', env });
  assert.equal(win.command, 'C:\\Windows\\explorer.exe');
  assert.deepEqual(win.args, ['"C:\\a b\\資料&%PATH%.pdf"']);
  assert.equal(win.options.shell, false); assert.equal(win.options.windowsVerbatimArguments, true); assert.equal(win.options.detached, true);
  assert.deepEqual(launchPlan('default', '/Users/u/a.mp4', { platform: 'darwin' }).args, ['/Users/u/a.mp4']);
  assert.equal(launchPlan('default', '/Users/u/a.mp4', { platform: 'darwin' }).command, '/usr/bin/open');
  assert.deepEqual(launchPlan('default', '/home/u/a.png', { platform: 'linux' }), { command: 'xdg-open', args: ['/home/u/a.png'], options: launchPlan('default', '/home/u/a.png', { platform: 'linux' }).options });
  for (const [file, options] of [['C:\\a\\run.bat'], ['C:\\a\\x.lnk'], ['C:\\a\\a.pdf.exe'], ['C:\\a\\page.html'], ['C:\\a\\dir.pdf', { directory: true }]]) {
    assert.throws(() => launchPlan('default', file, { platform: 'win32', env, ...options }), /既定のアプリで開けません/, file);
  }
  t.ok('起動の形は「開く」と同じ（explorer.exe を絶対パス・verbatim・シェルなし / macOS は /usr/bin/open / xdg-open）。一覧の外とフォルダーは組み立てない', true);

  // ---- 実行器: main が居なければ OS に直に、居れば main に action:'default' で頼む
  const launched = [];
  const direct = defaultOpener({ env: {}, mainPort: { hosted: false }, launchImpl: async plan => { launched.push(plan); } });
  await direct('default', path.resolve('/w/a.pdf'), { directory: false });
  await assert.rejects(async () => direct('default', path.resolve('/w/run.bat'), { directory: false }), /既定のアプリで開けません/);
  assert.equal(launched.length, 1);
  const port = new EventEmitter(); port.sent = []; port.postMessage = m => port.sent.push(m);
  const viaMain = parentPortOpener(port, { timeoutMs: 1000 });
  const pending = viaMain('default', 'C:\\w\\a.exe');
  assert.deepEqual({ ...port.sent[0], id: undefined }, { type: 'os-open', id: undefined, action: 'default', path: 'C:\\w\\a.exe', directory: false });
  port.emit('message', { type: 'os-open', id: port.sent[0].id, ok: false, code: 'type-not-allowed' });
  await assert.rejects(pending, /既定のアプリで開けません/);
  assert.match(bridgeError({ code: 'type-not-allowed' }), /既定のアプリで開けません/);
  t.ok('偽の起動器: 直の起動も一覧で断る。main への依頼は action:default で、本体の断り（type-not-allowed）は辞書の文になる', true);

  // ---- デスクトップ版（main）の確かめ直し: 偽の stat / realpath
  const stat = kind => () => ({ isDirectory: () => kind === 'dir', isFile: () => kind === 'file' });
  const links = { [path.resolve('/x/report.pdf')]: path.resolve('/x/evil.exe'), [path.resolve('/x/latest')]: path.resolve('/x/real.pdf') };
  const realpath = file => links[file] ?? file;
  const check = (file, kind = 'file', extra = {}) => checkRequest({ action: 'default', path: path.resolve(file) }, { stat: stat(kind), realpath, defaultAppAllowed, ...extra });
  assert.deepEqual(check('/x/a.pdf'), { action: 'default', file: path.resolve('/x/a.pdf'), directory: false });
  assert.equal(check('/x/latest').file, path.resolve('/x/real.pdf'), '名前に拡張子が無くても、実体が許す種類なら実体を開く');
  const code = fn => { try { fn(); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code(() => check('/x/report.pdf')), 'type-not-allowed', 'リンクの名前が .pdf でも、実体が .exe なら断る');
  assert.equal(code(() => check('/x/run.bat')), 'type-not-allowed');
  assert.equal(code(() => check('/x/a.docm')), 'type-not-allowed');
  assert.equal(code(() => check('/x/folder.pdf', 'dir')), 'type-not-allowed', 'フォルダーは既定のアプリで開かない');
  assert.equal(code(() => check('/x/a.pdf', 'file', { defaultAppAllowed: null })), 'type-not-allowed', '一覧を渡されなければ断る');
  assert.equal(code(() => check('/x/a.pdf', 'file', { realpath: () => '\\\\host\\share\\a.pdf' })), 'invalid-path', '実体がネットワークの場所なら断る');
  assert.equal(code(() => checkRequest({ action: 'default', path: '\\\\host\\share\\a.pdf' }, { stat: stat('file'), realpath, defaultAppAllowed })), 'invalid-path');
  t.ok('デスクトップ版: 実体（realpath）の名前で判断し、実体を開く。リンクの先が実行形式・フォルダー・ネットワークなら断る', true);

  const calls = [];
  let fronted = 0;
  const shell = { showItemInFolder: p => calls.push(['show', p]), openPath: async p => { calls.push(['open', p]); return ''; } };
  const handle = createFileHandler({ shell, stat: stat('file'), realpath, beforeBrowserOpen: async () => { fronted++; } });
  assert.deepEqual(await handle({ id: 1, action: 'default', path: path.resolve('/x/latest') }), { type: 'os-open', id: 1, ok: true });
  assert.equal((await handle({ id: 2, action: 'default', path: path.resolve('/x/report.pdf') })).code, 'type-not-allowed');
  assert.equal((await handle({ id: 3, action: 'default', path: path.resolve('/x/a.exe') })).code, 'type-not-allowed');
  assert.deepEqual(calls, [['open', path.resolve('/x/real.pdf')]]);
  assert.equal(fronted, 0, '既定のブラウザーの下準備（見える Chrome を前へ）は HTML のときだけ');
  t.ok('デスクトップ版: 一覧は core/os-open.mjs から読み（2 つ持たない）、shell.openPath に実体を渡す', true);

  // ---- 本物のファイル: ジャンクション（フォルダー）とファイルのリンク
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-os-open-'));
  const work = path.join(scratch, 'work'), outside = path.join(scratch, 'outside'), data = path.join(scratch, 'data');
  await Promise.all([work, outside, data, path.join(work, 'sub.pdf')].map(p => fs.mkdir(p, { recursive: true })));
  for (const name of ['doc.pdf', 'clip.mp4', 'Photo.PNG', 'run.bat', 'macro.docm', 'app.exe', 'a.pdf.exe', 'page.html', 'go.lnk']) await fs.writeFile(path.join(work, name), 'x');
  await fs.writeFile(path.join(outside, 'far.pdf'), 'x');
  await fs.writeFile(path.join(outside, 'evil.exe'), 'x');
  await fs.symlink(outside, path.join(work, 'jump'), process.platform === 'win32' ? 'junction' : 'dir');
  let fileLink = true;
  try { await fs.symlink(path.join(outside, 'evil.exe'), path.join(work, 'fake.pdf'), 'file'); }
  catch (error) { if (error.code !== 'EPERM') throw error; fileLink = false; }   // Windows でシンボリックリンクの権限が無い

  const realCalls = [];
  const realHandle = createFileHandler({ shell: { showItemInFolder() {}, openPath: async p => { realCalls.push(p); return ''; } } });
  assert.equal((await realHandle({ id: 1, action: 'default', path: path.join(work, 'jump', 'far.pdf') })).ok, true);
  assert.equal((await realHandle({ id: 2, action: 'default', path: path.join(work, 'run.bat') })).code, 'type-not-allowed');
  assert.equal((await realHandle({ id: 3, action: 'default', path: path.join(work, 'jump', 'evil.exe') })).code, 'type-not-allowed');
  if (fileLink) assert.equal((await realHandle({ id: 4, action: 'default', path: path.join(work, 'fake.pdf') })).code, 'type-not-allowed');
  assert.deepEqual(realCalls, [await fs.realpath(path.join(outside, 'far.pdf'))]);
  t.ok('デスクトップ版（本物のファイル）: ジャンクションの先の実体を開き、先が実行形式なら断る', true, fileLink ? 'ファイルのリンクも確かめた' : 'ファイルのリンクは権限が無く省いた');

  // ---- サーバー（起動はしない: AGENT_HOST_OS_OPEN=dry）
  await fs.writeFile(path.join(data, 'sessions.json'), JSON.stringify({ fixture: { cwd: work, backend: 'fake' } }));
  const server = await startServer({ dataDir: data, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_OS_OPEN: 'dry' } });
  let client, remote;
  try {
    client = await openWs({ port: server.port, token: server.token });
    const real = p => fs.realpath(p);
    assert.equal((await client.cmd('openDefault', { path: 'doc.pdf', sessionId: 'fixture' })).path, await real(path.join(work, 'doc.pdf')));
    assert.equal((await client.cmd('openDefault', { path: path.join(work, 'clip.mp4') })).path, await real(path.join(work, 'clip.mp4')));
    assert.equal((await client.cmd('openDefault', { path: './jump/far.pdf', sessionId: 'fixture' })).path, await real(path.join(outside, 'far.pdf')));
    t.ok('サーバー: 許す種類は作業場所からの相対でも開き、ジャンクションの先は実体のパスで開く', true);

    const refusals = [];
    for (const name of ['run.bat', 'macro.docm', 'app.exe', 'a.pdf.exe', 'page.html', 'go.lnk', 'sub.pdf', 'jump/evil.exe', ...(fileLink ? ['fake.pdf'] : [])]) {
      refusals.push(await client.cmd('openDefault', { path: name, sessionId: 'fixture' }).then(() => `${name}: 開いた`, e => /既定のアプリで開けません/.test(e.message) ? null : `${name}: ${e.message}`));
    }
    assert.deepEqual(refusals.filter(Boolean), []);
    await assert.rejects(client.cmd('openDefault', { path: 'missing.pdf', sessionId: 'fixture' }), /見つかりません/);
    await assert.rejects(client.cmd('openDefault', { path: '\\\\host\\share\\a.pdf' }), /UNC/);
    t.ok('サーバー: 一覧の外（.bat .docm .exe a.pdf.exe .html .lnk）・フォルダー・実体が実行形式のリンクを断る。無いファイル・UNC も断る', true, fileLink ? 'ファイルのリンクも' : 'ファイルのリンクは省いた');

    // 中継を通った接続（遠隔）は断る
    remote = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${server.token}`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    const replies = new Map();
    await new Promise((resolve, reject) => { remote.once('error', reject); remote.on('message', raw => { const m = JSON.parse(raw); if (m.kind === 'ready') resolve(); if (m.kind === 'response') replies.get(m.id)?.(m); }); });
    const ask = (command, args) => new Promise(resolve => { const id = `r${replies.size + 1}`; replies.set(id, resolve); remote.send(JSON.stringify({ kind: 'command', command, id, args })); });
    const refused = await ask('openDefault', { path: path.join(work, 'doc.pdf') });
    assert(!refused.ok && /サーバーのある PC/.test(refused.error), JSON.stringify(refused));
    t.ok('サーバー: 中継を通った接続（ホストの画面でない）からの openDefault は断る', true);

    // 連打: 10 秒に 5 回まで（OS の操作で共通。ここまでに 3 回通っている。断った種類は数えない）
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await client.cmd('openDefault', { path: 'Photo.PNG', sessionId: 'fixture' }).then(() => 'ok', e => e.message));
    assert.deepEqual(results.slice(0, 2), ['ok', 'ok'], results.join(' / '));
    assert(/続けて開きすぎ/.test(results[2]) && /続けて開きすぎ/.test(results[3]), results.join(' / '));
    await assert.rejects(client.cmd('revealPath', { path: path.join(work, 'doc.pdf') }), /続けて開きすぎ/);
    t.ok('サーバー: 10 秒に 5 回まで（エクスプローラーで表示と同じ枠）', true, results.join(' / '));
  } finally {
    client?.close?.(); remote?.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
