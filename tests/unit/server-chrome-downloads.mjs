// 会話の Chrome のウィンドウのダウンロードの、サーバー側の配線（docs/inapp-browser.md「ダウンロード」、ADR 0328）:
//   - 操作（browser.listDownloads・browser.cancelDownload）: エージェントは自分の会話の一覧だけ読める・止めるのは画面とリモートの端末だけ
//   - ply_browser の list_downloads: 中継のあるホストだけに載る・引数の検査・待ちにターンの中断の合図を渡す
//   - 会話の行（present kind: 'chromeDownload'）: 決まった項目だけを残す
//   - サーバー越し: 偽の Chrome のダウンロードが、画面の一覧（tab:downloads）・list_downloads・会話の行・「止める」までつながる
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { registry } from '../../core/ops/index.mjs';
import { createBrowserBridge, downloadTools, DOWNLOAD_TOOLS } from '../../core/browser-bridge.mjs';
import { DOWNLOAD_WAIT_MAX_SECONDS } from '../../core/chrome/downloads.mjs';
import { chromeDownloadLine } from '../../core/history.mjs';
import { agentT } from '../../core/i18n.mjs';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { cleanupTestHolder } from '../lib/cleanup-test-holder.mjs';

export const name = 'server-chrome-downloads';
export const title = '会話の Chrome のウィンドウのダウンロード（サーバー側）: 操作・ply_browser の list_downloads・会話の行・画面の一覧と「止める」（偽の Chrome・parentPort の身代わり。ADR 0328）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return false;
    await sleep(20);
  }
  return true;
}
const fail = p => p.then(() => null, e => ({ code: e.code, message: e.message }));
const row = (id, state, extra = {}) => ({ id, state, name: `${id}.zip`, receivedBytes: 10, totalBytes: 100, pageUrl: 'https://site.example/', startedAt: '2026-11-14T00:00:00.000Z', ...extra });

