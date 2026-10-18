import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { anchored, sameRows } from '../lib/acp-history.mjs';

export const name = 'server-grok';
export const title = 'Grok: fake ACP でターンと途中送信（待ち行列に積んで同じターンで続けて回す）';
export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-server-grok-'));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  let server, c;
  try {
    server = await startServer({ dataDir: path.join(root, 'data'), env: { AGENT_HOST_BACKENDS: 'grok', AGENT_HOST_GROK_BIN: `node "${path.join(ROOT, 'tests/lib/fake-grok.mjs')}"`, GROK_HOME: path.join(root, 'grok-home') } });
    c = await open(server);
    const first = await c.runTurn({ backend: 'grok', cwd, prompt: 'alpha', mode: 'auto' });
    assert.equal(first.outcome, 'ok');
    t.ok('初回のターンが返る', Boolean(first.sessionId));
    // ---- ホスト記録の無い会話: ライブで出た行と、再開・再起動の後の再生の行は同じ uuid
    const loaded = await c.cmd('loadSession', { sessionId: first.sessionId });
    const next = await c.runTurn({ sessionId: first.sessionId, prompt: 'beta' });
    const after = await c.cmd('loadSession', { sessionId: first.sessionId });
    t.ok('再開時の replay を重複させず前の UUID を保つ', next.outcome === 'ok' && after.messages.length === 4
      && loaded.messages.every((m, i) => after.messages[i].uuid === m.uuid), JSON.stringify(after.messages.map(m => [m.uuid, m.role])));
    t.ok('ホスト記録の無い会話の text.end の発言の id は、読み直した履歴の行に当たり、記録用の印を出さない',
      anchored(first, loaded.messages) && anchored(next, after.messages) && after.messages.every(m => !('sent' in m) && !('positional' in m) && !('liveUuid' in m)));
    // ---- 圧縮でネイティブが履歴を書き換えた、ホスト記録の会話（この試験の Grok には指示が足されない。子と bot の会話だけ。指示を足した発言の照合は acp-record-merge と server-devin）
    const compactId = (await c.cmd('newSession', { backend: 'grok', cwd })).sessionId;
    const compactPrompts = ['one', 'two', '[compact-rewrite] three', 'four'], compactTurns = [];
    for (const prompt of compactPrompts.slice(0, 3)) compactTurns.push(await c.runTurn({ sessionId: compactId, prompt }));
    const rewritten = await c.cmd('loadSession', { sessionId: compactId });
    compactTurns.push(await c.runTurn({ sessionId: compactId, prompt: compactPrompts[3] }));
    const compacted = await c.cmd('loadSession', { sessionId: compactId });
    t.ok('圧縮で書き換わった履歴の再生でも、記録の発言は原文のまま 1 回ずつ並び、前の行の uuid と本文を保つ',
      compactTurns.every(turn => turn.outcome === 'ok') && sameRows(compacted.messages, compactPrompts)
      && rewritten.messages.every((m, i) => compacted.messages[i].uuid === m.uuid && compacted.messages[i].text === m.text),
      JSON.stringify(compacted.messages.map(m => [m.uuid, m.role, m.text.slice(0, 40)])));
    t.ok('ホスト記録の会話の text.end の発言の id は、記録の行の uuid に当たる', compactTurns.every(turn => anchored(turn, compacted.messages)));
    // ---- 途中送信: 走っている回への送信は Grok の待ち行列に積まれ、今の回の直後に続けて回る。
    // Pleiad は決着を待つので、同じターンの中で答えが流れる
    const mark = c.mark();
    const holding = c.runTurn({ sessionId: first.sessionId, prompt: '[slow] hold' });
    await c.waitFor(e => e.type === 'activity' && e.sessionId === first.sessionId, { ms: 10000, from: mark });
    await c.cmd('sendMessage', { sessionId: first.sessionId, messageId: 'grok-steer-0001', prompt: 'steer-me' });
    const held = await holding;
    const heldText = held.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    t.ok('途中送信が待ち行列から同じターンで読まれ、発言の行が出て turnResult は一度だけ',
      heldText.includes('fixture: steer-me')
      && c.since(mark).some(e => e.type === 'userMessage' && e.messageId === 'grok-steer-0001')
      && held.events.filter(e => e.type === 'turnResult').length === 1 && held.outcome === 'ok', heldText);
    c.close(); c = null;
    await server.stop(); server = null;
    server = await startServer({ dataDir: path.join(root, 'data'), env: { AGENT_HOST_BACKENDS: 'grok', AGENT_HOST_GROK_BIN: `node "${path.join(ROOT, 'tests/lib/fake-grok.mjs')}"`, GROK_HOME: path.join(root, 'grok-home') } });
    c = await open(server);
    const restored = await c.cmd('loadSession', { sessionId: first.sessionId });
    t.ok('サーバー再起動後もネイティブ履歴の UUID を保つ', after.messages.every((m, i) => restored.messages[i]?.uuid === m.uuid),
      JSON.stringify(restored.messages.map(m => [m.uuid, m.role])));
    const compactRestored = await c.cmd('loadSession', { sessionId: compactId });
    t.ok('サーバー再起動後も、圧縮で書き換わった会話の発言を原文のまま、同じ uuid で重複なく復元する',
      sameRows(compactRestored.messages, compactPrompts) && compacted.messages.every((m, i) => compactRestored.messages[i].uuid === m.uuid && compactRestored.messages[i].text === m.text),
      JSON.stringify(compactRestored.messages.map(m => [m.uuid, m.role, m.text.slice(0, 40)])));
    c.close(); c = null;
    await server.stop(); server = null;
  } finally { c?.close(); await server?.stop(); await fs.rm(root, { recursive: true, force: true }); }
}
