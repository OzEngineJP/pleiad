import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { readAgentTasks, writeAgentTasks, readSessions, writeSessions } from '../lib/data-store.mjs';
import { interruptionNote, taskStop } from '../../core/interrupt-stops.mjs';

async function openParentStore(dir, instance) {
  const previous = process.env.AGENT_HOST_DATA;
  process.env.AGENT_HOST_DATA = dir;
  try { return await import(`../../core/store.mjs?notice-restart=${instance}`); }
  finally {
    if (previous === undefined) delete process.env.AGENT_HOST_DATA;
    else process.env.AGENT_HOST_DATA = previous;
  }
}
const recover = store => task => store.recoverTaskNotice(task, taskStop(task, { noticeUnconfirmed: true }));

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

    // ---- 起動前の認証失敗で渡らなかった通知は、再起動後にも送り直せるよう pending を保存する
    {
      const dir = await tmp();
      let clock = 0, attempts = 0, shown = 0;
      let loginReady = false;
      const m = await make(dir, { now: () => clock, deliver: async (_tasks, { accepted, claimFailureNotice }) => {
        attempts++;
        if (!loginReady) {
          if (claimFailureNotice()) shown++;
          return 'undelivered';
        }
        await accepted();
        return 'ok';
      } });
      const task = await m.call('owner', 'ply_delegate', { backend: 'fake', task: 'auth retry' });
      await until(() => attempts === 1 && !m.settling);
      const stored = readAgentTasks(dir)[task.taskId];
      t.ok('起動前の認証失敗では pending を保存し、再送時刻はファイルに残さない',
        m.get(task.taskId).notification === 'pending' && stored.notification === 'pending' && !Object.hasOwn(stored, 'noticeRetryAt'));
      clock = 59_999;
      await sleep(600);
      t.ok('60 秒より前は deliver をもう一度呼ばず、保存した行も書き換えない',
        attempts === 1 && JSON.stringify(readAgentTasks(dir)[task.taskId]) === JSON.stringify(stored));
      clock = 60_000;
      await until(() => attempts === 2 && !m.settling);
      t.ok('60 秒で再試行し、同じ認証失敗の表示は 1 回だけ', shown === 1 && m.get(task.taskId).notification === 'pending');
      loginReady = true;
      clock = 120_000;
      await until(() => m.get(task.taskId).notification === 'sent' && !m.settling);
      t.ok('認証が戻れば送って sent を保存する', attempts === 3 && readAgentTasks(dir)[task.taskId].notification === 'sent');
      loginReady = false;
      const next = await m.call('owner', 'ply_delegate', { backend: 'fake', task: 'auth fails again' });
      await until(() => attempts === 4 && !m.settling);
      t.ok('送達後にまた認証が失敗すれば表示を出せる', shown === 2 && m.get(next.taskId).notification === 'pending');
    }

    // ---- 受理を保留している間の DB を写し、サーバーが落ちた直後の状態から別の管理役を起動する
    for (const phase of ['before', 'attempting', 'received']) {
      const dir = await tmp(), restored = await tmp();
      writeSessions(dir, { owner: { backend: 'fake' } });
      const parent = await openParentStore(dir, phase);
      const delivery = gate();
      let waiting = false;
      const m = await make(dir, { deliver: async tasks => {
        if (phase !== 'before') await parent.recordTaskNoticeReceipt('owner', tasks, phase);
        waiting = true;
        await delivery.promise;
        return 'ok';
      } });
      let restartedParent;
      try {
        const { taskId } = await m.call('owner', 'ply_delegate', { backend: 'fake', task: phase });
        await until(() => waiting);
        const rows = readAgentTasks(dir);
        t.ok(`再起動前（${phase}）の記録は識別子付きの delivering`, rows[taskId].notification === 'delivering' && !!rows[taskId].noticeId);
        writeAgentTasks(restored, rows);
        writeSessions(restored, readSessions(dir));
        restartedParent = await openParentStore(restored, `restart-${phase}`);
        const delivered = [];
        const b = await make(restored, { recoverNotice: recover(restartedParent), deliver: async tasks => {
          delivered.push(...tasks.map(x => x.noticeId));
          await restartedParent.recordTaskNoticeReceipt('owner', tasks, 'received');
          return 'ok';
        } });
        if (phase === 'before') await until(() => b.get(taskId).notification === 'sent');
        const note = interruptionNote('en', (await restartedParent.get('owner')).stops);
        const expected = phase === 'attempting' ? 'unknown' : 'sent';
        const status = await b.call('owner', 'ply_task_status', { taskId });
        t.ok(`再起動後（${phase}）に再送・受領済み・結果への入口を区別する`,
          status.result === `result:${phase}` && status.notification === expected
          && delivered.join() === (phase === 'before' ? rows[taskId].noticeId : '')
          && (phase === 'attempting' ? note?.body.includes('ply_task_status') && note.keys.length === 1 : note === null));
        if (phase === 'attempting') {
          await restartedParent.takeStops('owner', note.keys);
          await recover(restartedParent)(rows[taskId]);
          t.ok('依頼元に渡した結果への入口を再び作らない', !(await restartedParent.get('owner')).stops);
        }
      } finally {
        delivery.open();
        restartedParent?.closeStore();
        parent.closeStore();
      }
    }

    {
      const dir = await tmp();
      writeSessions(dir, { owner: { backend: 'fake' } });
      const parent = await openParentStore(dir, 'exception');
      try {
        const m = await make(dir, { recoverNotice: recover(parent), deliver: async tasks => {
          await parent.recordTaskNoticeReceipt('owner', tasks, 'attempting');
          throw new Error('transport lost before confirmation');
        } });
        const task = await m.call('owner', 'ply_delegate', { backend: 'fake', task: 'exception' });
        await until(() => m.get(task.taskId).notification === 'unknown');
        t.ok('配送中の例外も親に結果への入口を残す',
          interruptionNote('en', (await parent.get('owner')).stops)?.body.includes(task.taskId));
      } finally { parent.closeStore(); }
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
