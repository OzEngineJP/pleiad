// 止まっている会話から、押した時点の設定（sendMessage の settings）で送ったとき、予約（nextSettings）が残るか。
// consumeSendReservation は、保存してある予約の全項目がスナップショットと一致するときだけ消す。
//   - 一致すれば、走っている間に予約は無い（帯は残らない）
//   - 項目が違えば残す（送った後の選び直しを消さない）
//   - 予約の書き込みと送信が重なっても、同じスナップショットなら走っている間に残らない
// 送ったターンは予約を会話の値へ効かせる。次の選択が今の値と同じだと予約は作られないので、競合の回はモデルを交互に替える。
// fake backend・一時のデータ置き場・別ポート（tests/lib/server.mjs）。本物のデータには触れない。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-send-reservation';
export const title = '止まっている会話から送った予約: 一致すれば消え、違えば残り、書き込みと重なっても同じ値は残らない';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(fn) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-send-reservation-')));
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 60_000 });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  try { await fn(c); }
  finally {
    c?.close?.();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

const session = (c, id) => c.cmd('listSessions').then((rows) => (rows ?? []).find((x) => x.id === id));

function snapshotOf(row, overrides = {}) {
  const next = row.nextSettings ?? {};
  return {
    backend: String(next.backend ?? row.backend ?? ''),
    model: String(overrides.model ?? next.model ?? row.model ?? ''),
    effort: String(overrides.effort ?? next.effort ?? row.effort ?? ''),
    mode: String(overrides.mode ?? next.mode ?? row.mode ?? 'default'),
    endpoint: String(overrides.endpoint ?? next.endpoint ?? ''),
    account: String(overrides.account ?? next.account ?? ''),
    cwd: String(overrides.cwd ?? next.cwd ?? row.cwd ?? ''),
    worktreePending: false,
  };
}

// sendSettings は全項目が文字列であることを求める。予約に無い項目は比較されない（consumeNextSettings は保存側のキーだけ見る）。
function predict(sample, model, effort, cwd) {
  return {
    backend: String(sample.backend ?? ''),
    model: String(model),
    effort: String(effort),
    mode: String(sample.mode ?? 'default'),
    endpoint: String(sample.endpoint ?? ''),
    account: String(sample.account ?? ''),
    cwd: String(sample.cwd ?? cwd ?? ''),
    worktreePending: false,
  };
}

async function stopped(c) {
  const made = await c.runTurn({ prompt: 'hello', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 30_000 });
  return made.sessionId;
}

async function sendSlow(c, id, settings) {
  const from = c.mark();
  await c.cmd('sendMessage', { sessionId: id, messageId: crypto.randomUUID(), prompt: 'slow', settings });
  // running は会話 id を持たない。turns の行がこの会話を含むとき、prepareTurn（予約の消し）の後である。
  await c.waitFor((e) => e.type === 'running' && (e.turns ?? []).some((turn) => turn.sessionId === id), { from, ms: 20_000 });
  return from;
}

async function stop(c, id, from) {
  await c.cmd('abort', { sessionId: id }).catch(() => {});
  await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === id, { from, ms: 20_000 }).catch(() => null);
  await sleep(50);
  // 止めると送信は保留（paused）になり、次の sendMessage がそれを先に送る。測る送信だけが残るように取り消す。
  const messages = c.since(from).filter((e) => e.type === 'outbox' && e.sessionId === id).at(-1)?.messages ?? [];
  for (const item of messages) {
    if (['sent', 'cancelled'].includes(item.status)) continue;
    await c.cmd('messageAction', { sessionId: id, messageId: item.id, action: 'cancel' }).catch(() => {});
  }
}

