// 内部 AI 呼出し（Issue #180）。host 会話も接続先の永続履歴も作らない 1 回きりの呼び出し。
// runTurn の { internal: true }（既存の会話への注入ターン。タスク通知・委譲返信・圧縮）とは別物で、ここでは使わない。
//
//   記憶の整理（learner）・bot 会話の要約（episode）・心拍の判断（pulse）・次の発言の候補（suggest）・題名（title）が
//   この 1 本の経路を通る。分離は能力の印 internalCall（ephemeral: 接続先に会話を残さない / isolated: 履歴と分離した一時実行）
//   が保証する。印の無い・不可能なバックエンドでは呼ばず、理由を呼び出し側が設定面へ出す（通常の会話へ逃げない）。
//
// 状態は memory_state kind 'internal.calls' に 1 呼出し 1 行（終わった分は直近 KEEP 件。進行中は消さない。
// 起動時に、このプロセスが始まる前の running の残りは interrupted に掃く）。使用量は usage_records に internalTask 欄付きで 1 行
// （成功・失敗・中断のどれでも、呼出しが発生した分。測れない数値は null で 0 とは扱わない）。
// journal・使用量の書き込み失敗は正本が残らないので完了扱いしない（失敗として呼び出し側へ返す）。
import crypto from 'node:crypto';
import { openData } from './data-schema.mjs';
import { memoryStateTable } from './db.mjs';
import { capabilityValue } from './backends/capability-marks.mjs';
import { agentT } from './i18n.mjs';

export const INTERNAL_UNAVAILABLE = 'INTERNAL_UNAVAILABLE';
export const JOURNAL_KIND = 'internal.calls';
const JOURNAL_KEEP = 100;
const ERROR_MAX = 300;
/** 1 呼出しの上限（SDK/RPC の待ちを含む全体）。内部呼出しがどこかで止まったままにならないための有限の境界 */
export const INTERNAL_TIMEOUT_MS = 10 * 60_000;
/** 中断した後、部分的な使用量を拾うためにだけ待つ猶予。全体の上限（timeoutMs）に足しても有限のまま */
export const ABORT_GRACE_MS = 2_000;
const ABORTED = Symbol('aborted');

/** 分離できないバックエンドへの呼出しを拒否する印。呼び出し側は code で見分けて理由を設定面へ出す */
export function internalUnavailableError(backend, locale = 'ja') {
  const err = new Error(agentT(locale, 'internal.unavailable', { agent: backend?.label ?? backend?.id ?? '?' }));
  err.code = INTERNAL_UNAVAILABLE;
  err.backendId = backend?.id ?? null;
  return err;
}

/**
 * @param {object} o
 * @param {string} o.dataDir データ置き場（journal の memory_state を開く元）
 * @param {object} o.usageStore createUsageStore（使用量の記録。無ければ使用量は記録しない）
 * @param {(backend: object, id: string) => Promise<object|null>} o.accountResolve server.mjs のアカウント解決（id 空 → null = 既定）
 * @param {(backend: object, account: object) => Promise<object>} o.backendForAccount アカウントを持つ backend（'agent'・'token' 種）のアカウントの束縛（server が種の判定込みで渡す）
 * @param {() => number} [o.now]
 */
