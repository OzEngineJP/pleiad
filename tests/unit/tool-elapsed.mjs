// 走っているツールの経過を、ツールが本当に始まった時刻から数える。
// サーバーは tool.start に受けた時刻（at）を付け（core/server.mjs の makeEmit）、実行中のスナップショット（stream.events）にも同じ値が残る。
// 画面はその時刻を起点にする（web/server-clock.mjs → markRunning・Bundle・activity）。開き直し・再接続の再生で 0 に戻らない。
// 実ブラウザーで開き直したときの見え方は、fake の画面で撮って確かめた（docs/multi-backend.md §2.2）。
//
// DOM シムは tests/run.mjs が入口で入れている。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { markRunning, Bundle, secs, clock } from '../../web/tool-bundle.mjs';
import { renderToolCall } from '../../web/render.mjs';
import { streamMessages } from '../../web/stream-messages.mjs';
import { localTime, syncServerClock, toolStartedAt } from '../../web/server-clock.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'tool-elapsed';
export const title = '走っているツールの経過: サーバーが受けた時刻から数え、開き直し・再接続でも 0 に戻らない';

const json = (x) => JSON.stringify(x);
const read = (p) => fs.readFile(path.join(ROOT, p), 'utf8');
const elapsedOf = (card) => card.querySelector('.tc-elapsed')?.textContent ?? '';
/** 8s・2:05・1:02:05 を秒にする */
const secondsOf = (text) => (text.endsWith('s') ? Number.parseInt(text, 10) : text.split(':').map(Number).reduce((a, n) => a * 60 + n, 0));

