// Issue #235 の再現（ADR 0355）: 委譲の子が hand_to_user を呼んで待ちの切れ目（FAKE_COMPUTER_SLICE_MS）でターンを終え、タスクが終わって依頼元へ知らせた後で、
// 人が Chrome を「戻す」。子は「続けてください」で新しいターンを走らせる。そのターンも
//   - タスクを running → completed と動かし、最新の返答を結果にして、依頼元へ 1 回知らせる（きっかけ「Chrome を戻した続き」）
//   - 子の会話の発言は「Chrome を戻した続き」の印（sentByHandoff）。人の指示には数えない（sentByHuman を付けない）
//   - 二度押しても、走り直しは 1 回・知らせも 1 回
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { cleanupTestHolder } from '../lib/cleanup-test-holder.mjs';

export const name = 'server-chrome-handoff-wake';
export const title = 'Chrome を戻した続き（Issue #235）: 委譲の子が終わった後の続きのターンもタスクを動かし、1 回知らせる（偽の Chrome と fake の子）';
const ply = (name, args) => `ply:${JSON.stringify({ name, arguments: args })}`;
const browser = (name, args) => `browser:${JSON.stringify({ name, arguments: args })}`;

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-chrome-handoff-wake-'));
  const chrome = await startFakeChrome();
  await fs.writeFile(path.join(chrome.userDataDir, 'Local State'), JSON.stringify({ profile: { last_used: 'Default', info_cache: { Default: { name: '個人' } } } }));
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_CHROME_USER_DATA: chrome.userDataDir, FAKE_COMPUTER_SLICE_MS: '800',
    FAKE_PARENT_PORT_LOG: path.join(scratch, 'parent-port.ndjson') }, dataDir, entry: path.join(ROOT, 'tests/lib/parent-port-server.mjs') });
  const c = await open({ port: server.port, token: server.token });
  const wait = async (check, ms = 30_000) => {
    const end = Date.now() + ms; let last;
    while (Date.now() < end) { last = await check(); if (last) return last; await sleep(50); }
    throw new Error('timed out: ' + JSON.stringify(last ?? null));
  };
  const run = async args => {
    for (let i = 0; i < 100; i++) {
      try { return await c.runTurn(args); }
      catch (error) { if (!String(error.message).includes('切り替え中') || i === 99) throw error; await sleep(50); }
    }
  };
  try {
    await c.cmd('chromeConnect');
    await wait(() => c.events.some(event => event.type === 'chromeBrowser' && event.state === 'connected'));
    const parent = (await run({ backend: 'fake', cwd: ROOT, prompt: 'echo:parent' })).sessionId;
    await run({ sessionId: parent, prompt: ply('ply_delegate', { kind: 'mechanical', backend: 'fake', title: 'ログインが要る子',
      task: browser('hand_to_user', { reason: 'login', message: 'ログインしてください' }) }) });
    const rowOf = async () => (await c.cmd('agentTasks')).find(row => row.parentSessionId === parent);
    const noticesOf = (from = 0) => c.since(from).filter(e => e.type === 'taskNotice' && e.sessionId === parent);
    // 子は待ちの切れ目でターンを終え、タスクが終わって 1 回知らせる。人へのカードは残る（ADR 0168）
    const done = await wait(async () => { const row = await rowOf(); return row?.status === 'completed' && row.notification === 'sent' ? row : null; });
    const child = done.sessionId;
    t.ok('hand_to_user の後で子のターンが終わり、タスクが completed・1 回知らせた', noticesOf().length === 1, String(noticesOf().length));
    await wait(async () => (c.waitingCards).some(row => row.sessionId === child && !row.relay));
    t.ok('人へのカードはターンの後も残る', true);

    // 子の窓を開いておく（引き継ぐ窓。見ている会話の直接の子は操作の範囲に入る）
    await c.cmd('watchSession', { sessionId: parent });
    await c.cmd('chromeNavigate', { sessionId: child, action: 'new', input: 'https://site.example/login' });
    await c.cmd('watchSession', { sessionId: null });
    const mark = c.mark();
    await c.cmd('chromeTakeOver', { sessionId: child, by: 'device', width: 390, height: 700, scale: 2 });
    await c.cmd('chromeResume', { sessionId: child });
    // 二度押し（もう決着したカードへの 2 度目の「戻す」）
    await c.cmd('chromeResume', { sessionId: child }).catch(() => null);
    const woke = await wait(async () => { const row = await rowOf(); return row?.status === 'running' || noticesOf(mark).length ? row : null; });
    t.ok('戻した続きのターンで、タスクが running に戻る（または既に止まって知らせた）', woke.status === 'running' || noticesOf(mark).length === 1, woke.status);
    const after = await wait(async () => { const row = await rowOf(); return row?.status === 'completed' && row.notification === 'sent' && noticesOf(mark).length ? row : null; });
    await sleep(1500);
    const notices = noticesOf(mark);
    t.ok('続きのターンが止まったら completed・sent になり、1 回だけ知らせる', notices.length === 1, notices.map(n => n.text).join(' ||| '));
    t.ok('知らせのきっかけは「Chrome を戻した続き」', /（きっかけ：Chrome を戻した続き）/.test(notices[0]?.text ?? ''), notices[0]?.text);
    t.ok('人の指示には数えない', !after.humanInstructions, String(after.humanInstructions));
    t.ok('知らせに人の指示は載らない', !notices[0]?.text.includes('人が子に指示しました'), notices[0]?.text);
    const turns = c.since(mark).filter(e => e.type === 'turnEnd' && e.sessionId === child).length;
    t.ok('二度押しても、走り直しは 1 回', turns === 1, String(turns));

    const loaded = await c.cmd('loadSession', { sessionId: child });
    const continued = loaded.messages.filter(m => m.role === 'user' && !m.kind && /続けてください/.test(m.text ?? ''));
    assert.equal(continued.length, 1, JSON.stringify(loaded.messages.filter(m => m.role === 'user')));
    t.ok('続きの発言は 1 件で、「Chrome を戻した続き」の印が付く（読み直しても残る）', continued[0].sentByHandoff === true && !continued[0].sentByHuman, JSON.stringify(continued[0]));
    const delivered = c.since(mark).find(e => e.type === 'userMessage' && e.sessionId === child && /続けてください/.test(e.text ?? ''));
    t.ok('届いた出来事にも sentByHandoff（人の印は付けない）', delivered?.sentByHandoff === true && !delivered.sentByHuman, JSON.stringify(delivered));
  } finally {
    c.close(); await server.stop(); await cleanupTestHolder(dataDir); await chrome.stop(); await fs.rm(scratch, { recursive: true, force: true });
  }
}
