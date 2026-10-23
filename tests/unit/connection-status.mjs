// 接続の状態（web/connection-status.mjs、docs/design-system.md「接続の状態」）と、サイドバーを開くボタンの印（web/open-sidebar-mark.mjs）。
//   - 切れて 1.5 秒続いたら、脇の下と入力欄の上に同じ一行。読み上げは role=status 1 か所で、切れたとき・戻ったときに 1 回ずつ
//   - 続けて 2 回開けなかったら HTTP で 1 回確かめ、401 なら再接続をやめて案内に替える（送信は押せない）
//   - 案内の「再確認」: 「確認しています…」→ 確かめた時刻と結果。通れば開き直し、戻ったら時刻を出す
//   - サーバーの /auth-check: トークンが合えば 204、合わなければ 401（本物のサーバーを起動する）
//   - リモートの窓で線が止まった（取り消し・外された・止められた ほか）: 回る印も「再接続しています」も出さず、何が起きたかと次の一手。
//     Plus が止まっている（paused）: 待っていることを出す。どちらも開き直さず、線が戻ったら開き直す
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { N } from '../lib/dom-stub.mjs';
import { startServer } from '../lib/server.mjs';
import { createConnectionStatus } from '../../web/connection-status.mjs';
import { attentionCounts, paintOpenSidebar } from '../../web/open-sidebar-mark.mjs';

export const name = 'connection-status';
export const title = '接続の状態（切れた一行・読み上げ・古いトークンの案内）とサイドバーを開くボタンの印';

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup({ answers = [], leave } = {}) {
  const note = new N('div'), sideLine = new N('div'), live = new N('div');
  note.hidden = true; sideLine.hidden = true;
  let timers = [];
  let clock = 1000;
  const setTimer = (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; };
  const clearTimer = (h) => { timers = timers.filter((x) => x !== h); };
  const flush = () => { const run = timers; timers = []; for (const h of run) h.fn(); };
  const checks = [];
  let reconnects = 0, changes = 0;
  const said = [];
  const liveProxy = new Proxy(live, { set(target, k, v) { if (k === 'textContent') said.push(v); target[k] = v; return true; } });
  const c = createConnectionStatus({ note, sideLine, live: liveProxy, runMark: () => { const s = new N('span'); s.className = 'run'; return s; },
    t: (k, o) => (o ? `[${k}|${Object.values(o).join(',')}]` : `[${k}]`), time: (ms) => `T${ms}`,
    check: async () => { checks.push(clock); return answers.shift() ?? 'unreachable'; },
    reconnect: () => { reconnects++; }, onChange: () => { changes++; }, leave, setTimer, clearTimer, now: () => clock });
  return { c, note, sideLine, said, flush, timers: () => timers, checks, reconnects: () => reconnects, changes: () => changes, advance: (ms) => { clock += ms; } };
}

