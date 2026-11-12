// モーダルで委譲の子を開くとき、出来事の見張り（watchSession の modal の口）を読み込み（loadSession）より先に送る順（ADR 0315・段 6-2）。
//   - 画面の側: taskThread が watch を先に送る（client.mjs の中の並びを文字列で見る）
//   - サーバーの側: 同じ WebSocket に watchSession → loadSession を続けて送ると、読み込みの返り値の streamCursor より後の子の出来事が、
//     欠けずにこの接続へ届く（見張りが読み込みの前に立っているので、読み込みの間に子が出した分も落ちない）。
//     主の見張りだけを宣言した接続は、modal の口を立てる前は子の出来事を受け取らない（見張りの効き目の確かめ）
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'child-modal-watch-order';
export const title = 'モーダルで子を開く: 見張りを読み込みの前に送り、読み込みの間の子の出来事を落とさない';

const clientSource = await fs.readFile(path.join(ROOT, 'web', 'client.mjs'), 'utf8');
const fnSource = (head) => {
  const start = clientSource.indexOf(head);
  return start < 0 ? '' : clientSource.slice(start, clientSource.indexOf('\n}', start));
};

export default async function (t) {
  // ---- 画面の側の並び
  const task = fnSource('async function taskThread(');
  const watchAt = task.indexOf('syncModalWatch()');
  const loadAt = task.indexOf("cmd('loadSession'");
  const paneAt = task.indexOf("dataset.paneKind = 'task'");
  t.ok('taskThread: 見張り（syncModalWatch）を loadSession より前に呼ぶ', watchAt > 0 && loadAt > 0 && watchAt < loadAt, `watch=${watchAt} load=${loadAt}`);
  t.ok('taskThread: 見張りの元の印（paneKind）は見張りより前に置く（modalWatchId が読む）', paneAt > 0 && paneAt < watchAt, `pane=${paneAt} watch=${watchAt}`);
  t.ok('taskThread: 読み込みの後には syncModalWatch を呼ばない', task.indexOf('syncModalWatch()', loadAt) === -1);

  // ---- サーバーの側
  await fs.mkdir(path.join(ROOT, 'temporary'), { recursive: true });
  const base = await fs.mkdtemp(path.join(ROOT, 'temporary', 'child-modal-watch-'));
  const work = path.join(base, 'work');
  await fs.mkdir(work);
  let server, ref, watcher;
  try {
    server = await startServer({ dataDir: path.join(base, 'data'), env: { AGENT_HOST_BACKENDS: 'fake' } });
    ref = await open({ ...server });   // 何も宣言しない接続: 全部の出来事が届く（基準）
    await ref.cmd('authLogin', { backend: 'fake' });
    await ref.cmd('completeSetup', { backend: 'fake' });
    watcher = await open({ ...server });

    const slow = path.join(base, 'slow.json');
    await fs.writeFile(slow, JSON.stringify({ steps: [{ text: 'はじめます。' }, ...Array.from({ length: 24 }, (_, i) => ({ tool: 'Bash', input: { command: `run ${i}` }, result: `out ${i}`, ms: 300 }))] }));
    const first = await ref.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Order' });
    const parent = first.sessionId;
    const mark = ref.mark();
    const ply = 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { backend: 'fake', kind: 'mechanical', title: '順番の子', task: `steps:@${slow}` } });
    for (let tries = 0; ; tries++) {
      try { await ref.cmd('runTurn', { sessionId: parent, prompt: ply }); break; }
      catch (error) { if (tries >= 80) throw error; await sleep(250); }
    }
    const res = await ref.waitFor(e => e.sessionId === parent && e.type === 'tool.result', { from: mark, ms: 30_000 });
    const taskId = JSON.parse(res.text).taskId;
    const taskOf = async () => (await ref.cmd('agentTasks')).find(r => r.taskId === taskId);
    const until = Date.now() + 60_000;
    while (Date.now() < until && !(await taskOf())?.sessionId) await sleep(100);
    const childId = (await taskOf()).sessionId;
    while (Date.now() < until && (await taskOf()).status !== 'running') await sleep(100);

    // 主の見張りだけを宣言した接続（モーダルを開く前の画面）
    await watcher.cmd('loadSession', { sessionId: parent, watch: true });
    const before = watcher.mark();
    await sleep(1_200);
    const childOf = (client, from) => client.since(from).filter(e => e.sessionId === childId && Number.isInteger(e.streamSeq));
    t.ok('modal の口を立てる前は、子の出来事を受け取らない（基準の接続には届いている）',
      childOf(watcher, before).length === 0 && childOf(ref, 0).length > 0, `watcher=${childOf(watcher, before).length} ref=${childOf(ref, 0).length}`);

    // 画面と同じ順: 見張り → 読み込みを待たずに続けて送る
    const from = watcher.mark();
    const watched = watcher.cmd('watchSession', { sessionId: childId, slot: 'modal' });
    const loaded = watcher.cmd('loadSession', { sessionId: childId, live: true });
    await watched;
    const data = await loaded;
    const cursor = data.streamCursor;
    await sleep(2_000);
    const seen = new Set(childOf(watcher, from).map(e => e.streamSeq));
    const expected = childOf(ref, 0).map(e => e.streamSeq).filter(seq => seq > cursor);
    t.ok('読み込みは走っている子の分（stream と streamCursor）を返す', Boolean(data.stream) && Number.isInteger(cursor), JSON.stringify({ cursor, hasStream: Boolean(data.stream) }));
    t.ok('読み込みの返り値より後の出来事が 1 件以上ある（子はまだ走っている）', expected.length > 3, `expected=${expected.length}`);
    const missing = expected.filter(seq => !seen.has(seq));
    t.ok('streamCursor より後の子の出来事は、1 件も欠けずに届く', missing.length === 0, `missing=${missing.slice(0, 5)} of ${expected.length}`);
  } finally {
    watcher?.close();
    ref?.close();
    await server?.stop();
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