export default async function (t) {
  await withServer(async (c) => {
    const id = await stopped(c);
    await c.cmd('setTurnSettings', { sessionId: id, model: 'fast', effort: 'high' });
    const reserved = await session(c, id);
    t.ok('止まる会話で選んだモデルは予約になる', reserved?.nextSettings?.model === 'fast' && reserved.nextSettings.effort === 'high', JSON.stringify(reserved?.nextSettings));
    const matched = snapshotOf(reserved);
    const from = await sendSlow(c, id, matched);
    const running = await session(c, id);
    t.ok('スナップショットが予約と一致する送信は、走っている間に予約を消す', !running?.nextSettings, JSON.stringify(running?.nextSettings));
    const consumedEvs = c.since(from).filter((e) => e.type === 'nextSettings' && e.sessionId === id);
    t.ok('送って消えた予約の知らせは applied: true を付ける（画面はこれで「効いた値」と判る）', consumedEvs.some((e) => e.nextSettings === null && e.applied === true), JSON.stringify(consumedEvs));
    await stop(c, id, from);

    // 直前の送信が fast / high を会話の値にした。同じ値は予約にならないので、別のモデルと段にする。
    await c.cmd('setTurnSettings', { sessionId: id, model: 'smart', effort: 'low' });
    const again = await session(c, id);
    t.ok('今の値と違う選択は予約になる', again?.nextSettings?.model === 'smart' && again.nextSettings.effort === 'low', JSON.stringify(again?.nextSettings));
    const mismatched = snapshotOf(again, { model: 'fast' });
    const fromMismatch = await sendSlow(c, id, mismatched);
    const kept = await session(c, id);
    t.ok('スナップショットのモデルが予約と違うときは、予約を残す', kept?.nextSettings?.model === 'smart', JSON.stringify(kept?.nextSettings));
    await stop(c, id, fromMismatch);
    const fromCancel = c.mark();
    await c.cmd('setTurnSettings', { sessionId: id, cancel: true });
    const cancelEvs = c.since(fromCancel).filter((e) => e.type === 'nextSettings' && e.sessionId === id);
    t.ok('取り消しの知らせには applied を付けない', cancelEvs.length > 0 && cancelEvs.every((e) => e.applied === undefined), JSON.stringify(cancelEvs));

    const sample = again.nextSettings;
    let stayed = 0;
    let armed = 0;
    const notes = [];
    for (const order of ['set-first', 'send-first']) {
      for (let i = 0; i < 4; i++) {
        // 送ったターンはスナップショットを会話の値にする。今の値と同じ選択は予約にならないので、違うモデルを選ぶ。
        const cur = await session(c, id);
        const model = cur?.model === 'smart' ? 'fast' : 'smart';
        const settings = predict(sample, model, 'high', cur?.cwd ?? '');
        const fromRace = c.mark();
        let setP;
        let sendP;
        const runSet = () => c.cmd('setTurnSettings', { sessionId: id, model, effort: 'high' });
        const runSend = () => c.cmd('sendMessage', { sessionId: id, messageId: crypto.randomUUID(), prompt: 'slow', settings });
        // cmd は呼んだ瞬間に送る。Promise.all の並びでは送信順は変わらない。
        if (order === 'send-first') { sendP = runSend(); setP = runSet(); }
        else { setP = runSet(); sendP = runSend(); }
        const [written] = await Promise.all([setP, sendP]);
        await c.waitFor((e) => e.type === 'running' && (e.turns ?? []).some((turn) => turn.sessionId === id), { from: fromRace, ms: 20_000 });
        const mid = await session(c, id);
        // null は送信が同じ値を会話へ効かせたあとで、予約が要らなくなったとき。オブジェクトなら、選んだモデルと一致すること。
        if (written != null && written.model !== model) notes.push(`${order}#${i} 予期しない返り値 written=${JSON.stringify(written)} sessionModel=${cur?.model}`);
        else armed += 1;
        if (mid?.nextSettings) {
          stayed += 1;
          const evs = c.since(fromRace).filter((e) => e.type === 'nextSettings' && e.sessionId === id).map((e) => e.nextSettings);
          const box = (mid.outbox ?? []).map((item) => ({ status: item.status, model: item.args?.settings?.model, effort: item.args?.settings?.effort }));
          notes.push(`${order}#${i} written=${JSON.stringify(written)} settingsModel=${settings.model} events=${JSON.stringify(evs)} outbox=${JSON.stringify(box)}`);
        }
        await stop(c, id, fromRace);
        if (mid?.nextSettings) await c.cmd('setTurnSettings', { sessionId: id, cancel: true });
      }
    }
    t.ok('重なった選択は、予約として返るか、送信が同じ値を引き取る', armed === 8, `受けた回数 ${armed} / 8${notes.length ? ` ${notes.join(' | ')}` : ''}`);
    t.ok('予約の書き込みと、同じスナップショットの送信が重なっても、走っている間に予約は残らない', stayed === 0, `残った回数 ${stayed} / 8${notes.length ? ` ${notes.join(' | ')}` : ''}`);
  });
}
