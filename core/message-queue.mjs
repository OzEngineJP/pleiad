// Durable acceptance is separate from execution. A lost backend acknowledgement
// is never retried automatically: the original may already have been consumed.
import { t } from './i18n.mjs';
export function createMessageQueue({ store, active, start, changed, delivered, applyReserved = null, prepare = null, discard = null }) {
  const locks = new Map();
  const workers = new Map();
  const steering = new Map();
  const serial = (id, fn) => {
    const next = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    locks.set(id, next);
    next.finally(() => { if (locks.get(id) === next) locks.delete(id); }).catch(() => {});
    return next;
  };
  const list = async id => structuredClone((await store.get(id)).outbox ?? []);
  // 送信待ちが何を待っているか（sessionId -> { reason }）。保存しない。kick のたびに決め直し、
  // 画面へ渡すときだけ queued の項目に waiting として添える。
  const waits = new Map();
  const view = (id, items) => {
    const wait = waits.get(id);
    return wait ? items.map(m => {
      if (m.status !== 'queued') return m;
      const { messageId, ...waiting } = wait;
      return { ...m, waiting: messageId && messageId !== m.id ? { reason: 'order' } : waiting };
    }) : items;
  };
  const save = async (id, items) => {
    await store.setSessionData(id, 'outbox', items, { durable: true });
    changed(id, view(id, items));
  };
  const setWait = async (id, wait) => {
    if (JSON.stringify(waits.get(id) ?? null) === JSON.stringify(wait)) return;
    if (wait) waits.set(id, wait); else waits.delete(id);
    changed(id, view(id, await list(id)));
  };
  const update = (id, messageId, patch, expected) => serial(id, async () => {
    const items = await list(id);
    const item = items.find(m => m.id === messageId);
    if (!item || (expected && item.status !== expected)) return null;
    Object.assign(item, patch);
    await save(id, items);
    return item;
  });
  async function drain(id) {
    for (;;) {
      const items = await list(id);
      const item = items.find(m => !['sent', 'cancelled'].includes(m.status));
      if (!item || item.status !== 'queued') {
        // 先頭が保留・失敗・結果不明なら、後ろの送信待ちは順序を守ってそれを待つ
        return setWait(id, items.some(m => m.status === 'queued') ? { reason: 'order' } : null);
      }
      if (discard && await discard(id, item)) {
        await update(id, item.id, { status: 'cancelled' }, 'queued');
        continue;
      }
      let turn = await active(id, item);
      if (turn?.blocked) return setWait(id, turn.wait ?? { reason: 'turn' });
      let args = item.args;
      const snapshot = args.settings;
      if (snapshot) {
        await setWait(id, { reason: 'preparing', messageId: item.id });
        try {
          if (prepare) args = await prepare(id, item);
          // 準備の間に取り消されたなら、読み直して決め直す
          if (!(await list(id)).some(m => m.id === item.id && m.status === 'queued')) continue;
          turn = await active(id, item);
          if (turn?.blocked) return setWait(id, turn.wait ?? { reason: 'turn' });
          if (turn) {
            const how = await applyReserved?.(id, turn, args.worktreeCwd ? { ...args.settings, cwd: args.worktreeCwd } : args.settings);
            if (how === 'stop' || how === 'wait') return setWait(id, { reason: 'turn' });
          }
        } catch (e) {
          if (await update(id, item.id, { status: 'failed', error: String(e.message ?? e), connectorsError: e?.connectorsError ?? null }, 'queued')) return;
          continue;
        }
      }
      // 作業中に送ったら、面で選んでおいた予約（nextSettings）を今のターンへ効かせてから渡す（docs/design-system.md「作業中の設定の変更」）。
      // applyReserved（server の applyReservedNow）: 'live' = 止めずに切り替えた（そのまま途中送信へ）／'stop' = 止め始めた
      // （止まったら列が新しい設定のターンでこの発言を始める）／'wait' = 止められない（次のターンへ回す）。
      // main が返答を終えて裏だけを待っている間（phase: waiting）は止めない。予約と帯を残し、途中送信だけ渡す
      if (!snapshot && turn && turn.phase !== 'waiting' && applyReserved && (await store.get(id)).nextSettings) {
        const how = await applyReserved(id, turn);
        if (how === 'stop') return setWait(id, { reason: 'turn' });
        if (how === 'wait') return setWait(id, { reason: 'turn', detail: 'reserved' });
      }
      if (turn && !turn.steer) return setWait(id, { reason: 'turn' });
      // 次のターンの設定の予約（nextSettings）がある間、途中送信は予約より先に今のターンで処理される。
      // main が動いている間は、すぐ終わるのでターンの終わりを待ち、新しいターンで予約を効かせる。
      // main が返答を終えて裏だけを待っている間（phase: waiting）は終わらないことがあるので待たない。
      // 予約は消さず、次のターンから効く（docs/multi-backend.md §2.2）
      if (!snapshot && turn && turn.phase !== 'waiting' && (await store.get(id)).nextSettings) return setWait(id, { reason: 'turn', detail: 'reserved' });
      const starting = snapshot && !turn;
      // 新しいターンで始める項目は、受け付けられるまで queued のまま。始めた発言（userMessage の initial）を
      // 画面が「待ちに戻された」と取り違えないよう、準備中の印（waiting）は始める前に外す
      if (!starting) {
        waits.delete(id);
        if (!await update(id, item.id, { status: 'sending', error: null, connectorsError: null }, 'queued')) continue;
      } else await setWait(id, null);
      if (turn) {
        const delivery = (async () => {
          try {
            if (discard && await discard(id, item)) {
              await update(id, item.id, { status: 'cancelled' }, 'sending');
              return true;
            }
            const accepted = await turn.steer(item);
            if (!accepted) {
              waits.set(id, { reason: 'turn' });
              await update(id, item.id, { status: 'queued' });
              return false;
            }
            await update(id, item.id, { status: 'sent' });
            await delivered(id, item, turn);
            return true;
          } catch (e) {
            await update(id, item.id, { status: 'unknown', error: String(e.message ?? e) });
            return false;
          }
        })();
        steering.set(id, delivery);
        try { if (!await delivery) return; } finally { steering.delete(id); }
      } else {
        // Keep one worker per conversation, with no queue lock held during startup.
        let ready;
        const started = new Promise(resolve => { ready = resolve; });
        let accepted = false;
        let discarded = false;
        const task = Promise.resolve().then(() => start({ ...args, sessionId: id, messageId: item.id, at: item.at }, async () => {
          waits.delete(id);
          const patch = starting ? { status: 'sending', dispatch: 'initial' } : { status: 'sent' };
          if (!await update(id, item.id, patch, starting ? 'queued' : 'sending')) return false;
          accepted = true;
          ready();
          return true;
        }));
        task.then(outcome => {
          if (outcome === 'discarded') {
            discarded = true;
            return update(id, item.id, { status: 'cancelled' }, starting ? 'queued' : 'sending');
          }
          // Nothing was delivered (the agent was busy with a turn Pleiad did not start).
          // Back to the queue; that turn's end kicks the queue again.
          if (outcome === 'requeue') {
            waits.set(id, { reason: 'turn' });
            return update(id, item.id, { status: 'queued', dispatch: null, error: null, connectorsError: null }, accepted && !starting ? 'sent' : starting && !accepted ? 'queued' : 'sending');
          }
          if (outcome === 'undelivered' && starting && !accepted) {
            return update(id, item.id, { status: 'failed', error: t('queue.undelivered') }, 'queued');
          }
          if (outcome && outcome !== 'ok' && outcome !== 'cancelled') return pause(id);
        }, e => update(id, item.id, {
          status: accepted ? 'unknown' : 'failed', error: String(e.message ?? e),
          connectorsError: e?.connectorsError ?? null,
        }, accepted && !starting ? 'sent' : starting && !accepted ? 'queued' : 'sending')).finally(() => {
          ready();
          if (accepted || discarded) kick(id).catch(() => {});
        }).catch(() => {});
        await started;
        return;
      }
    }
  }
  function kick(id) {
    const current = workers.get(id);
    if (current) { current.again = true; return current.done; }
    const worker = { again: false };
    worker.done = Promise.resolve().then(async () => {
      do {
        worker.again = false;
        await drain(id);
      } while (worker.again);
    }).finally(() => workers.delete(id));
    workers.set(id, worker);
    return worker.done;
  }
  const pause = id => serial(id, async () => {
    const items = await list(id);
    if (!items.some(item => item.status === 'queued')) return;
    for (const item of items) if (item.status === 'queued') item.status = 'paused';
    await save(id, items);
  });
  // 保留（paused）を全部、並びのまま送信待ちへ戻す。1 件ずつの「再送する」（action の retry）と同じ書き換えを、
  // 中断した会話の「再開」と、中断した会話への新しい送信でまとめて行う（core/server.mjs の resumeSession・sendMessage）。
  // failed: true なら送れなかった（failed）ものも戻す。failed はエージェントに渡っていない（undelivered）ので送り直してよい。
  // 結果不明（unknown）は戻さない（届いているかもしれない。人が確かめて選ぶ）。戻した項目の id を並びのまま返す
  const retryPaused = async (id, { failed = false } = {}) => {
    const released = await serial(id, async () => {
      const items = await list(id);
      const ids = [];
      for (const item of items) {
        if (item.status !== 'paused' && !(failed && item.status === 'failed')) continue;
        item.status = 'queued'; item.error = null; item.connectorsError = null; ids.push(item.id);
      }
      if (ids.length) await save(id, items);
      return ids;
    });
    if (released.length) kick(id).catch(() => {});
    return released;
  };
  return {
    get busy() { return locks.size > 0 || workers.size > 0; },
    /** 送信の処理中の会話（引き継ぎを待たせている会話） */
    busySessions() { return [...new Set([...locks.keys(), ...workers.keys()])]; },
    retryPaused,
    settleSteering: id => steering.get(id),
    list: id => serial(id, async () => view(id, await list(id))), kick, pause,
    async confirmed(id, messageId) {
      await update(id, messageId, { status: 'sent' }, 'sending');
      kick(id).catch(() => {});
    },
    // ターンは始めたが、バックエンドがプロンプトを渡す前に失敗した。送っていないので失敗として残し、再送か取り消しを選ばせる
    undelivered: (id, messageId, error, connectorsError = null) => serial(id, async () => {
      const items = await list(id);
      const item = items.find(m => m.id === messageId);
      if (!item || !['sent', 'sending'].includes(item.status)) return;
      item.status = 'failed';
      item.error = error;
      if (connectorsError) item.connectorsError = connectorsError; else delete item.connectorsError;
      await save(id, items);
    }),
    // 渡った合図を出せないバックエンド（性質 promptDelivery = false）で、渡ったか分からないまま終わった発言。
    // 届いているかもしれないので、自動で送り直すとネイティブの履歴に二重に登る。失敗（failed は再開で自動再送される）
    // ではなく結果不明（unknown）にし、利用者が確かめてから再送か取り消しを選ぶ
    uncertain: (id, messageId, error) => serial(id, async () => {
      const items = await list(id);
      const item = items.find(m => m.id === messageId);
      if (!item || !['sent', 'sending'].includes(item.status)) return;
      item.status = 'unknown';
      item.error = error;
      await save(id, items);
    }),
    // 受理された途中送信が、読まれないまま捨てられた。勝手に送り直さず、保留にして利用者に選ばせる
    // （ターンが死んだ直後なので、続けて送ってよいかは分からない）
    returned: (id, messageId) => serial(id, async () => {
      const items = await list(id);
      const item = items.find(m => m.id === messageId);
      if (!item || item.status !== 'sent') return;
      item.status = 'paused';
      await save(id, items);
    }),
    // adopted: 付け直すターンの会話（無停止の更新 2b-4）→ 札の steers の id。走っているターンの後ろに並んだ送信は保留にせず、
    // 札が控えている途中送信（渡った合図を待つもの。2b-7）は結果不明にしない
    // keepQueued: 引き継ぎの起動（無停止の更新 2d）。旧サーバーが送信待ちに回した分（queued）は保留にせず、新しいサーバーが送る
    async recover({ adopted = new Map(), keepQueued = false } = {}) {
      for (const [id, meta] of Object.entries(await store.getAll())) {
        if (!meta.outbox?.length) continue;
        const items = await list(id);
        const steers = adopted.get(id);
        const recovered = [];
        for (const item of items) {
          if (item.status === 'sending' && !steers?.has(item.id)) {
            // For an adopted held turn, the server writes the steer id into its holder label
            // before writing the input to the child. A missing id therefore means the child
            // could not have received it, so resume the durable outbox item instead of losing it.
            // Without an adopted turn, delivery remains ambiguous and must not be retried.
            item.status = steers && item.dispatch !== 'initial' ? 'queued' : 'unknown';
          } else if (item.status === 'sending' && steers?.has(item.id)) {
            // The held backend has the request. Complete the durable acceptance and
            // notification after adoption; the old server's in-memory callback is gone.
            item.status = 'sent';
            recovered.push(item);
          }
          if (item.status === 'queued' && !steers && !keepQueued && !item.args.settings) item.status = 'paused';
        }
        await save(id, items);
        for (const item of recovered) {
          const current = await active(id);
          const turn = current?.turn ?? current;
          if (turn) await delivered(id, item, { turn, recovered: true });
        }
      }
    },
    /**
     * 受け付けられるかだけを確かめる（積まない）。同じ id で同じ中身なら 'accepted'（受け付け済みの送り直し）、新しく積めるなら 'new'。
     * 積めない（同じ id で別の中身・送信待ちが満杯）なら accept と同じ理由で投げる。履歴を変えてから受け付ける送信（巻き戻し）が、
     * 先にこれで確かめて、受け付けられないのに履歴だけ変わることを防ぐ
     */
    async check(id, messageId, args) {
      return serial(id, async () => {
        const items = await list(id);
        const existing = items.find(m => m.id === messageId);
        if (existing) {
          if (JSON.stringify(existing.args) !== JSON.stringify(args)) throw new Error(t('queue.idConflict'));
          return 'accepted';
        }
        if (items.filter(m => !['sent', 'cancelled'].includes(m.status)).length >= 100) throw new Error(t('queue.full', { max: 100 }));
        return 'new';
      });
    },
    async accept(id, messageId, args, { resumePaused = false } = {}) {
      const item = await serial(id, async () => {
        const items = await list(id);
        const existing = items.find(m => m.id === messageId);
        if (existing) {
          if (JSON.stringify(existing.args) !== JSON.stringify(args)) throw new Error(t('queue.idConflict'));
          return existing;
        }
        if (items.filter(m => !['sent', 'cancelled'].includes(m.status)).length >= 100) throw new Error(t('queue.full', { max: 100 }));
        if (resumePaused) {
          for (const pending of items) {
            if (pending.status !== 'paused') continue;
            pending.status = 'queued';
            pending.error = null;
            delete pending.connectorsError;
          }
        }
        const item = { id: messageId, args, at: new Date().toISOString(), status: 'queued' };
        items.push(item);
        await save(id, items);
        return item;
      });
      kick(id).catch(() => {});
      return item;
    },
    async action(id, messageId, action) {
      await serial(id, async () => {
        const items = await list(id);
        const item = items.find(m => m.id === messageId);
        if (!item || ['sent', 'sending', 'cancelled'].includes(item.status)) throw new Error(t('queue.notEditable'));
        if (!['cancel', 'retry'].includes(action)) throw new Error(t('queue.invalidAction'));
        item.status = action === 'cancel' ? 'cancelled' : 'queued';
        item.error = null;
        delete item.dispatch;
        delete item.connectorsError;
        await save(id, items);
      });
      kick(id).catch(() => {});
    },
  };
}