export default async function (t) {
  // ---- 切れた・戻った
  {
    const s = setup();
    s.c.opened(); s.c.ready();
    t.ok('平常は何も出さず、何も読まない', s.note.hidden && s.sideLine.hidden && s.said.length === 0);
    s.c.closed();
    t.ok('切れてすぐは出さない（1.5 秒の遅延と、1.5 秒後の開き直し）', s.note.hidden && s.sideLine.hidden && s.timers().length === 2 && s.timers().every((h) => h.ms === 1500));
    s.c.opened(); s.c.ready();
    s.flush();
    t.ok('1.5 秒以内に戻った瞬断では出さず、読まない', s.note.hidden && s.sideLine.hidden && s.said.length === 0 && s.reconnects() === 0);
    s.c.closed();
    s.flush();
    t.ok('1.5 秒続いたら、脇の下と入力欄の上に同じ一行（入力欄の上は弧つき）', !s.note.hidden && !s.sideLine.hidden && s.note.getAttribute('data-kind') === 'lost'
      && s.note.textContent === '[app.connLost]' && s.sideLine.textContent === '[app.connLost]' && s.note.querySelector('.run'));
    t.ok('読み上げは 1 回（切れた）', s.said.join() === '[app.connLost]');
    t.ok('1.5 秒ごとに開き直す', s.reconnects() === 1);
    s.c.closed();   // 開き直しが 1 回失敗（まだ確かめない）
    t.ok('開けなかったのが 1 回なら確かめない', s.checks.length === 0);
    s.c.setRemoteState('offline');
    t.ok('リモートの窓で中継につながらない間は、同じ理由の語で書く', s.note.textContent === '[app.connLostRelay]' && s.sideLine.textContent === '[app.connLostRelay]');
    s.c.setRemoteState('host-offline');
    t.ok('ホストがオフラインの間も、同じ理由の語で書く', s.note.textContent === '[app.connLostHost]' && s.sideLine.textContent === '[app.connLostHost]');
    s.c.setRemoteState('connected');
    s.c.opened(); s.c.ready();
    t.ok('戻れば消え、「再接続しました」を 1 回読む', s.note.hidden && s.sideLine.hidden && s.said.join() === '[app.connLost],[app.reconnected]');
    t.ok('送信は止めない（自動で戻る見込みがある）', !s.c.blocksSend());
  }
  // ---- 続けて開けない → HTTP で確かめる
  {
    const s = setup({ answers: ['unreachable', 'denied'] });
    s.c.opened(); s.c.ready();
    s.c.closed(); s.flush();
    s.c.closed();           // 1 回目の失敗
    s.c.closed();           // 2 回目の失敗 → 確かめる
    await tick();
    t.ok('続けて 2 回開けなかったら 1 回だけ確かめる', s.checks.length === 1);
    t.ok('届かない（サーバーが止まっている）なら再接続を続ける', s.c.phase === 'down' && s.timers().some((h) => h.ms === 1500));
    s.c.closed(); s.c.closed();
    await tick();
    t.ok('次に続けて 2 回開けなかったらもう一度確かめる', s.checks.length === 2);
    t.ok('401 なら案内に替える', s.c.phase === 'stale' && s.note.getAttribute('data-kind') === 'stale' && !s.note.hidden
      && s.note.textContent.includes('[app.authStale.title]') && s.note.textContent.includes('[app.authStale.body]'));
    t.ok('再接続をやめる（切れた一行を消し、次の開き直しを置かない）', s.timers().length === 0 && !s.note.textContent.includes('[app.connLost]'));
    t.ok('脇の下は同じ意味の短い文を強い字で', s.sideLine.textContent === '[app.authStale.title]' && s.sideLine.getAttribute('data-kind') === 'stale' && !s.sideLine.hidden);
    t.ok('送信は押せない', s.c.blocksSend() && s.changes() > 0);
    t.ok('案内を 1 回読む（見出しと次の一手）', s.said.at(-1) === '[app.authStale.title] [app.authStale.body]');
    s.c.closed();
    t.ok('案内の間は閉じても開き直さない', s.timers().length === 0);
  }
  // ---- 再確認
  {
    const s = setup({ answers: ['denied', 'denied', 'ok'] });
    s.c.opened(); s.c.ready();
    s.c.closed(); s.flush(); s.c.closed(); s.c.closed();
    await tick();
    const button = s.note.querySelector('button');
    t.ok('案内に「再確認」', button && button.textContent === '[app.authStale.recheck]');
    const pending = s.c.recheck();
    t.ok('押したらその場で「確認しています…」', s.note.textContent.includes('[app.authStale.checking]') && button.getAttribute('aria-disabled') === 'true');
    await tick();
    t.ok('一瞬で終わっても「確認しています…」をしばらく残す', s.note.textContent.includes('[app.authStale.checking]') && s.timers().length === 1);
    s.advance(60_000);
    s.flush();
    await pending;
    t.ok('まだ合わなければ、確かめた時刻と「まだ開き直しが必要」', s.note.textContent.includes('[app.authStale.stillStale|T61000]') && s.c.phase === 'stale'
      && s.note.querySelector('button') === button && button.getAttribute('aria-disabled') === 'false');
    t.ok('結果を 1 回読む', s.said.at(-1) === '[app.authStale.stillStale|T61000]');
    const again = s.c.recheck();
    await tick(); s.flush(); await again;
    t.ok('通れば案内をたたみ、切れた一行のまま開き直す', s.c.phase === 'down' && s.reconnects() === 2 && s.note.getAttribute('data-kind') === 'lost' && !s.c.blocksSend());
    s.c.opened(); s.c.ready();
    t.ok('戻ったら「再接続しました」を時刻付きでその場に出し、読む', s.note.textContent === '[app.reconnectedAt|T61000]' && !s.note.hidden
      && s.note.getAttribute('data-kind') === 'done' && s.said.at(-1) === '[app.reconnected]');
    s.flush();
    t.ok('しばらくして消える', s.note.hidden);
  }
  // ---- リモートの窓で線が止まった: 何が起きたかと次の一手。回る印・「再接続しています」・開き直しは出さない
  for (const state of ['revoked', 'reapprove', 'removed', 'blocked', 'limit', 'update', 'signed-out']) {
    const s = setup();
    s.c.opened(); s.c.ready();
    s.c.closed(); s.flush();          // 切れた一行が出て、1 回開き直した
    const before = s.reconnects();
    s.c.setRemoteState(state);
    const title = `[app.remoteStop.${state}.title]`, body = `[app.remoteStop.${state}.body]`;
    t.ok(`${state}: 入力欄の上に見出しと次の一手（回る印も「再接続しています」も出さない）`, !s.note.hidden && s.note.getAttribute('data-kind') === 'stop'
      && s.note.textContent.includes(title) && s.note.textContent.includes(body) && !s.note.querySelector('.run') && !s.note.textContent.includes('[app.connLost'), s.note.textContent);
    t.ok(`${state}: 脇の下は見出しを強い字で`, !s.sideLine.hidden && s.sideLine.textContent === title && s.sideLine.getAttribute('data-kind') === 'stop', s.sideLine.textContent);
    t.ok(`${state}: 次の開き直しを置かない・送信は押せない`, s.timers().length === 0 && s.c.blocksSend());
    t.ok(`${state}: 見出しと次の一手を 1 回読む`, s.said.at(-1) === `${title} ${body}`);
    s.c.closed(); s.c.closed(); s.c.closed();
    await tick();
    t.ok(`${state}: 閉じても開き直さず、トークンも確かめない`, s.reconnects() === before && s.timers().length === 0 && s.checks.length === 0 && s.note.getAttribute('data-kind') === 'stop');
  }
  // つながっている間に止まった知らせが先に届いても、その場で出す
  {
    const s = setup();
    s.c.opened(); s.c.ready();
    s.c.setRemoteState('revoked');
    t.ok('つながっている間に取り消しが届いたら、その場で案内', s.note.getAttribute('data-kind') === 'stop' && !s.note.hidden && s.c.blocksSend());
    t.ok('ホストの一覧へ戻る口が無い窓（デスクトップ）ではボタンを出さない', !s.note.querySelector('button'));
  }
  // モバイルの殻: 「ホストの一覧へ」で戻る
  {
    let left = 0;
    const s = setup({ leave: () => { left++; } });
    s.c.opened(); s.c.ready(); s.c.closed(); s.flush();
    s.c.setRemoteState('removed');
    const button = s.note.querySelector('button');
    t.ok('止まった案内に「ホストの一覧へ」', button && button.textContent === '[app.remoteStop.back]');
    button.onclick();
    t.ok('押すとホストの一覧へ', left === 1);
  }
  // Plus が止まっている（paused）: 待っていることを出す。線が戻ったら開き直す
  {
    const s = setup();
    s.c.opened(); s.c.ready();
    s.c.closed(); s.flush();
    const before = s.reconnects();
    s.c.setRemoteState('paused');
    t.ok('paused: 入力欄の上と脇の下に「Plus が止まっている（再開を待っている）」、回る印は出さない', !s.note.hidden && s.note.getAttribute('data-kind') === 'paused'
      && s.note.textContent === '[app.remotePaused]' && !s.note.querySelector('.run') && s.sideLine.textContent === '[app.remotePaused]' && s.sideLine.getAttribute('data-kind') === 'paused', s.note.textContent);
    t.ok('paused: 開き直さない・送信は押せない・1 回読む', s.timers().length === 0 && s.c.blocksSend() && s.said.at(-1) === '[app.remotePaused]');
    s.c.closed(); s.c.closed();
    await tick();
    t.ok('paused: 閉じても開き直さない', s.reconnects() === before && s.timers().length === 0 && s.checks.length === 0);
    s.c.setRemoteState('connected');
    t.ok('線が戻ったら、すぐ開き直す（切れた一行に戻る）', s.reconnects() === before + 1 && s.note.getAttribute('data-kind') === 'lost' && !s.c.blocksSend());
    s.c.opened(); s.c.ready();
    t.ok('ページの接続が戻れば消え、「再接続しました」を読む', s.note.hidden && s.sideLine.hidden && s.said.at(-1) === '[app.reconnected]');
  }
  {
    const client = await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8');
    t.ok('リモートの窓は、線の状態をそのまま接続の状態へ渡す（中継・ホストの 2 つだけにしない）', /connStatus\.setRemoteState\(s\?\.state/.test(client));
  }
  // ---- サイドバーを開くボタンの印
  {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'cur' }];
    const counts = attentionCounts(rows, { currentId: 'cur', waitingIds: new Set(['a', 'cur']), unreadIds: new Set(['b', 'c', 'd', 'cur']), busyIds: new Set(['d']) });
    t.ok('今の会話は数えない。走っている会話の未確認は数えない（行では弧が勝つ）', counts.waiting === 1 && counts.unread === 2, JSON.stringify(counts));
    const button = new N('button');
    const tr = (k, o) => (o ? `${k}(${Object.values(o).join(',')})` : k);
    paintOpenSidebar(button, { waiting: 0, unread: 2 }, tr);
    const mark = button.querySelector('.side-mark');
    t.ok('未確認だけなら青い丸（数は出さない）', mark && mark.getAttribute('data-kind') === 'unread' && mark.textContent === '' && mark.getAttribute('aria-hidden') === 'true');
    t.ok('件数はアクセシブルな名前に', button.getAttribute('aria-label') === 'app.openSidebarWith(sidebar.unreadCount(2))', button.getAttribute('aria-label'));
    paintOpenSidebar(button, { waiting: 2, unread: 1 }, tr);
    t.ok('承認待ちがあれば ◆ を優先し、2 件以上なら数', mark.getAttribute('data-kind') === 'wait' && mark.textContent === '2'
      && button.getAttribute('aria-label') === 'app.openSidebarWith(sidebar.waitingCount(2) · sidebar.unreadCount(1))', button.getAttribute('aria-label'));
    paintOpenSidebar(button, { waiting: 0, unread: 0 }, tr);
    t.ok('何も無ければ印を外し、名前を戻す', !button.querySelector('.side-mark') && button.getAttribute('aria-label') === 'app.openSidebar');
    // 名前は件数を入れて書くので、HTML の訳し直し（applyDom）の対象にしない。初めの名前は起動時に paintOpenSidebar で
    const html = await fs.readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
    const client = await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8');
    const tag = /<button[^>]*id="openSidebar"[^>]*>/.exec(html)?.[0] ?? '';
    t.ok('「サイドバーを開く」に data-i18n-aria-label を置かない（訳し直すと件数の無い名前に戻っていた）', tag && !/data-i18n-aria-label/.test(tag) && /data-i18n-title="app\.openSidebarTitle"/.test(tag));
    t.ok('起動時に件数なしの名前を書く（applyDom の直後）', /applyDom\(document\);[\s\S]{0,200}paintOpenSidebar\(\$\("openSidebar"\), \{\}, t\);/.test(client));
  }
  // ---- サーバーの /auth-check
  {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-auth-check-'));
    const server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake' } });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const ok = await fetch(`${origin}/auth-check?token=${server.token}`, { method: 'HEAD' });
      const bad = await fetch(`${origin}/auth-check?token=stale-token`, { method: 'HEAD' });
      const viaCookie = await fetch(`${origin}/auth-check?token=stale-token`, { method: 'HEAD', headers: { cookie: `agent_host_token=${server.token}` } });
      t.ok('/auth-check: トークンが合えば 204（本文なし・保存しない）', ok.status === 204 && ok.headers.get('cache-control') === 'no-store');
      t.ok('/auth-check: 合わなければ 401', bad.status === 401);
      t.ok('/auth-check: Cookie が合えば通る（画面は Cookie を送らずに聞く）', viaCookie.status === 204);
    } finally {
      await server.stop();
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
