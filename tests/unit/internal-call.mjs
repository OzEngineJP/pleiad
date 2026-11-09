// 内部 AI 呼出し（Issue #180）: 会話も接続先の履歴も作らない共通経路。journal・usage・中断・再起動の掃除を、
// 本物の AI もネットワークも使わずに確かめる（fake の internalTurn・純粋な usageRecord・一時の SQLite）。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInternalCalls, INTERNAL_UNAVAILABLE, JOURNAL_KIND, ABORT_GRACE_MS } from '../../core/internal-call.mjs';
import { usageRecord } from '../../core/usage.mjs';
import { openData } from '../../core/data-schema.mjs';
import { memoryStateTable } from '../../core/db.mjs';

export const name = 'internal-call';
export const title = '内部 AI 呼出し: 会話を作らない共通経路・kind/usage の記録・中断と上限・journal の掃除';

const scratch = () => fs.mkdtemp(path.join(os.tmpdir(), 'internal-call-'));
const backend = (internalTurn, capabilities = { internalCall: 'ephemeral' }) => ({ id: 'fake-internal', label: 'Fake Internal', capabilities, internalTurn });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function (t) {
  const dirs = [];
  const dir = async () => { const d = await scratch(); dirs.push(d); return d; };
  try {
    // ---- 成功: 5 種類すべてが journal と usage に internalTask 付きで残る
    {
      const d = await dir();
      const rows = [];
      const calls = createInternalCalls({ dataDir: d, now: () => 1000,
        usageStore: { record: async (row) => { rows.push(row); } },
        accountResolve: async () => null, backendForAccount: async (b) => b });
      for (const kind of ['learner', 'episode', 'pulse', 'suggest', 'title']) {
        const out = await calls.call({ kind, backend: backend(async () => ({ text: `${kind}-ok`, usage: { inputTokens: 3, outputTokens: 2, cachedTokens: 1 } })),
          prompt: 'p', botId: kind === 'pulse' ? 'b_test' : undefined });
        assert.equal(out.text, `${kind}-ok`);
        assert.equal(out.usage.inputTokens, 3);
        assert.ok(out.callId);
      }
      assert.deepEqual(rows.map((row) => row.internalTask.kind), ['learner', 'episode', 'pulse', 'suggest', 'title']);
      assert.equal(rows[2].internalTask.botId, 'b_test', 'pulse の bot を usage の内訳に残す');
      assert.ok(rows.every((row) => row.id.startsWith('internalTask:')));
      const journal = await calls.journal();
      assert.equal(journal.length, 5);
      assert.ok(journal.every((row) => row.status === 'ok' && row.endedAt === 1000));
      assert.ok(journal.some((row) => row.kind === 'pulse' && row.botId === 'b_test'));
      await calls.close();
      t.ok('5 種類の内部呼出しが journal と usage（internalTask）に残る', true);
    }

    // ---- 分離できない backend は呼ばず、通常の会話へ逃げない
    {
      const d = await dir();
      let touched = false;
      const calls = createInternalCalls({ dataDir: d, accountResolve: async () => null, backendForAccount: async (b) => b });
      const impossible = backend(async () => { touched = true; return { text: 'no' }; }, { internalCall: { state: 'impossible', reason: 'x' } });
      await assert.rejects(() => calls.call({ kind: 'learner', backend: impossible, prompt: 'p' }), (e) => e.code === INTERNAL_UNAVAILABLE);
      const noMethod = backend(undefined, { internalCall: 'ephemeral' });
      delete noMethod.internalTurn;
      await assert.rejects(() => calls.call({ kind: 'learner', backend: noMethod, prompt: 'p' }), (e) => e.code === INTERNAL_UNAVAILABLE);
      assert.equal(touched, false);
      assert.deepEqual(await calls.journal(), []);
      await calls.close();
      t.ok('分離できない backend は呼ばず、journal も作らない', true);
    }

    // ---- 中断（開始前・account 解決中）は journal を aborted で閉じ、取れた使用量を残す
    {
      const d = await dir();
      const rows = [];
      const calls = createInternalCalls({ dataDir: d, usageStore: { record: async (row) => { rows.push(row); } },
        accountResolve: async () => { await wait(30); return { token: 't' }; }, backendForAccount: async (b) => b });
      const ac = new AbortController();
      const pending = calls.call({ kind: 'pulse', backend: backend(async ({ signal }) => signal?.aborted ? { text: '', usage: { inputTokens: 9, outputTokens: null, cachedTokens: null }, aborted: true } : { text: 'late' }),
        prompt: 'p', signal: ac.signal, accountId: 'acct' });
      setTimeout(() => ac.abort(), 5);
      const out = await pending;
      assert.equal(out.aborted, true);
      assert.equal(out.reason, 'signal');
      assert.equal(out.text, '');
      assert.equal(out.usage.inputTokens, 9);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].inputTokens, 9);
      const [row] = await calls.journal();
      assert.equal(row.status, 'aborted');
      assert.equal(row.reason, 'signal');
      await calls.close();
      t.ok('account の解決中に中断されても、listener を付けた後に必ず伝わる（aborted・部分 usage）', true);
    }

    // ---- 上限時間: signal を無視する backend でも有限で止まり、遅れて返った部分 usage だけ残す（本文は採用しない）
    {
      const d = await dir();
      const rows = [];
      const calls = createInternalCalls({ dataDir: d, now: () => 2000, usageStore: { record: async (row) => { rows.push(row); } },
        accountResolve: async () => null, backendForAccount: async (b) => b });
      const started = Date.now();
      const out = await calls.call({ kind: 'suggest', timeoutMs: 5,
        backend: backend(async () => { await wait(40); return { text: 'late text', usage: { inputTokens: 11, outputTokens: 2, cachedTokens: null } }; }), prompt: 'p' });
      const elapsed = Date.now() - started;
      assert.equal(out.aborted, true);
      assert.equal(out.reason, 'timeout');
      assert.equal(out.text, '');
      assert.equal(out.usage.inputTokens, 11);
      assert.ok(elapsed >= 5 && elapsed < 5000, `elapsed ${elapsed}`);
      assert.equal(rows[0].inputTokens, 11);
      const [row] = await calls.journal();
      assert.equal(row.status, 'aborted');
      assert.equal(row.reason, 'timeout');
      assert.equal(row.usage.inputTokens, 11);
      await calls.close();
      t.ok('上限時間で止まり、遅れた部分 usage は残すが本文は採用しない', true);
    }

    // ---- signal を無視して返らない backend でも、上限 + 猶予で必ず戻る
    {
      const d = await dir();
      const calls = createInternalCalls({ dataDir: d, accountResolve: async () => null, backendForAccount: async (b) => b });
      const started = Date.now();
      const out = await calls.call({ kind: 'learner', timeoutMs: 5, backend: backend(() => new Promise(() => {})), prompt: 'p' });
      const elapsed = Date.now() - started;
      assert.equal(out.aborted, true);
      assert.equal(out.usage, null);
      assert.ok(elapsed >= 5 && elapsed < ABORT_GRACE_MS + 3000, `elapsed ${elapsed}`);
      const [row] = await calls.journal();
      assert.equal(row.status, 'aborted');
      assert.equal(row.reason, 'timeout');
      await calls.close();
      t.ok('signal を無視する backend でも、上限 + 猶予で有限に戻る（usage は不明のまま）', true);
    }

    // ---- 猶予の後に返った usage は、同じ usage_records の行へ書き戻す（行を増やさない）
    {
      const d = await dir();
      const rows = [];
      let updates = 0;
      const usageStore = {
        record: async (row) => { rows.push(row); },
        amend: async (id, record) => {
          updates++;
          const i = rows.findIndex((row) => row.id === id);
          if (i < 0) return false;
          rows[i] = { ...rows[i], ...record, at: rows[i].at };
          return true;
        },
      };
      const calls = createInternalCalls({ dataDir: d, now: () => 3000, usageStore, accountResolve: async () => null, backendForAccount: async (b) => b });
      const out = await calls.call({ kind: 'pulse', timeoutMs: 5, botId: 'b_late', prompt: 'p',
        backend: backend(async () => { await wait(ABORT_GRACE_MS + 400); return { text: 'very late', usage: { inputTokens: 42, outputTokens: 5, cachedTokens: 0 } }; }) });
      assert.equal(out.aborted, true);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].inputTokens, undefined, '上限の時点では usage 不明（0 にしない）');
      await wait(700);
      assert.equal(updates, 1);
      assert.equal(rows.length, 1, '同じ callId の行を増やさない');
      assert.equal(rows[0].inputTokens, 42);
      assert.equal(rows[0].internalTask.kind, 'pulse');
      assert.equal(rows[0].internalTask.botId, 'b_late');
      await calls.close();
      t.ok('猶予後に返った usage は同じ usage_records の行へ書き戻す（行を増やさない）', true);
    }

    // ---- 停止（close）中に走っている呼出しは中断して有限に待ち、閉じた後は新しい呼出しも DB の再開もしない
    {
      const d = await dir();
      let amend = 0;
      const calls = createInternalCalls({ dataDir: d, usageStore: { record: async () => {}, amend: async () => { amend++; return true; } },
        accountResolve: async () => null, backendForAccount: async (b) => b });
      const running = calls.call({ kind: 'pulse', prompt: 'p', backend: backend(() => new Promise(() => {})) });
      await wait(20);
      await calls.close();
      const out = await running;
      assert.equal(out.aborted, true, 'close は走っている呼出しを中断する');
      await assert.rejects(() => calls.call({ kind: 'learner', prompt: 'p', backend: backend(async () => ({ text: 'x' })) }), /closed/);
      // 旧プロセスが閉じた後に同じ置き場を開いても、running のままにはならない（復元側で interrupted にできる）
      const handle = openData(d);
      try {
        const row = Object.values(memoryStateTable(handle.db).ofKind(JOURNAL_KIND)).find((v) => v.kind === 'pulse');
        assert.equal(row.status, 'aborted');
      } finally { handle.release(); }
      assert.equal(amend, 0);
      t.ok('close は走っている呼出しを中断して待ち、閉じた後は新しい呼出しと DB の再開をしない', true);
    }

    // ---- 停止の後に遅れて返った usage は DB を開き直さない（aborted の行は残る）
    {
      const d = await dir();
      let amend = 0;
      const calls = createInternalCalls({ dataDir: d, usageStore: { record: async () => {}, amend: async () => { amend++; return true; } },
        accountResolve: async () => null, backendForAccount: async (b) => b });
      const out = await calls.call({ kind: 'suggest', timeoutMs: 5,
        backend: backend(async () => { await wait(ABORT_GRACE_MS + 500); return { text: 'late', usage: { inputTokens: 5, outputTokens: 0, cachedTokens: 0 } }; }), prompt: 'p' });
      assert.equal(out.aborted, true);
      await calls.close();
      await wait(900);
      assert.equal(amend, 0, '閉じた後に usage を書き戻さない（DB を開き直さない）');
      const handle = openData(d);
      try {
        const row = Object.values(memoryStateTable(handle.db).ofKind(JOURNAL_KIND)).find((v) => v.kind === 'suggest');
        assert.equal(row.status, 'aborted');
        assert.equal(row.usage, null);
      } finally { handle.release(); }
      t.ok('close 後に遅れて返った usage は書き戻さず、aborted（usage 不明）の行だけ残す', true);
    }

    // ---- journal へ書けない（完了行）ときは成功扱いにしない
    {
      const d = await dir();
      const calls = createInternalCalls({ dataDir: d, accountResolve: async () => null, backendForAccount: async (b) => b });
      await assert.rejects(() => calls.call({ kind: 'title', backend: backend(async () => ({ text: '' }), { internalCall: { state: 'todo', issue: '#180' } }), prompt: 'p' }),
        (e) => e.code === INTERNAL_UNAVAILABLE);
      await calls.close();
      t.ok('未対応（todo）も internalCall では実行しない', true);
    }

    // ---- usage の記録に失敗したら成功にしない（journal も failed で閉じる）
    {
      const d = await dir();
      const calls = createInternalCalls({ dataDir: d, accountResolve: async () => null, backendForAccount: async (b) => b,
        usageStore: { record: async () => { throw new Error('usage db down'); } } });
      await assert.rejects(() => calls.call({ kind: 'learner', backend: backend(async () => ({ text: 'ok', usage: { inputTokens: 1 } })), prompt: 'p' }), /usage db down/);
      const [row] = await calls.journal();
      assert.equal(row.status, 'failed');
      assert.match(row.error, /usage record failed/);
      await calls.close();
      t.ok('usage の記録に失敗したら成功扱いにせず、journal も failed で閉じる', true);
    }

    // ---- 再起動の掃除: 前のプロセスの running だけを interrupted にし、このプロセスの running は触らない。終わった行は 100 件に絞る
    {
      const d = await dir();
      const seed = openData(d);
      const table = memoryStateTable(seed.db);
      const done = Array.from({ length: 105 }, (_, i) => [JOURNAL_KIND, `old-${i}`, { callId: `old-${i}`, kind: 'learner', at: i, status: 'done' }]);
      table.save([...done, [JOURNAL_KIND, 'broken', { callId: 'broken', kind: 'learner', at: 0.5 }],
        [JOURNAL_KIND, 'stale-running', { callId: 'stale-running', kind: 'pulse', at: 900, status: 'running' }]]);
      seed.release();

      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const calls = createInternalCalls({ dataDir: d, now: () => 1000, accountResolve: async () => null, backendForAccount: async (b) => b });
      const running = calls.call({ kind: 'pulse', backend: backend(async () => { await gate; return { text: 'ok' }; }), prompt: 'p' });
      await calls.sweep();
      let journal = await calls.journal(undefined, 200);
      const stale = journal.find((row) => row.callId === 'stale-running');
      assert.equal(stale.status, 'interrupted', '前のプロセスの running は interrupted');
      assert.ok(journal.some((row) => row.status === 'running'), 'このプロセスの running は残す');
      release();
      const out = await running;
      assert.equal(out.text, 'ok');
      journal = await calls.journal(undefined, 200);
      const finished = journal.filter((row) => row.status !== 'running');
      assert.ok(finished.length <= 100, `finished ${finished.length}`);
      assert.equal(journal.find((row) => row.callId === stale.callId).status, 'interrupted');
      assert.equal(journal.some((row) => row.callId === 'broken'), false, 'status の無い壊れた行も prune の件数に入る');
      await calls.close();
      t.ok('sweep は前の running だけ中断にし、running を prune しない。終わった行は 100 件に絞る', true);
    }

    // ---- usageRecord の正規化: internalTask の内訳が保存され、sessionId を持たない
    {
      const rec = usageRecord({ id: 'internalTask:x', backend: 'fake', internalTask: { kind: 'pulse', botId: 'b_1', model: 'm', account: 'acct', endpoint: 'ep', extra: 'drop' },
        inputTokens: 5, outputTokens: null }, 123);
      assert.deepEqual(rec.internalTask, { kind: 'pulse', botId: 'b_1', model: 'm', account: 'acct', endpoint: 'ep' });
      assert.equal(rec.sessionId, undefined);
      assert.equal(rec.inputTokens, 5);
      assert.equal(rec.outputTokens, null);
      const broken = usageRecord({ id: 'internalTask:y', backend: 'fake', internalTask: { model: 'm' } }, 124);
      assert.equal(broken.internalTask, undefined, 'kind の無い内訳は保存しない');
      t.ok('usageRecord は internalTask を正規化して残し、会話の集計に混ぜない', true);
    }
  } finally {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
}