export default async function (t) {
  // ---- 画面の時計とサーバーの時計
  {
    syncServerClock(undefined);
    const now = Date.now();
    t.ok('ずれが分からない（古いサーバー）ときは、サーバーの時刻をそのまま使う', Math.abs(localTime(now - 5000) - (now - 5000)) < 50);
    t.ok('ISO の文字列（ターンの startedAt）も読む', Math.abs(localTime(new Date(now - 60_000).toISOString()) - (now - 60_000)) < 50);
    t.ok('読めない時刻は null（呼ぶ側が今にする）', localTime(undefined) === null && localTime('x') === null && localTime(null) === null);
    t.ok('先の時刻は今に寄せる（負の経過を出さない）', localTime(Date.now() + 60_000) <= Date.now());

    // リモートの端末: サーバーの時計が 10 分進んでいる
    syncServerClock(Date.now() + 600_000);
    const serverAt = Date.now() + 600_000 - 120_000;   // サーバーの時計で 2 分前
    const local = localTime(serverAt);
    t.ok('時計がずれた端末では、ready の now で補って 2 分前にする', Math.abs(Date.now() - local - 120_000) < 200, String(Date.now() - local));
    syncServerClock(Date.now() - 300_000);   // 逆に 5 分遅れている
    const behind = localTime(Date.now() - 300_000 - 30_000);
    t.ok('遅れている時計も同じく補う', Math.abs(Date.now() - behind - 30_000) < 200, String(Date.now() - behind));
    syncServerClock(undefined);

    const t0 = Date.now() - 90_000;
    t.ok('ツールの始まりは、バックエンドの申告（startedAt）を先に見て、無ければサーバーが受けた時刻（at）',
      Math.abs(toolStartedAt({ at: Date.now(), startedAt: t0 }) - t0) < 50 && Math.abs(toolStartedAt({ at: t0 }) - t0) < 50 && toolStartedAt({}) === null);
  }

  // ---- 走っている行と、まとまりの見出し
  {
    const card = renderToolCall('Bash', { command: 'sleep 9999' }, { id: 'c1' });
    markRunning(card, Date.now() - 120_000);
    const res = card.querySelector('.tc-res');
    res.paint(Date.now());
    t.ok('2 分前に始まったツールの行は、描き直しても 2:00 以上を出す（1 分以上は m:ss）', /^\d+:\d\d$/.test(elapsedOf(card)) && secondsOf(elapsedOf(card)) >= 120, elapsedOf(card));

    const long = renderToolCall('Bash', { command: 'npm run build' }, { id: 'c3' });
    markRunning(long, Date.now() - (12 * 3600 + 125) * 1000);
    long.querySelector('.tc-res').paint(Date.now());
    t.ok('12 時間前に始まったツールの行は h:mm:ss（12:02:05 以上。43325s とは出さない）',
      /^\d+:\d\d:\d\d$/.test(elapsedOf(long)) && secondsOf(elapsedOf(long)) >= 12 * 3600 + 125 && elapsedOf(long).startsWith('12:02:'), elapsedOf(long));

    const fresh = renderToolCall('Bash', { command: 'ls' }, { id: 'c2' });
    markRunning(fresh);
    fresh.querySelector('.tc-res').paint(Date.now());
    t.ok('始まりが分からないときは今から数える（今までと同じ。1 分未満は 0s の形）', /^\d+s$/.test(elapsedOf(fresh)) && secondsOf(elapsedOf(fresh)) < 2, elapsedOf(fresh));
    t.ok('行の経過の形: 1 分未満は 8s、それ以上は見出しと同じ m:ss、1 時間以上は h:mm:ss',
      secs(8_000) === '8s' && secs(59_999) === '59s' && secs(60_000) === '1:00' && secs(125_000) === '2:05'
      && secs(3_600_000) === '1:00:00' && secs((3600 + 62) * 1000) === '1:01:02' && secs(-5) === '0s',
      [8_000, 59_999, 60_000, 125_000, 3_600_000, (3600 + 62) * 1000].map(secs).join());

    const bundle = new Bundle({ live: true, since: Date.now() - 125_000 });
    for (const id of ['b1', 'b2']) {
      const c = renderToolCall('Read', { file_path: `D:/x/${id}.txt` }, { id });
      markRunning(c, Date.now() - 125_000);
      bundle.add(c);
    }
    bundle.head.paint();
    t.ok('まとまりの見出しの経過は、最初のツールの始まりから（2:05 前なら 2:05 以上）', secondsOf(bundle.elEl.textContent) >= 125, bundle.elEl.textContent);
    const longBundle = new Bundle({ live: true, since: Date.now() - (3600 + 125) * 1000 });
    longBundle.head.paint();
    t.ok('1 時間を越えたまとまりの見出しは h:mm:ss（1:02:05）', longBundle.elEl.textContent === '1:02:05', longBundle.elEl.textContent);
    t.ok('見出しの形: m:ss、1 時間以上は h:mm:ss', clock(0) === '0:00' && clock(3599) === '59:59' && clock(3600) === '1:00:00' && clock(12 * 3600 + 125) === '12:02:05');
    const plain = new Bundle({ live: true });
    plain.head.paint();
    t.ok('起点を渡さないまとまりは今から（0:00）', plain.elEl.textContent === '0:00', plain.elEl.textContent);
  }

  // ---- 実行中のスナップショットを畳んだ呼び出し（チャンネルのスレッド）も始まりの時刻を持つ
  {
    const at = Date.now() - 200_000;
    const { messages } = streamMessages([
      { type: 'tool.start', id: 'x1', name: 'Bash', input: {}, at },
      { type: 'tool.start', id: 'x2', name: 'Bash', input: {}, at, startedAt: at - 1000 },
      { type: 'tool.start', id: 'x3', name: 'Bash', input: {} },
    ]);
    const calls = messages[0]?.toolCalls ?? [];
    t.ok('畳んだ呼び出しに at・startedAt が残り、無い出来事には足さない',
      calls[0]?.at === at && calls[1]?.startedAt === at - 1000 && !('at' in calls[2]) && !('startedAt' in calls[2]), json(calls));
  }

  // ---- 配線（client.mjs・thread-tools.mjs は文字列で）
  {
    const client = await read('web/client.mjs');
    const thread = await read('web/channels/thread-tools.mjs');
    const server = await read('core/server.mjs');
    t.ok('tool.start の行と、新しく作るまとまりの見出しに、始まりの時刻を渡す',
      client.includes('const since = toolStartedAt(ev);') && client.includes('markRunning(card, since);')
      && client.includes('liveBundle(isComputerTool(ev.name) ? "computer" : "tools", since)') && client.includes('new Bundle({ live: true, kind, since,'));
    t.ok('ready の now で時計のずれを覚える', client.includes('syncServerClock(m.now);') && /startedAt: SERVER_STARTED_AT,\s*\n(\s*\/\/[^\n]*\n)*\s*now: Date\.now\(\),/.test(server));
    t.ok('最下部の進行中の行は、走っているターンの始まりから数える',
      client.includes('const turnStartHere = () => localTime((state.work.turns ?? []).find(belongsHere)?.startedAt);')
      && (client.match(/if \(!this\.t0\) this\.t0 = turnStartHere\(\) \?\? Date\.now\(\);/g) ?? []).length === 2);
    t.ok('スレッドの走っている行も呼び出しの始まりから数える', thread.includes('markRunning(card, toolStartedAt(c))'));
  }

  // ---- サーバー越し: tool.start に受けた時刻が付き、実行中のスナップショットでも同じ値
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-tool-elapsed-'));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake' } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  try {
    t.ok('ready にサーバーの今の時刻（now）が載る', Number.isFinite(c.ready.now) && Math.abs(c.ready.now - Date.now()) < 10_000, String(c.ready.now));
    const from = c.mark();
    const script = { steps: [{ tool: 'Bash', input: { command: 'sleep 4' }, result: 'done', ms: 4000 }] };
    const before = Date.now();
    await c.cmd('runTurn', { backend: 'fake', cwd: ROOT, prompt: `steps:${JSON.stringify(script)}` });
    const ev = await c.waitFor(e => e.type === 'tool.start' && e.name === 'Bash', { from, ms: 20_000 });
    t.ok('流れてきた tool.start に、サーバーが受けた時刻（ms）が付く', Number.isFinite(ev.at) && ev.at >= before - 1000 && ev.at <= Date.now() + 1000, json(ev));
    await sleep(1500);
    // 開き直し・再接続: 実行中のスナップショットを読み直す
    const data = await c.cmd('loadSession', { sessionId: ev.sessionId, live: true });
    const replayed = (data.stream?.events ?? []).find(e => e.type === 'tool.start' && e.id === ev.id);
    t.ok('読み直したスナップショットの tool.start は、最初に受けた時刻のまま（再生で今にならない）', replayed?.at === ev.at, json(replayed));
    const c2 = await open({ port: server.port, token: server.token });
    try {
      const again = await c2.cmd('loadSession', { sessionId: ev.sessionId, live: true });
      const ev2 = (again.stream?.events ?? []).find(e => e.type === 'tool.start' && e.id === ev.id);
      t.ok('別の接続（再接続・別の端末）から読んでも同じ時刻', ev2?.at === ev.at && Date.now() - ev2.at >= 1500, json(ev2));
    } finally { c2.close(); }
    const res = await c.waitFor(e => e.type === 'tool.result' && e.id === ev.id, { from, ms: 20_000 });
    t.ok('流れてきた tool.result にも、サーバーが受けた時刻（ms）が付く（行の右端の時刻の詳細の終わり）', Number.isFinite(res.at) && res.at >= ev.at, json(res));
    // fake の待ち（ms）は中断で切れないので、終わるまで待つ
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === ev.sessionId, { from, ms: 20_000 });
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
