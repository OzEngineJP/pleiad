// 画像の多い Codex の会話（作り物: fake の app-server の "images:14"。1 枚 1.6 MB の base64 で、会話を丸ごと返すと 22 MB を超える）を、
// 本物の保持役（1 行の上限 16 MiB）に載せた app-server でサーバー全体を通して扱う（core/backends/codex-history.mjs）。LLM は呼ばない
//   1. paginated（今の codex の会話）: 委譲した子が 14 枚を作って終わり、完了の返答が依頼元に届く。子の会話はすぐ開け、画像は保存先（/local-file）で、base64 を運ばない。
//      ply_task_send の追加の指示が届いて終わる。会話を丸ごと返す thread/read を使わず、thread/resume には excludeTurns を付ける
//   2. legacy（ページ読みのできない古い会話）: 丸ごと読むと保持役が行を捨てる。会話を開くと待ち続けずに「大きすぎて読み込めない」で失敗にする。
//      委譲した子は失敗にせず、流れてきた返答を注意書き付きで結果にする
//   3. 後片付け: 保持役が残らない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';

export const name = 'server-codex-large-history';
export const title = '画像の多い Codex の会話（22 MB）: 保持役の 1 行の上限を超えずに開け、追加の指示と完了の返答が届く。読めない古い会話は待ち続けない';