export default async function (t) {
  // ===== 1. 操作（core/ops/browser.mjs） =====
  {
    const calls = [];
    const rows = { one: [row('a', 'downloading')], two: [row('b', 'completed', { path: 'C:\\Users\\u\\Downloads\\b.zip' })] };
    const downloads = {
      list: id => { calls.push(['list', id]); return rows[id] ?? []; },
      wait: async (id, seconds, signal) => { calls.push(['wait', id, seconds, signal]); },
      stop: async (id, guid) => { calls.push(['stop', id, guid]); return { stopped: guid === 'a' }; },
    };
    const deps = { locale: 'ja', chrome: { status: () => ({ state: 'connected' }), downloads }, modeOf: async () => ({ scope: 'readonly', autonomy: 'ask' }) };
    const agent = { by: 'agent', via: 'mcp', sessionId: 'one' };
    const human = { by: 'human', via: 'ui', local: true };
    const remote = { by: 'human', via: 'ui', local: false };

    const own = await registry.invoke(agent, 'browser.listDownloads', {}, deps);
    t.ok('エージェントは、会話を省くと自分の会話の一覧を読む（読み取り専用モードでも通る）', own.ok === true && own.result.downloads[0].id === 'a' && JSON.stringify(calls) === JSON.stringify([['list', 'one']]), JSON.stringify(own));
    const same = await registry.invoke(agent, 'browser.listDownloads', { sessionId: 'one' }, deps);
    t.ok('自分の会話の ID を渡しても同じ', same.ok === true && same.result.downloads[0].id === 'a');
    const other = await registry.invoke(agent, 'browser.listDownloads', { sessionId: 'two' }, deps);
    t.ok('エージェントは、ほかの会話の一覧を読めない（理由と次の手の文で断る）', other.ok === false && other.code === 'INVALID' && other.error === agentT('ja', 'ops.errors.chromeDownloadOwnSession') && !calls.some(c => c[1] === 'two'), JSON.stringify(other));
    const unbound = await registry.invoke({ by: 'agent', via: 'mcp', sessionId: null }, 'browser.listDownloads', {}, deps);
    t.ok('会話に結び付いていないエージェントは INVALID', unbound.ok === false && unbound.code === 'INVALID', JSON.stringify(unbound));

    calls.length = 0;
    const signal = new AbortController().signal;
    const waited = await registry.invoke(agent, 'browser.listDownloads', { wait: 30 }, { ...deps, signal });
    t.ok('wait を渡すと、その秒数とターンの中断の合図で待ってから一覧を返す', waited.ok === true && calls[0][0] === 'wait' && calls[0][1] === 'one' && calls[0][2] === 30 && calls[0][3] === signal && calls[1][0] === 'list', JSON.stringify(calls.map(c => c.slice(0, 3))));
    const tooLong = await registry.invoke(agent, 'browser.listDownloads', { wait: DOWNLOAD_WAIT_MAX_SECONDS + 1 }, deps);
    t.ok(`wait の上限は ${DOWNLOAD_WAIT_MAX_SECONDS} 秒`, tooLong.ok === false && tooLong.code === 'INVALID' && DOWNLOAD_WAIT_MAX_SECONDS === 120);

    const screen = await registry.invoke(human, 'browser.listDownloads', { sessionId: 'two' }, deps);
    t.ok('画面は会話を指定して読む（保存したパスは終わったものだけ）', screen.ok === true && screen.result.downloads[0].path === 'C:\\Users\\u\\Downloads\\b.zip' && own.result.downloads[0].path === undefined);
    t.ok('画面が会話を省くと INVALID', (await registry.invoke(human, 'browser.listDownloads', {}, deps)).code === 'INVALID');

    const list = registry.get('browser.listDownloads'), cancel = registry.get('browser.cancelDownload');
    t.ok('browser.listDownloads は read で、画面と MCP に出す（CLI は自分の会話が無いので出さない）', list.risk === 'read' && list.surfaces.ui === true && list.surfaces.mcp === 'catalog' && list.surfaces.cli === false);
    t.ok('browser.cancelDownload は write で、画面とリモートの端末だけ（MCP・CLI に出さない・ホストの画面に限らない）', cancel.risk === 'write' && cancel.surfaces.ui === true && cancel.surfaces.mcp === false && cancel.surfaces.cli === false && cancel.hostScreenOnly === false);
    calls.length = 0;
    const fromAgent = await registry.invoke(agent, 'browser.cancelDownload', { sessionId: 'one', id: 'a' }, deps);
    t.ok('エージェントからの「止める」は見つからない扱いで、止めない', fromAgent.ok === false && fromAgent.code === 'NOT_FOUND' && calls.length === 0, JSON.stringify(fromAgent));
    const stopped = await registry.invoke(human, 'browser.cancelDownload', { sessionId: 'one', id: 'a' }, deps);
    const notStopped = await registry.invoke(remote, 'browser.cancelDownload', { sessionId: 'one', id: 'zzz' }, deps);
    t.ok('画面・リモートの端末からの「止める」は、止められたかを返す', stopped.ok === true && stopped.result.stopped === true && notStopped.ok === true && notStopped.result.stopped === false
      && JSON.stringify(calls) === JSON.stringify([['stop', 'one', 'a'], ['stop', 'one', 'zzz']]), JSON.stringify(calls));

    const none = await registry.invoke(human, 'browser.listDownloads', { sessionId: 'one' }, { locale: 'ja', chrome: { status: () => ({ state: 'unsupported' }), downloads: null } });
    const noneStop = await registry.invoke(human, 'browser.cancelDownload', { sessionId: 'one', id: 'a' }, { locale: 'ja', chrome: { status: () => ({ state: 'off' }), downloads: null } });
    t.ok('中継の無いホストでは UNSUPPORTED', none.ok === false && none.code === 'UNSUPPORTED' && noneStop.ok === false && noneStop.code === 'UNSUPPORTED', JSON.stringify([none, noneStop]));
  }

  // ===== 2. ply_browser の list_downloads（core/browser-bridge.mjs） =====
  {
    const bridge = createBrowserBridge({ handoffs: {} });
    const rpcServer = http.createServer((req, res) => bridge.handle(req, res));
    await new Promise(resolve => rpcServer.listen(0, '127.0.0.1', resolve));
    const signal = new AbortController().signal;
    let owner = () => ({ sessionId: 'one', signal });
    const binding = bridge.open({ origin: `http://127.0.0.1:${rpcServer.address().port}`, owner: () => owner(), locale: 'ja' });
    const rpc = async (method, params) => (await (await fetch(binding.url, { method: 'POST', headers: { ...binding.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
    try {
      const names = async () => (await rpc('tools/list')).tools.map(x => x.name);
      const before = await names();
      const refused = await rpc('tools/call', { name: 'list_downloads', arguments: {} });
      t.ok('本体を差し込まないホストでは、一覧に載せず、呼び出しも断る', !before.includes('list_downloads') && refused.isError === true, JSON.stringify([before, refused]));

      const calls = [];
      bridge.useDownloads({ list: async (sessionId, args, locale, sig) => { calls.push({ sessionId, args, locale, sig }); if (args.wait === 7) throw new Error('LIST-FAILED'); return { downloads: [row('a', 'downloading')] }; } });
      const tool = (await rpc('tools/list')).tools.find(x => x.name === 'list_downloads');
      t.ok('差し込むと tools/list に list_downloads が載る（引数は wait だけ。説明は会話の言語）', JSON.stringify(DOWNLOAD_TOOLS) === '["list_downloads"]' && tool?.description === agentT('ja', 'browserBridge.listDownloads.description')
        && JSON.stringify(Object.keys(tool.inputSchema.properties)) === '["wait"]' && tool.inputSchema.additionalProperties === false && tool.inputSchema.properties.wait.maximum === DOWNLOAD_WAIT_MAX_SECONDS
        && downloadTools('en')[0].description === agentT('en', 'browserBridge.listDownloads.description') && downloadTools('en')[0].description !== tool.description, JSON.stringify(tool));
      const listed = await rpc('tools/call', { name: 'list_downloads' });
      t.ok('呼ぶと、その会話の一覧を JSON の字で返す', listed.isError === false && JSON.parse(listed.content[0].text).downloads[0].id === 'a' && calls[0].sessionId === 'one' && JSON.stringify(calls[0].args) === '{}' && calls[0].locale === 'ja', JSON.stringify(listed));
      const waited = await rpc('tools/call', { name: 'list_downloads', arguments: { wait: 20 } });
      t.ok('wait は秒数のまま渡し、ターンの中断の合図も渡す', waited.isError === false && calls[1].args.wait === 20 && calls[1].sig === signal && calls[0].sig === signal);
      const count = calls.length;
      const bad = [await rpc('tools/call', { name: 'list_downloads', arguments: { wait: '5' } }), await rpc('tools/call', { name: 'list_downloads', arguments: { wait: -1 } }),
        await rpc('tools/call', { name: 'list_downloads', arguments: { wait: DOWNLOAD_WAIT_MAX_SECONDS + 1 } }), await rpc('tools/call', { name: 'list_downloads', arguments: { path: 'C:\\work' } }),
        await rpc('tools/call', { name: 'list_downloads', arguments: [] })];
      t.ok('引数が正しくなければ断る（数でない・範囲の外・知らない引数。本体は呼ばない）', bad.every(r => r.isError === true && r.content[0].text === agentT('ja', 'browserBridge.invalidTool')) && calls.length === count, JSON.stringify(bad.map(r => r.isError)));
      const failed = await rpc('tools/call', { name: 'list_downloads', arguments: { wait: 7 } });
      t.ok('本体が断った文は、そのままエラーで返す', failed.isError === true && failed.content[0].text === 'LIST-FAILED');
      owner = () => ({ sessionId: null });
      const noTurn = await rpc('tools/call', { name: 'list_downloads' });
      t.ok('ターンに結び付かない呼び出しは断る', noTurn.isError === true && noTurn.content[0].text === agentT('ja', 'browserBridge.handToUser.noTurn'));
      bridge.useDownloads(null);
      t.ok('外すと一覧から消える', !(await names()).includes('list_downloads'));
    } finally { binding.close(); rpcServer.close(); rpcServer.closeAllConnections(); }
  }

  // ===== 3. 会話の行の中身（core/history.mjs） =====
  {
    const done = chromeDownloadLine({ name: 'report.zip', state: 'completed', size: 50_540_544.9, path: 'C:\\Users\\u\\Downloads\\report.zip', extra: 'x' });
    t.ok('終わった行: 名前・状態・大きさ・保存したパスだけを残す', JSON.stringify(done) === JSON.stringify({ name: 'report.zip', state: 'completed', size: 50_540_544, path: 'C:\\Users\\u\\Downloads\\report.zip' }), JSON.stringify(done));
    const stopped = chromeDownloadLine({ name: 'a.zip', state: 'canceled', size: 10, path: 'C:\\x\\a.zip' });
    const failed = chromeDownloadLine({ name: 'b.zip', state: 'failed', size: -1 });
    t.ok('止めた・できなかった行には、パスを残さない（大きさが分からなければ 0）', stopped.state === 'canceled' && stopped.path === null && failed.state === 'failed' && failed.path === null && failed.size === 0);
    const odd = chromeDownloadLine({ name: 'x'.repeat(500), state: 'downloading', size: Number.NaN, path: 42 });
    t.ok('決まっていない状態・長すぎる名前・数でない大きさは、決まった形に倒す', odd.state === 'failed' && odd.name.length === 300 && odd.size === 0 && odd.path === null && chromeDownloadLine(null).name === '');
  }

  // ===== 4. サーバー越し: 偽の Chrome のダウンロードが、画面の一覧・list_downloads・会話の行・「止める」までつながる =====
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-chrome-downloads-'));
  const entry = path.join(ROOT, 'tests', 'lib', 'parent-port-server.mjs');
  const chrome = await startFakeChrome({ permission: 'hold' });
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir);
  const s = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_CHROME_USER_DATA: chrome.userDataDir }, dataDir, entry });
  let u;
  try {
    u = await open({ port: s.port, token: s.token, autoAllow: true });
    const turn = await u.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'ok' });
    const sessionId = turn.sessionId;
    await u.cmd('watchSession', { sessionId });
    const opening = u.cmd('chromeNavigate', { sessionId, action: 'new', input: 'https://files.example/' });
    await until(() => chrome.pending() >= 1);
    chrome.approve();
    const opened = await opening;
    const lists = () => u.events.filter(e => e.type === 'tab:downloads' && e.sessionId === sessionId);
    const lines = () => u.events.filter(e => e.type === 'present' && e.sessionId === sessionId && e.kind === 'chromeDownload');
    const tool = async (args) => {
      const r = await u.runTurn({ backend: 'fake', cwd: ROOT, sessionId, prompt: `browser:${JSON.stringify({ name: 'list_downloads', arguments: args })}` });
      const result = r.events.find(e => e.type === 'tool.result');
      return { isError: result?.isError, text: result?.text ?? '', tools: r.tools };
    };

    const empty = await tool({});
    t.ok('ply_browser の list_downloads は、中継のあるホストのターンから呼べる（まだ何も無ければ空）', empty.isError === false && JSON.stringify(JSON.parse(empty.text).downloads) === '[]' && JSON.stringify(empty.tools) === '["mcp__ply_browser__list_downloads"]', JSON.stringify(empty));

    // ---- 始まり → 画面の一覧。進行中は会話に行を出さない
    const g1 = chrome.browser.download(opened.targetId, { url: 'https://files.example/report-2026-10.zip', name: 'report-2026-10.zip', total: 1000 });
    t.ok('会話のタブで始まったダウンロードが、見ている画面の一覧（tab:downloads）に進行中で届く', await until(() => lists().at(-1)?.downloads[0]?.state === 'downloading')
      && lists().at(-1).downloads[0].name === 'report-2026-10.zip' && lists().at(-1).downloads[0].stoppable === true, JSON.stringify(lists().at(-1)));
    chrome.browser.downloadProgress(g1, { received: 400, total: 1000 });
    const running = await tool({});
    const first = JSON.parse(running.text || '{}').downloads?.[0];
    t.ok('list_downloads は進行中のものを返す（保存したパスはまだ無い）', running.isError === false && first?.state === 'downloading' && first.name === 'report-2026-10.zip' && first.totalBytes === 1000 && first.path === undefined
      && first.pageUrl === 'https://files.example/', running.text);
    t.ok('進行中は会話に行を出さない', lines().length === 0);

    // ---- 終わり → 会話の行と、保存したパス
    const saved = path.join(scratch, 'Downloads', 'report-2026-10.zip');
    chrome.browser.downloadProgress(g1, { received: 1000, total: 1000, state: 'completed', filePath: saved });
    t.ok('終わると会話に 1 行（present kind: chromeDownload。名前・大きさ・保存したパス）が届く', await until(() => lines().length === 1)
      && JSON.stringify(lines()[0].chromeDownload) === JSON.stringify({ name: 'report-2026-10.zip', state: 'completed', size: 1000, path: saved }), JSON.stringify(lines()));
    const done = JSON.parse((await tool({ wait: 5 })).text || '{}').downloads?.[0];
    t.ok('list_downloads は終わったものの保存したパスを返す（進行中が無ければ wait は待たない）', done?.state === 'completed' && done.path === saved && done.receivedBytes === 1000, JSON.stringify(done));
    const loaded = await u.cmd('loadSession', { sessionId });
    const kept = loaded.presents?.find(p => p.kind === 'chromeDownload');
    t.ok('行は会話の履歴に残る（開き直しても出る）', JSON.stringify(kept?.chromeDownload) === JSON.stringify({ name: 'report-2026-10.zip', state: 'completed', size: 1000, path: saved }), JSON.stringify(loaded.presents ?? null).slice(0, 300));

    // ---- 人が止める → 画面の一覧と会話の行。エージェントからは止められない
    const g2 = chrome.browser.download(opened.targetId, { url: 'https://files.example/big.iso', name: 'big.iso', total: 5000 });
    await until(() => lists().at(-1)?.downloads[0]?.id === g2);
    const strangerStop = await u.cmd('invoke', { op: 'browser.cancelDownload', args: { sessionId: 'nobody', id: g2 } });
    t.ok('ほかの会話を指した「止める」は止めない', strangerStop?.stopped === false && chrome.browser.downloadState(g2) === 'inProgress', JSON.stringify(strangerStop));
    const stop = await u.cmd('invoke', { op: 'browser.cancelDownload', args: { sessionId, id: g2 } });
    t.ok('画面の「ダウンロードを止める」（browser.cancelDownload）で止まる', stop?.stopped === true && await until(() => chrome.browser.downloadState(g2) === 'canceled'), JSON.stringify(stop));
    t.ok('止めたものは、一覧で「止めました」（canceled）になり、会話に 1 行が届く（パスは無い）', await until(() => lists().at(-1)?.downloads[0]?.state === 'canceled') && await until(() => lines().length === 2)
      && JSON.stringify(lines()[1].chromeDownload) === JSON.stringify({ name: 'big.iso', state: 'canceled', size: 5000, path: null }), JSON.stringify(lines()[1]));
    const viaUi = await u.cmd('invoke', { op: 'browser.listDownloads', args: { sessionId } });
    t.ok('画面からも一覧を読める（新しい順）', viaUi?.downloads?.map(d => `${d.name}:${d.state}`).join() === 'big.iso:canceled,report-2026-10.zip:completed', JSON.stringify(viaUi));
    const bad = await fail(u.cmd('invoke', { op: 'browser.cancelDownload', args: { id: g2 } }));
    t.ok('会話を省いた「止める」は入力の検査で断る', bad?.code === 'INVALID', JSON.stringify(bad));

    // ---- Chrome が自分で止めた（失敗）→ 「ダウンロードできませんでした」の行
    const g3 = chrome.browser.download(opened.targetId, { url: 'https://files.example/broken.zip', name: 'broken.zip', total: 300 });
    await until(() => lists().at(-1)?.downloads[0]?.id === g3);
    chrome.browser.downloadProgress(g3, { received: 100, total: 300, state: 'canceled' });
    t.ok('Chrome の側で止まったものは failed の行になる', await until(() => lines().length === 3) && lines()[2].chromeDownload.state === 'failed' && lines()[2].chromeDownload.name === 'broken.zip' && lines()[2].chromeDownload.path === null, JSON.stringify(lines()[2]));
  } finally {
    u?.close();
    await s.stop();
    await chrome.stop?.();
    await cleanupTestHolder(dataDir);
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
