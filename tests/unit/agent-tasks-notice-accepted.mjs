import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { readAgentTasks, writeAgentTasks } from '../lib/data-store.mjs';

export const name = 'agent-tasks-notice-accepted';
export const title = '完了・無音通知は親が受け取った時点で settling から外す（ターンの終わりを待たない）。受理前だけが引き継ぎを待たせ、受理後は送り直さない';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(15); } throw new Error('timeout'); }
const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };

export default async function(t) {
  const dirs = [], managers = [];
  const tmp = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-accepted-')); dirs.push(d); return d; };
  const make = async (dir, extra = {}) => {
    let seq = 0;
    const m = await createAgentTasks({ dataDir: dir, log: () => {}, silenceMinutes: 0, commandMinutes: 0,
      prepare: async (_owner, a) => ({ sessionId: `child-${++seq}`, backend: a.backend }),
      execute: async (_task, prompt) => ({ outcome: 'ok', text: `result:${prompt}` }),
      ready: async () => true, ...extra });
    managers.push(m);
    return m;
  };
  try {
    // ---- 完了通知: 受理の前は settling（どの会話か分かる）、受理の後はターンが続いていても settling でなく、sent は保存済み
    {
      const dir = await tmp();
      const beforeAccept = gate(), turnRunning = gate();
      const calls = [];
      let accept;
      const m = await make(dir, { deliver: async (tasks, { accepted }) => {
        calls.push(tasks.map(x => x.taskId));
        accept = accepted;
        await beforeAccept.promise;
        await accepted();
        await turnRunning.promise;   // 通知で始まったターンが続いている間
        return 'ok';
      } });
      const task = await m.call('owner', 'ply_delegate', { backend: 'fake', task: 'one' });
      await until(() => calls.length === 1);
      t.ok('受理の前は送ったか分からないので settling に数え、保存は delivering',
        m.settling && m.settlingSessions().join() === 'owner' && m.get(task.taskId).notification === 'delivering'
        && readAgentTasks(dir)[task.taskId].notification === 'delivering');
      beforeAccept.open();
      await until(() => !m.settling);
      t.ok('受理されたらターンが続いていても settling から外れ、待たせる会話も無い', !m.settling && m.settlingSessions().length === 0);
      t.ok('受理の時点で sent を保存している（引き継いだ後の書き込みに頼らない）',
        m.get(task.taskId).notification === 'sent' && readAgentTasks(dir)[task.taskId].notification === 'sent');
      await sleep(1300);
      t.ok('ターンが続いている間に送り直さない', calls.length === 1);
      turnRunning.open();
      await sleep(1300);
      t.ok('ターンが終わっても送り直さず sent のまま', calls.length === 1 && m.get(task.taskId).notification === 'sent' && readAgentTasks(dir)[task.taskId].notification === 'sent');
      t.ok('accepted は何度呼んでも 1 回分（二重に書かない）', await Promise.all([accept(), accept()]).then(() => true));
    }

    // ---- 受理の後にターンが失敗（requeue / throw）しても、sent を戻さず送り直さない
    for (const ending of ['requeue', 'throw']) {
      const dir = await tmp();
      const calls = [];
      const m = await make(dir, { deliver: async (tasks, { accepted }) => {
        calls.push(tasks.map(x => x.taskId));
        await accepted();
        if (ending === 'throw') throw new Error('turn failed');
        return 'requeue';
      } });
      const task = await m.call('owner', 'ply_delegate', { backend: 'fake', task: 'two' });
      await until(() => calls.length === 1 && !m.settling);
      await sleep(1300);
      t.ok(`受理の後にターンが ${ending} で終わっても送り直さない`, calls.length === 1 && m.get(task.taskId).notification === 'sent' && readAgentTasks(dir)[task.taskId].notification === 'sent');
    }

    // ---- 受理されなかった requeue は、従来どおり pending へ戻して settling から外れ、後で送り直す
    {
      const dir = await tmp();
      const calls = [];
      let open = false;
      const m = await make(dir, { deliver: async (tasks, { accepted }) => {
        calls.push(tasks.map(x => x.taskId));
        if (!open) return 'requeue';
        await accepted();
        return 'ok';
      } });
      const task = await m.call('owner', 'ply_delegate', { backend: 'fake', task: 'three' });
      await until(() => calls.length >= 1 && !m.settling);
      t.ok('受理されない requeue は pending に戻る', m.get(task.taskId).notification === 'pending' && !m.settling);
      open = true;
      await until(() => m.get(task.taskId).notification === 'sent');
      t.ok('受理されたら 1 回だけ sent', m.get(task.taskId).notification === 'sent' && !m.settling);
    }

    // ---- 再起動: 受理の前に落ちた delivering は unknown で送らず、受理の後の sent も送らない
    {
      const dir = await tmp();
      const row = (id, notification) => ({ taskId: id, sessionId: `s-${id}`, parentSessionId: 'owner', manager: 'ply', backend: 'fake', depth: 1, task: 't', title: 't',
        createdAt: 1, updatedAt: 1, status: 'completed', notification, result: `r-${id}`, error: null, queue: [] });
      writeAgentTasks(dir, { before: row('before', 'delivering'), after: row('after', 'sent') });
      const delivered = [];
      const m = await make(dir, { deliver: async tasks => { delivered.push(...tasks.map(x => x.taskId)); return 'ok'; } });
      await sleep(1300);
      t.ok('再起動で、受理の前の delivering は unknown になり、sent と共に送らない',
        delivered.length === 0 && m.get('before').notification === 'unknown' && m.get('after').notification === 'sent' && !m.settling);
    }

    // ---- 無音の通知も、受理されたら settling から外れる
    {
      const dir = await tmp();
      let clock = 0, release;
      const silence = gate(), pending = gate();
      const m = await make(dir, { now: () => clock, silenceMinutes: 15,
        execute: async (_task, _prompt, signal) => { await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }); }); return { outcome: 'ok', text: 'done' }; },
        deliver: async () => 'ok',
        deliverSilence: async (_task, _minutes, { accepted }) => { await silence.promise; accepted(); await pending.promise; return 'ok'; } });
      await m.call('owner', 'ply_delegate', { backend: 'fake', task: 'work' });
      await until(() => release);
      clock = 15 * 60000; m.checkSilence();
      await until(() => m.settling);
      t.ok('無音の通知は受理の前だけ settling で、待たせている会話が分かる', m.settlingSessions().join() === 'owner');
      silence.open();
      await until(() => !m.settling);
      t.ok('受理されたら、ターンが続いていても settling から外れる', !m.settling && m.settlingSessions().length === 0);
      pending.open(); release?.();
    }
  } finally {
    for (const m of managers) await m.close();
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  }
}