const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const BASE64_MARK = 'iVBORw0KGgoAAAANSUhEUgAAiVBORw0KGgoAAAANSUhEUgAA';   // fake の画像の base64 の繰り返し
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** 保持役に載せたサーバーを 1 つ立て、fn(ctx) の後に片付ける */
async function withServer(label, extraEnv, fn) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ply-codex-large-${label}-`)));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const work = path.join(scratch, 'work');
  const home = path.join(scratch, 'home');
  const codexLog = path.join(scratch, 'codex.log');
  await Promise.all([work, home].map(dir => fs.mkdir(dir, { recursive: true })));
  const fake = path.join(ROOT, 'tests', 'lib', 'fake-codex.mjs');
  let server = null, c = null, holderPid = null;
  try {
    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 20_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();
    server = await startServer({ dataDir, timeoutMs: 40_000, env: {
      AGENT_HOST_BACKENDS: 'fake,codex', HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      AGENT_HOST_CODEX_BIN: `node "${fake}"`, FAKE_CODEX_LOG: codexLog, FAKE_CODEX_IMAGE_DIR: path.join(work, 'generated_images'),
      AGENT_HOST_RUNTIME_ROOT: root, AGENT_HOST_TASK_SILENCE_MINUTES: '0', ...extraEnv,
    } });
    c = await open({ port: server.port, token: server.token, autoAllow: true });
    const calls = async () => (await fs.readFile(codexLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    // 保持役につながる親は 1 つだけ（後からつないだ方が勝つ）なので、テストの間は保持役につながない（サーバーの口が切れる）
    await fn({ c, server, work, calls });
  } catch (error) {
    error.message += `\n  server tail: ${server?.tail(20)}`;
    throw error;
  } finally {
    c?.close();
    await server?.stop();
    if (holderPid && alive(holderPid)) {
      const probe = await connectHolder({ dataDir, root }).catch(() => null);
      probe?.shutdown();
      probe?.close();
      for (let i = 0; i < 200 && alive(holderPid); i++) await sleep(50);
      if (alive(holderPid)) { try { process.kill(holderPid); } catch { /* 既に終わっている */ } }
    }
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return holderPid;
}

/** 委譲・完了の待ち方（server-delegation-settings と同じ形） */
function delegation(c) {
  const tasks = async () => c.cmd('agentTasks');
  const awaitTask = async (taskId, fn, what = '') => {
    const deadline = Date.now() + 90_000;
    let row;
    while (Date.now() < deadline) { row = (await tasks()).find(r => r.taskId === taskId); if (row && fn(row)) return row; await sleep(100); }
    throw new Error(`task timeout ${what}: ` + JSON.stringify(row && { status: row.status, notification: row.notification, result: row.result, error: row.error }));
  };
  const delegate = async (task, cwd) => {
    const from = c.mark();
    await c.cmd('runTurn', { backend: 'fake', cwd, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'codex', task }) });
    const ev = await c.waitFor(e => e.type === 'tool.result' && String(e.text).includes('"taskId"'), { from, ms: 60_000 });
    return { parent: ev.sessionId, task: JSON.parse(ev.text) };
  };
  const call = async (sessionId, name, args) => {
    const from = c.mark();
    await c.runTurn({ sessionId, prompt: prompt(name, args) });
    const ev = await c.waitFor(e => e.type === 'tool.result' && e.sessionId === sessionId, { from, ms: 60_000 });
    return ev.isError ? { error: ev.text } : JSON.parse(ev.text);
  };
  // 依頼元へ完了通知が届き、依頼元のターンが終わるまで待つ
  const settle = async (taskId, parent, fn = () => true) => {
    const row = await awaitTask(taskId, r => !['queued', 'running', 'cancelling'].includes(r.status) && r.notification === 'sent' && fn(r), 'settle');
    for (let i = 0; i < 400 && (await c.cmd('running')).turns.some(x => x.sessionId === parent); i++) await sleep(50);
    return row;
  };
  return { awaitTask, delegate, call, settle };
}

const timed = async fn => {
  const started = Date.now();
  const value = await fn().then(v => ({ v }), e => ({ e }));
  return { ...value, ms: Date.now() - started };
};

export default async function (t) {
  // ---- 1. paginated
  const pid1 = await withServer('paged', {}, async ({ c, work, calls }) => {
    const { delegate, call, settle } = delegation(c);
    const { parent, task } = await delegate('images:14 画像を 14 枚作って', work);
    const done = await settle(task.taskId, parent);
    t.ok('14 枚を作った子が completed で終わり、完了の返答が読める', done.status === 'completed' && done.result === 'images:14 を作りました' && !done.error,
      JSON.stringify({ status: done.status, result: done.result, error: done.error }));
    const notice = (await c.cmd('loadSession', { sessionId: parent })).messages.filter(m => m.internalTaskNotice).find(m => m.text.includes(task.taskId))?.text ?? '';
    t.ok('依頼元の会話に完了通知が届き、子の返答が載る', notice.includes('images:14 を作りました'), notice.slice(0, 300));
    // 保持役が行を捨てた（LINE_OVERFLOW）ときだけページを半分にする。32 の次が 16 なら、1 行の上限 16 MiB の保持役の道を通っている
    const limits = (await calls()).filter(x => x.method === 'thread/items/list').map(x => x.limit);
    t.ok('app-server は保持役の子で、上限を超えたページは保持役に捨てられ、半分にして読み直した', limits.join(',').includes('32,16,8'), limits.join(','));

    const opened = await timed(() => c.cmd('loadSession', { sessionId: task.sessionId }));
    const payload = JSON.stringify(opened.v ?? {});
    const images = (opened.v?.messages ?? []).flatMap(m => (m.toolCalls ?? []).flatMap(x => x.result?.images ?? x.images ?? []));
    t.ok('子の会話はすぐ開け、返答が読める', !opened.e && opened.ms < 10_000 && (opened.v.messages ?? []).some(m => m.role === 'assistant' && m.text === 'images:14 を作りました'),
      `${opened.ms}ms ${opened.e?.message ?? ''}`);
    t.ok('画像は保存先（/local-file）で開き、base64 を運ばない', !payload.includes(BASE64_MARK) && payload.length < 2_000_000
      && (images.length === 0 || images.every(img => String(img.url ?? '').startsWith('/local-file'))),
      `応答 ${payload.length} バイト・画像 ${images.length} 件`);

    const log = await calls();
    const reads = log.filter(x => x.method === 'thread/read');
    t.ok('会話を丸ごと返す thread/read（includeTurns）を使わず、ページに分けて読む', reads.length > 0 && reads.every(x => !x.includeTurns)
      && log.some(x => x.method === 'thread/items/list') && log.some(x => x.method === 'thread/turns/list'),
      JSON.stringify(log.filter(x => x.method?.startsWith('thread/')).map(x => `${x.method}${x.includeTurns ? '+turns' : ''}${x.limit ? `:${x.limit}` : ''}`)).slice(0, 600));

    // 追加の指示（ply_task_send）: 同じ子にもう 1 ターン。今までは thread/resume の答え（会話の中身つき）が保持役で捨てられて届かなかった
    const sent = await call(parent, 'ply_task_send', { taskId: task.taskId, message: 'images:1 もう 1 枚' });
    t.ok('ply_task_send を受け付ける', !sent.error, JSON.stringify(sent).slice(0, 300));
    const again = await settle(task.taskId, parent, r => r.result === 'images:1 を作りました');
    t.ok('追加の指示が子に届いて終わり、その返答が完了として届く', again.status === 'completed' && again.result === 'images:1 を作りました' && !again.error,
      JSON.stringify({ status: again.status, result: again.result, error: again.error }));
    const resumes = (await calls()).filter(x => x.method === 'thread/resume');
    t.ok('thread/resume には excludeTurns を付ける（会話の中身を受け取らない）', resumes.every(x => x.excludeTurns), JSON.stringify(resumes));
    const reopened = await c.cmd('loadSession', { sessionId: task.sessionId });
    t.ok('追加のターンの後も子の会話を開け、両方の返答が読める', ['images:14 を作りました', 'images:1 を作りました'].every(text => reopened.messages.some(m => m.role === 'assistant' && m.text === text))
      && !JSON.stringify(reopened).includes(BASE64_MARK));
  });

  // ---- 2. legacy: 丸ごと読むしかない会話
  const pid2 = await withServer('legacy', { FAKE_CODEX_LEGACY: '1' }, async ({ c, work, calls }) => {
    const { delegate, settle } = delegation(c);
    const { parent, task } = await delegate('images:14 画像を 14 枚作って', work);
    const done = await settle(task.taskId, parent);
    t.ok('履歴を読めない子も失敗にせず、流れてきた返答を注意書き付きで結果にする', done.status === 'completed' && done.result === 'images:14 を作りました'
      && /履歴を読み出せませんでした|could not be read/.test(String(done.error)) && /大きすぎて|too large/i.test(String(done.error)),
      JSON.stringify({ status: done.status, result: done.result, error: String(done.error).slice(0, 300) }));
    const opened = await timed(() => c.cmd('loadSession', { sessionId: task.sessionId }));
    t.ok('会話を開くと、待ち続けずに「大きすぎて読み込めない」で失敗にする', Boolean(opened.e) && opened.ms < 10_000 && /大きすぎて|too large/i.test(opened.e.message),
      `${opened.ms}ms ${opened.e?.message ?? '開けてしまった'}`);
    t.ok('丸ごとの読み出し（includeTurns）は保持役が捨てた行で、時間切れを待たずに失敗した', (await calls()).some(x => x.method === 'thread/read' && x.includeTurns));
  });

  t.ok('後片付け: 保持役が残らない', !alive(pid1) && !alive(pid2));
}