export function createInternalCalls({ dataDir, usageStore, accountResolve, backendForAccount, now = Date.now } = {}) {
  let handle = null, table = null;
  // 終わり始め／終わった後は DB を開き直さない（旧プロセスが、新しいサーバーがロックを取った後に書かない）
  let closing = false, closed = false;
  const open = () => {
    // closing の間も、走っている呼出しが最後の aborted/failed 行を書ける（新しい呼出しと後着の補正は止める）
    if (closed) throw new Error('internal call journal is closed');
    if (!handle) { handle = openData(dataDir); table = memoryStateTable(handle.db); }
    return table;
  };
  let writes = Promise.resolve();
  const serial = (fn) => { const task = writes.catch(() => {}).then(fn); writes = task; return task; };
  // 走っている呼出しと、後着の使用量の補正。close はこれらを中断して有限だけ待つ
  const active = new Set();
  const lateTasks = new Set();
  const cancels = new Set();
  // このプロセスが始まった時刻。sweep が、今まさに走っている呼出しの running を誤って中断扱いしないための境目
  const startedAt = now();

  const writeRow = (id, value) => serial(async () => {
    const t = open();
    t.save([[JOURNAL_KIND, id, value]]);
    const all = t.ofKind(JOURNAL_KIND);
    // 終わった分だけ直近 KEEP 件に絞る。running は件数に数えず、決して消さない。
    // status の欠けた壊れた行も「終わった行」として数える（running ではないので、残して無限に増やさない）
    const done = Object.values(all).filter((v) => v && v.status !== 'running').sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    if (done.length > JOURNAL_KEEP) t.save(done.slice(JOURNAL_KEEP).map((v) => [JOURNAL_KIND, v.callId, undefined]));
  });

  /**
   * 1 回の内部呼出し。成功なら { text, usage, callId }、止められた（signal・上限時間）なら
   * { text: '', usage, callId, aborted: true }（使用量は取れた分。無ければ null=不明）、失敗は投げる。
   * usage は { inputTokens, outputTokens, cachedTokens, costUsd } の一部・全部が null でもよい（測れない = 不明）。
   * @param {{ kind: string, backend: object, prompt: string, model?: string, effort?: string, mode?: string,
   *   signal?: AbortSignal, locale?: string, cwd?: string, accountId?: string, endpoint?: object, timeoutMs?: number, botId?: string }} o
   */
  async function runCall({ kind, backend, prompt, model, effort, mode, signal, locale, cwd, accountId, endpoint, timeoutMs, botId }) {
    const cap = capabilityValue(backend?.capabilities?.internalCall);
    if (!cap || typeof backend?.internalTurn !== 'function') throw internalUnavailableError(backend, locale);
    if (signal?.aborted) return abortedResult(null, null, null, 'signal');
    // 会話を持たないのでアカウントは呼び出しごとに解決する。accountId 未指定・'' は既定（ログイン中のアカウント）=
    // 旧経路（隠れた会話にアカウントを付けなかった）と同じ。互換の接続先の呼出しは接続先のキーで走る（prepareTurn と同じ順）
    const account = !endpoint && accountId ? await accountResolve(backend, accountId) : null;
    const scoped = account ? await backendForAccount(backend, account) : backend;
    const callId = crypto.randomUUID();
    const at = now();
    const row = (status, extra = {}) => ({ callId, kind, backend: backend.id, model: model ?? null, account: accountId || null,
      endpoint: endpoint?.id ?? null, ...(botId ? { botId } : {}), at, status, ...extra });
    // journal は呼出しの正本。書けなければ呼出しを始めない（記録の無い AI 消費を作らない）
    await writeRow(callId, row('running'));
    const meta = { kind, ...(botId ? { botId } : {}), ...(model ? { model } : {}), ...(accountId ? { account: accountId } : {}), ...(endpoint?.id ? { endpoint: endpoint.id } : {}) };
    const recordUsage = (usage, nativeId) => usageStore?.record({
      id: `internalTask:${callId}`, backend: backend.id, internalTask: meta,
      ...(usage && typeof usage === 'object' ? usage : {}), ...(nativeId ? { nativeSessionId: nativeId } : {}),
    });
    // 上限時間で打ち切った後、backend が遅れて返した分の使用量を、同じ usage_records の行（internalTask:<callId>）へ書き戻す。
    // 行は増やさず、(1) 移行用の全件置換ではなく対象の 1 行だけを補正し、(2) at は元の記録のまま残す（ADR 0115）。
    // amend を持たない場合も、成功にせず診断できる失敗として返す
    const updateLateUsage = (usage, nativeId) => {
      if (!usage || typeof usage !== 'object') return Promise.resolve(true);
      if (typeof usageStore?.amend !== 'function') return Promise.reject(new Error('usageStore.amend is unavailable'));
      const id = `internalTask:${callId}`;
      return usageStore.amend(id, { id, backend: backend.id, internalTask: meta,
        ...usage, ...(nativeId ? { nativeSessionId: nativeId } : {}) });
    };
    const lateOf = (settled) => settled && ('value' in settled ? settled.value : settled.error);
    // 全体の有限の上限。呼び出し元の中断と上限のどちらでも止まるよう、ここで畳んだ signal をバックエンドへ渡す。
    // backend が signal を無視しても待ち続けないよう、中断は Promise.race で打ち切る（下の猶予だけ部分使用量を拾う）
    const ac = new AbortController();
    let timedOut = false;
    let out = null, failure = null;
    const stop = () => ac.abort();
    const cancel = () => ac.abort();
    cancels.add(cancel);
    // 上の signal.aborted 検査から listener を付けるまでの間に中断されても、ac へ必ず伝える
    if (signal?.aborted) ac.abort();
    else signal?.addEventListener?.('abort', stop, { once: true });
    // 上限のタイマーは ref のまま（unref にすると、ほかに用の無いプロセスが待たずに終われてしまう）
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs ?? INTERNAL_TIMEOUT_MS);
    const aborted = new Promise((resolve) => {
      if (ac.signal.aborted) return resolve(ABORTED);
      ac.signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
    });
    const turned = Promise.resolve().then(() => scoped.internalTurn({ kind, prompt, model, effort, mode, signal: ac.signal, locale, cwd, endpoint,
      oauthToken: account?.token ?? null, account: account ?? null })).then((value) => ({ value }), (error) => ({ error }));
    const first = await Promise.race([turned, aborted]);
    let latePending = false;
    if (first === ABORTED) {
      // 中断の直後に返る分（部分の text・usage）だけを拾う。上限に猶予を足しても全体は有限のまま。
      // ここで返った本文は採用しない（中断した呼出しを成功扱いにしない）。usage だけを残す
      let graceTimer = null;
      const late = await Promise.race([turned, new Promise((resolve) => { graceTimer = setTimeout(resolve, ABORT_GRACE_MS); })]);
      clearTimeout(graceTimer);
      if (late && late !== ABORTED) { if ('value' in late) out = late.value; else failure = late.error; }
      else latePending = true;
    } else if ('value' in first) out = first.value;
    else failure = first.error;
    clearTimeout(timer);
    cancels.delete(cancel);
    signal?.removeEventListener?.('abort', stop);
    const wasAborted = ac.signal.aborted || signal?.aborted || out?.aborted === true;
    // 呼出しが発生した分の使用量は、成功・失敗・中断のどれでも 1 行残す。失敗・中断で取れた分（backend が e.usage に載せた分）も拾う
    const usage = out?.usage ?? failure?.usage ?? null;
    const nativeId = out?.nativeId ?? failure?.nativeId ?? null;
    // 使用量の記録も正本の一部。書けなければ呼出しを成功・中断扱いしない（消費が帳簿に残らないため。AGENTS の DB 書込み失敗の規則）
    try { await recordUsage(usage, nativeId); }
    catch (e) {
      await writeRow(callId, row('failed', { endedAt: now(), error: `usage record failed: ${String(e?.message ?? e).slice(0, ERROR_MAX)}`, usage })).catch(() => {});
      throw e;
    }
    if (wasAborted) {
      const finalRow = row('aborted', { endedAt: now(), reason: timedOut ? 'timeout' : 'signal', usage });
      await writeRow(callId, finalRow);
      // 猶予の後に返った分の usage は、同じ usage_records の行へ書き戻す（行を増やさない）。
      // 補正に失敗したら、既に返した呼び出し元は成功に変えず、journal に診断できる印を残す。
      // 終わり始めていたら DB を開き直さない（この呼出しは aborted の行として復元側に残る）
      if (latePending) {
        const task = turned.then(async (settled) => {
          const value = lateOf(settled);
          if (!value?.usage || typeof value.usage !== 'object' || closing || closed) return;
          try {
            const amended = await updateLateUsage(value.usage, value.nativeId);
            if (amended === false) await writeRow(callId, { ...finalRow, lateUsageError: 'usage row was not found' });
          } catch (e) {
            if (!closing && !closed) await writeRow(callId, { ...finalRow, lateUsageError: String(e?.message ?? e).slice(0, ERROR_MAX) });
          }
        }).catch((e) => console.error('  internal-call: could not record late usage:', String(e?.message ?? e)));
        lateTasks.add(task);
        task.then(() => lateTasks.delete(task), () => lateTasks.delete(task));
      }
      return abortedResult(usage, callId, nativeId, timedOut ? 'timeout' : 'signal');
    }
    if (failure != null) {
      await writeRow(callId, row('failed', { endedAt: now(), error: String(failure?.message ?? failure).slice(0, ERROR_MAX), usage }));
      throw failure;
    }
    if (out == null) {
      await writeRow(callId, row('aborted', { endedAt: now(), reason: 'signal', usage }));
      return abortedResult(usage, callId, nativeId, 'signal');
    }
    await writeRow(callId, row('ok', { endedAt: now(), usage }));
    return { text: String(out.text ?? ''), usage, callId };
  }
  function abortedResult(usage, callId, nativeId, reason) {
    return { text: '', usage, callId, ...(nativeId ? { nativeId } : {}), aborted: true, reason };
  }

  /** 起動時: 前のプロセスが書き残した running を interrupted に掃く。このプロセスが始まってからの分は走っている途中なので触らない */
  async function sweep() {
    await writes.catch(() => {});
    const rows = open().ofKind(JOURNAL_KIND);
    const stale = Object.values(rows).filter((v) => v?.status === 'running' && (v.at ?? 0) < startedAt);
    if (stale.length) await serial(async () => open().save(stale.map((v) => [JOURNAL_KIND, v.callId, { ...v, status: 'interrupted', endedAt: now() }])));
  }

  /** 試験・診断用の読み出し（画面・操作には出さない） */
  async function journal(kind = null, limit = JOURNAL_KEEP) {
    await writes.catch(() => {});
    const rows = Object.values(open().ofKind(JOURNAL_KIND)).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    return (kind ? rows.filter((r) => r?.kind === kind) : rows).slice(0, limit);
  }

  /** 新しい呼出しを受け付け、走っている呼出しを中断してから journal を閉じる（DB を開き直さない） */
  function call(args) {
    if (closing || closed) return Promise.reject(new Error('internal calls are closed'));
    const task = runCall(args);
    active.add(task);
    task.then(() => active.delete(task), () => active.delete(task));
    return task;
  }

  async function close() {
    if (closed) { await writes.catch(() => {}); return; }
    closing = true;
    // 走っている呼出しに中断を伝える。backend が signal を無視しても、呼出しの上限 + 猶予で有限に戻る
    for (const cancel of [...cancels]) { try { cancel(); } catch {} }
    const pending = [...active, ...lateTasks];
    if (pending.length) await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, ABORT_GRACE_MS + 1000))]);
    closed = true;
    await writes.catch(() => {});
    handle?.release(); handle = null; table = null;
  }

  return { call, sweep, journal, close };
}
