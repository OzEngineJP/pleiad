// 作業中の設定の変更（docs/design-system.md「作業中の設定の変更」・ADR 0341）
// この試験は fake（身代わりのバックエンド）で、server の共通の処理（予約・止めて続ける・跡の行）を確かめる。
// エージェントごとの宣言や 1 ターン・中断・失敗・再開の共通の流れは tests/unit/backend-common.mjs が見るので、ここでは繰り返さない。
//   - 作業中に選んだ値は、その場で効くものも予約（nextSettings）に入り、会話の値はまだ変えない
//   - ［今すぐ変える］（applyTurnSettingsNow）: 全部がその場で効けば止めずに切り替え、「作業の途中で…変えました」の跡の行を残す
//   - その場で効かないものがあれば今のターンを止め、新しい設定で続けさせる。止めたことは画面に出さない（中断の行・続ける文を見せない）
//   - 作業中に送ったら、予約を効かせてから渡す（止めたときは送った発言が新しい設定の最初のターンになる。送信待ちは止めない）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-live-settings';
export const title = '作業中の設定の変更: 予約・今すぐ変える（止めずに／止めて続ける）・送ったら適用・跡の行';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(env, fn) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-live-settings-')));
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', ...env }, dataDir, timeoutMs: 60_000 });
  const c = await open({ port: server.port, token: server.token });
  try {
    await fn(c, server);
  } finally {
    c?.close?.();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

const session = (c, id) => c.cmd('listSessions').then((rows) => (rows ?? []).find((x) => x.id === id));

/** 会話を 1 つ作り、"slow"（止めるまで終わらない）のターンを走らせる */
async function startSlow(c, sessionId = null) {
  let id = sessionId;
  if (!id) id = (await c.runTurn({ prompt: 'hello', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 30_000 })).sessionId;
  const from = c.mark();
  const slow = c.runTurn({ prompt: 'slow', sessionId: id }, { ms: 60_000 }).catch(() => null);
  await c.waitFor((e) => e.type === 'running' && e.sessionId === id, { from, ms: 15_000 }).catch(() => null);
  await sleep(300);
  return { id, slow, from };
}

const traces = (loaded) => (loaded?.presents ?? []).filter((p) => p.kind === 'settingsChange');

export default async function (t) {
  // ---- その場で効くエージェント（fake の既定は liveModel・liveEffort・liveMode が対応）
  await withServer({}, async (c) => {
    const { id, slow, from } = await startSlow(c);
    await c.cmd('setTurnSettings', { sessionId: id, model: 'fast', effort: 'high' });
    const reserved = await c.waitFor((e) => e.type === 'nextSettings' && e.sessionId === id && e.nextSettings?.model === 'fast', { from, ms: 10_000 }).catch(() => null);
    t.ok('作業中に選んだモデル・エフォートは、その場で効くエージェントでも予約になる', reserved?.nextSettings?.effort === 'high', JSON.stringify(reserved?.nextSettings));
    const before = await session(c, id);
    t.ok('予約の間は会話のモデルを変えない', (before?.model ?? '') === '', JSON.stringify(before?.model));

    const applyFrom = c.mark();
    const reply = await c.cmd('applyTurnSettingsNow', { sessionId: id });
    t.ok('［今すぐ変える］は止めずに切り替える（applied: live）', reply?.applied === 'live', JSON.stringify(reply));
    const after = await session(c, id);
    t.ok('会話のモデル・エフォートが変わり、予約は消える', after?.model === 'fast' && after?.effort === 'high' && !after?.nextSettings, JSON.stringify({ model: after?.model, effort: after?.effort, next: after?.nextSettings }));
    const events = c.since(applyFrom);
    t.ok('予約が消えたことが届く（帯を畳む）', events.some((e) => e.type === 'nextSettings' && e.sessionId === id && e.nextSettings === null));
    const present = events.find((e) => e.type === 'present' && e.sessionId === id && e.kind === 'settingsChange');
    t.ok('「作業の途中で…変えました」の跡の行が届く（live: true、モデル → エフォートの順）',
      present?.settingsChange?.live === true && present.settingsChange.changes.map((x) => x.field).join() === 'model,effort'
        && present.settingsChange.changes[0].to === 'fast',
      JSON.stringify(present?.settingsChange));
    t.ok('止めていない（ターンは走り続ける）', !events.some((e) => e.type === 'turnEnd' && e.sessionId === id));

    const none = await c.cmd('applyTurnSettingsNow', { sessionId: id });
    t.ok('予約が無ければ何もしない（applied: none）', none?.applied === 'none', JSON.stringify(none));
    await c.cmd('abort', { sessionId: id });
    await slow;
    const loaded = await c.cmd('loadSession', { sessionId: id });
    t.ok('跡の行は会話の記録に残る（開き直しても出る）', traces(loaded).some((p) => p.settingsChange?.live === true), JSON.stringify(traces(loaded)));

    // 予約が残ったまま（人が止めた）ターンが終わった後に選び直したら、予約を書き直す（v3 の不具合 1: 選び直しが予約に負けた）
    const again = await startSlow(c, id);
    await c.cmd('setMode', { sessionId: id, mode: 'auto' });
    await c.waitFor((e) => e.type === 'nextSettings' && e.sessionId === id && e.nextSettings?.mode === 'auto', { from: again.from, ms: 10_000 });
    await c.cmd('abort', { sessionId: id });
    await again.slow;
    await c.cmd('setMode', { sessionId: id, mode: 'plan' });
    const rewritten = await session(c, id);
    t.ok('止めた後に選び直すと予約が書き直される', rewritten?.nextSettings?.mode === 'plan', JSON.stringify(rewritten?.nextSettings));
    await c.runTurn({ prompt: 'hello', sessionId: id }, { ms: 30_000 });
    const used = await session(c, id);
    t.ok('次のターンは選び直した承認モードで始まる', used?.mode === 'plan' && !used?.nextSettings, JSON.stringify({ mode: used?.mode, next: used?.nextSettings }));

  });

  // ---- その場で効かないエージェント（FAKE_LIVE=off。OpenAI Codex と同じ形）
  await withServer({ FAKE_LIVE: 'off' }, async (c) => {
    const { id, slow, from } = await startSlow(c);
    await c.cmd('setTurnSettings', { sessionId: id, model: 'smart' });
    await c.waitFor((e) => e.type === 'nextSettings' && e.sessionId === id && e.nextSettings?.model === 'smart', { from, ms: 10_000 });

    const applyFrom = c.mark();
    const reply = await c.cmd('applyTurnSettingsNow', { sessionId: id });
    t.ok('効かないものがあれば止める（applied: stop）', reply?.applied === 'stop', JSON.stringify(reply));
    await slow;
    // 止めたターンの終わり → 続けるターン（隠れた内部のターン）の終わり
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === id, { from: applyFrom, ms: 20_000 });
    const firstEnd = c.events.findIndex((e, i) => i >= applyFrom && e.type === 'turnEnd' && e.sessionId === id);
    const resumed = await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === id, { from: firstEnd + 1, ms: 20_000 }).catch(() => null);
    await sleep(300);
    const after = await session(c, id);
    t.ok('続けたターンは新しいモデルで走り、予約は消える', after?.model === 'smart' && !after?.nextSettings, JSON.stringify({ model: after?.model, next: after?.nextSettings }));
    const events = c.since(applyFrom);
    const turnEnd = events.find((e) => e.type === 'turnEnd' && e.sessionId === id);
    t.ok('止めたターンに中断の印を付けない（interrupted: null。画面は中断の行を出さない）', turnEnd && turnEnd.interrupted === null, JSON.stringify(turnEnd));
    t.ok('止めた後に続けさせている（見えない内部のターンが走る）', Boolean(resumed));
    const loaded = await c.cmd('loadSession', { sessionId: id });
    const msgs = loaded?.messages ?? [];
    const trace = traces(loaded).at(-1);
    t.ok('「…変えました」の跡の行が残る（live: false。止めたことは書かない）', trace?.settingsChange?.live === false && trace.settingsChange.changes[0]?.field === 'model', JSON.stringify(trace));
    const visibleUsers = msgs.filter((m) => m.role === 'user' && !m.hidden).map((m) => m.text);
    t.ok('続けさせる文は画面の発言に出ない', JSON.stringify(visibleUsers) === JSON.stringify(['hello', 'slow']), JSON.stringify(visibleUsers));
    t.ok('中断の行（kind: interrupt）を出さない', !msgs.some((m) => m.kind === 'interrupt'), JSON.stringify(msgs.filter((m) => m.kind === 'interrupt')));

    // ---- 作業中に送ったら、予約を効かせてから渡す（止めて、送った発言が新しい設定の最初のターンになる）
    const second = await startSlow(c, id);
    await c.cmd('setMode', { sessionId: id, mode: 'auto' });
    await c.waitFor((e) => e.type === 'nextSettings' && e.sessionId === id && e.nextSettings?.mode === 'auto', { from: second.from, ms: 10_000 });
    const sendFrom = c.mark();
    await c.cmd('sendMessage', { sessionId: id, messageId: 'message-live-0001', prompt: 'echo:after' });
    await second.slow;
    await c.waitFor((e) => e.type === 'text.delta' && e.sessionId === id && String(e.text).includes('after'), { from: sendFrom, ms: 20_000 });
    await c.waitFor((e) => e.type === 'running' && e.count === 0, { from: c.events.findIndex((e, i) => i >= sendFrom && e.type === 'text.delta' && String(e.text).includes('after')), ms: 20_000 }).catch(() => null);
    await sleep(300);
    const sent = await session(c, id);
    t.ok('送った発言は新しい承認モードのターンで走り、予約は消える', sent?.mode === 'auto' && !sent?.nextSettings, JSON.stringify({ mode: sent?.mode, next: sent?.nextSettings }));
    const queue = await c.cmd('listMessages', { sessionId: id });
    t.ok('送信待ちは止めない（paused にならず送られる）', queue.every((m) => m.status !== 'paused'), JSON.stringify(queue.map((m) => m.status)));
    const loaded2 = await c.cmd('loadSession', { sessionId: id });
    const users2 = (loaded2?.messages ?? []).filter((m) => m.role === 'user' && !m.hidden).map((m) => m.text);
    t.ok('送った発言は一度だけ会話に出る', users2.filter((x) => x === 'echo:after').length === 1, JSON.stringify(users2));
    const modeTrace = traces(loaded2).at(-1);
    t.ok('送ったときも「…変えました」の跡の行を残す', modeTrace?.settingsChange?.changes?.[0]?.field === 'mode' && modeTrace.settingsChange.changes[0].to === 'auto', JSON.stringify(modeTrace));
  });

  // ---- 止めずに承認モードを変えたら、Pleiad 自身の判定（ply_control の書く操作など）も今のモードで見る（v3 の不具合 10）
  await withServer({}, async (c, server) => {
    const base = `http://127.0.0.1:${server.port}`;
    const first = await c.runTurn({ prompt: 'control-info', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 30_000 });
    const id = first.sessionId;
    const token = JSON.parse((await c.cmd('loadSession', { sessionId: id })).messages.at(-1).text).token;
    const write = async (title) => {
      const res = await fetch(`${base}/api/ops/sessions.setTitle`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const { slow } = await startSlow(c, id);
    const before = await write('作業中に変えた題');
    t.ok('作業中（default）は会話の接続から書ける', before.status === 200, JSON.stringify(before.body));
    await c.cmd('setMode', { sessionId: id, mode: 'plan' });
    const reply = await c.cmd('applyTurnSettingsNow', { sessionId: id });
    t.ok('読み取り専用（plan）へも止めずに切り替わる', reply?.applied === 'live', JSON.stringify(reply));
    const after = await write('切り替えた後の題');
    t.ok('切り替えた後の書く操作は、走っているターンでも READ_ONLY_MODE で断る（作業を始めたときのモードのままにしない）',
      after.status === 403 && after.body?.code === 'READ_ONLY_MODE', JSON.stringify(after));
    await c.cmd('abort', { sessionId: id });
    await slow;
  });
}
