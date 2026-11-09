// 旧内部会話が、実際のサーバーの公開経路（sessions.list/get/read/changes・ネイティブ id の直接指定）から
// 返らないことを、fake サーバーと再起動で確かめる（Issue #180）。通常の bot 会話は対照として読める。
// 実データは使わず、一時のデータ置き場に旧経路の形（session_fields.bot と conversations.nativeId）を作る。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { openData } from '../../core/data-schema.mjs';
import { sessionTable, conversationTable } from '../../core/db.mjs';

export const name = 'server-internal-isolation';
export const title = '旧内部会話はサーバーの一覧・get・read・changes・ネイティブ id から返らない（再起動後も）。通常の bot 会話は読める';

const HIDDEN = 'host-hidden-learner';
const HIDDEN_NATIVE = 'native-hidden-learner';
const NORMAL = 'host-normal-dm';

const messages = (text) => [
  { role: 'user', uuid: 'u1', text: `${text} の依頼`, at: 1 },
  { role: 'assistant', uuid: 'a1', text: `${text} の返事`, at: 2 },
];

/** 旧経路の形（learner の印 + ネイティブの対応）と、通常の bot 会話を直接置く */
function seed(dataDir) {
  const handle = openData(dataDir);
  try {
    const sessions = sessionTable(handle.db);
    sessions.writeAll(HIDDEN, { backend: 'fake', title: '記憶の整理', cwd: os.tmpdir(), createdAt: 1, lastModified: 2, unsent: false,
      bot: { botId: 'b_learner', kind: 'learner', channelId: null, threadId: null } });
    sessions.writeAll(NORMAL, { backend: 'fake', title: '通常の会話', cwd: os.tmpdir(), createdAt: 3, lastModified: 4, unsent: false,
      bot: { botId: 'b_owl12345', kind: 'dm', channelId: 'c_dm', threadId: null } });
    conversationTable(handle.db).save([
      [HIDDEN, JSON.stringify({ backend: 'fake', nativeId: HIDDEN_NATIVE, base: 0, messages: messages('内部の秘密'), segments: [], info: { title: '記憶の整理' } })],
      [NORMAL, JSON.stringify({ backend: 'fake', nativeId: 'native-normal-dm', base: 0, messages: messages('通常'), segments: [], info: { title: '通常の会話' } })],
    ], []);
  } finally { handle.release(); }
}

export default async function (t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'server-internal-isolation-')));
  const dataDir = path.join(tmp, 'data');
  let server = null, c = null;
  const call = async (op, args) => {
    const reply = await c.cmd('invoke', { op, args });
    // 操作の失敗は投げずに { ok:false, code, error } で返る。成功も { ok:true, result } で包まれる
    if (reply?.ok === false) {
      const error = new Error(String(reply.error ?? reply.code ?? 'failed'));
      error.code = reply.code;
      throw error;
    }
    return reply?.ok === true ? reply.result : reply;
  };
  const missing = async (op, args) => {
    try { await call(op, args); return false; }
    catch (e) { return e?.code === 'SESSION_NOT_FOUND' || /not found|見つかりません/.test(String(e?.message ?? '')); }
  };
  const check = async (phase) => {
    const listed = await call('sessions.list', { limit: 100 });
    const sessions = Array.isArray(listed) ? listed : (listed?.sessions ?? []);
    assert.equal(sessions.some((row) => row.id === HIDDEN), false, `${phase}: 一覧に出ない`);
    assert.equal(sessions.some((row) => row.id === NORMAL), true, `${phase}: 通常の bot 会話は出る`);
    assert.equal(await missing('sessions.get', { sessionId: HIDDEN }), true, `${phase}: host id の get`);
    assert.equal(await missing('sessions.get', { sessionId: HIDDEN_NATIVE }), true, `${phase}: ネイティブ id の get`);
    assert.equal(await missing('sessions.read', { sessionId: HIDDEN }), true, `${phase}: host id の read`);
    assert.equal(await missing('sessions.read', { sessionId: HIDDEN_NATIVE }), true, `${phase}: ネイティブ id の read`);
    // changes は画面の読み取り（uiHandler）が「無い会話」を空で返す。中身は漏れない
    assert.equal((await call('sessions.changes', { sessionId: HIDDEN })).changes.length, 0, `${phase}: host id の changes`);
    assert.equal((await call('sessions.changes', { sessionId: HIDDEN_NATIVE })).changes.length, 0, `${phase}: ネイティブ id の changes`);
    // 診断の明示要求だけは読める（一覧・通常の操作には戻らない）
    const diagnostic = await call('sessions.get', { sessionId: HIDDEN_NATIVE, includeInternal: true });
    assert.equal(diagnostic.id, HIDDEN, `${phase}: includeInternal は host の行を返す`);
    const read = await call('sessions.read', { sessionId: HIDDEN_NATIVE, includeInternal: true });
    assert.ok(read.messages.some((m) => String(m.text).includes('内部の秘密')), `${phase}: includeInternal の read`);
    // 通常の会話は読める（対照）
    assert.equal((await call('sessions.get', { sessionId: NORMAL })).id, NORMAL, `${phase}: 通常の get`);
    assert.ok((await call('sessions.read', { sessionId: NORMAL })).messages.some((m) => String(m.text).includes('通常')), `${phase}: 通常の read`);
  };

  try {
    await fs.mkdir(dataDir, { recursive: true });
    seed(dataDir);
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 60_000 });
    c = await open({ port: server.port, token: server.token });
    await check('起動後');
    if (c?.close) c.close();
    await server.stop();
    server = null;

    // 再起動しても、durable 印とネイティブの対応から同じ境界になる
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 60_000 });
    c = await open({ port: server.port, token: server.token });
    await check('再起動後');
    t.ok('旧内部会話は一覧・get・read・changes・ネイティブ id から返らず、includeInternal の診断だけ読める。通常の bot 会話は読める（再起動後も）', true);
  } finally {
    try { c?.close?.(); } catch {}
    if (server?.stop) await server.stop().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}
