/**
 * 脇の行の移動（状態・グループ所属）を、受理した順に行ごとの列へ並べる。
 *
 * - 画面へは受理した瞬間に最新の移動先を出す（patchFor）。保存は行ごとに 1 本ずつ流す。
 * - まだ送っていない同じ対象への移動は、後から来た 1 件へまとめる（coalesceKey と対象の行が同じもの）。
 * - 対象は受理の時点で確定する。run は受理後に変わる画面の状態を読まない。
 * - 保存の完了は、一覧の取り直しを待たない。保存済みの移動先は、その後に始めた取り直しが届くまで
 *   settled として保つ（取り直しの古い返事で行が戻って見えるのを防ぐ。confirm）。
 * - 失敗した操作の表示だけを外す。後続の移動が列に残っていれば、それはそのまま続く。
 *   失敗した操作の「操作前の値」は、同じ行の次の操作が、失敗した操作が動かした項目だけ引き継ぐ（保存されなかった途中の値へ
 *   「元に戻す」が戻らないように。関係のない項目は後続自身の値のまま）。複数の行をまとめた操作の失敗は、どの行まで保存できたか
 *   分からないので、引き継いだ値に uncertain を付ける（呼び手は、確かでない値を元に戻す先として書かない）。
 * - 描き直し（onChange）が例外を投げても、列の持ち場と結果の約束は必ず解く（onError へ渡して続ける）。
 */
export function createMoveLanes({
  onChange = () => {},
  describe = () => '',
  stamp = () => 0,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  showAfterMs = 150,
  onError = (error) => { setTimeout(() => { throw error; }); },
} = {}) {
  const tails = new Map();     // rowId → その行へ最後に受理した操作の持ち場（slot。保存が終わるか、まとめられた操作が先を待ち終えたら空く。reject しない）
  const active = new Map();    // rowId → 受理順の操作（queued / running）
  const settled = new Map();   // rowId → { patch, after }
  const entries = new Map();   // rowId → 行へ出す印 { kind, text, visible, queued, target }
  const timers = new Map();
  let serial = 0;

  // 描き直しの例外で列を止めない（持ち場が空かないまま残ると、後ろの移動も削除も待ち続ける）。例外は握りつぶさず onError へ渡す
  const notify = () => { try { onChange(); } catch (error) { onError(error); } };

  const opsOf = (id) => active.get(id) ?? [];

  function patchFor(id) {
    const ops = opsOf(id);
    const saved = settled.get(id)?.patch;
    if (!ops.length && !saved) return undefined;
    return Object.assign({}, saved, ...ops.map((op) => op.patches.get(id)));
  }

  function refreshEntry(id) {
    const ops = opsOf(id);
    if (!ops.length) {
      entries.delete(id);
      clearTimer(timers.get(id));
      timers.delete(id);
      return;
    }
    const waiting = ops.filter((op) => op.state === 'queued');
    const target = waiting.length ? waiting[waiting.length - 1].patches.get(id)?.status : undefined;
    const queued = target !== undefined;
    let entry = entries.get(id);
    if (!entry) {
      entry = { kind: 'move', text: '', visible: false, queued: false, target: undefined };
      entries.set(id, entry);
      timers.set(id, setTimer(() => { entry.visible = true; onChange(); }, showAfterMs));
    }
    entry.queued = queued;
    entry.target = target;
    entry.text = describe({ queued, target });
    // 先の予約が入った行は、150ms を待たずに予約を見せる（最新の意図が受理されたことを示す）
    if (queued) entry.visible = true;
  }

  function detach(op) {
    for (const id of op.rows) {
      const ops = opsOf(id).filter((x) => x !== op);
      if (ops.length) active.set(id, ops); else active.delete(id);
    }
  }

  function supersede(old, next) {
    old.state = 'superseded';
    detach(old);
    // 取り消しの行き先は、まとめた最初の操作の前の状態にする（まとめて消えた中間の移動先へは戻さない）
    for (const [id, snap] of old.before) next.before.set(id, snap);
    // 呼び出し元へは すぐ知らせるが、持ち場（slot）は旧操作が先の保存を待ち終えるまで空けない。
    // 旧操作の後ろに並んだ別の操作が、先の保存の途中で始まらないようにする。後継も同じ先を待つ
    for (const wait of old.waits) if (!next.waits.includes(wait)) next.waits.push(wait);
    old.resolve({ status: 'superseded', before: old.before, rows: old.rows });
  }

  function accept({ rows, patches, before = new Map(), coalesceKey = '', run }) {
    const ids = [...new Set(rows.map((r) => (typeof r === 'string' ? r : r.id)))];
    const op = {
      id: ++serial, rows: ids, patches: new Map(ids.map((id) => [id, { ...(patches.get(id) ?? {}) }])),
      before: new Map(before), coalesceKey, run, state: 'queued', error: null, resolve: null, waits: [], release: null,
    };
    const finished = new Promise((resolve) => { op.resolve = resolve; });
    const slot = new Promise((resolve) => { op.release = resolve; });
    const sameRows = (other) => other.rows.length === ids.length && other.rows.every((id) => ids.includes(id));
    if (coalesceKey) {
      const seen = new Set();
      for (const id of ids) for (const other of opsOf(id)) {
        if (seen.has(other) || other.state !== 'queued' || other.coalesceKey !== coalesceKey || !sameRows(other)) continue;
        seen.add(other);
        supersede(other, op);
      }
    }
    for (const id of ids) {
      const tail = tails.get(id);
      if (tail && !op.waits.includes(tail)) op.waits.push(tail);
    }
    for (const id of ids) {
      active.set(id, [...opsOf(id), op]);
      tails.set(id, slot);
    }
    // 先に待つ保存が無ければ、そのまま始める（待つ間だけが queued）
    if (!op.waits.length) op.state = 'running';
    for (const id of ids) refreshEntry(id);
    notify();
    (async () => {
      if (op.waits.length) {
        await Promise.all(op.waits);
        if (op.state === 'superseded') { op.release(); return; }
        op.state = 'running';
        try { for (const id of ids) refreshEntry(id); } catch (error) { onError(error); }
        notify();
      }
      let failure = null;
      try { await op.run(); } catch (error) { failure = error ?? new Error('failed'); }
      op.state = failure ? 'failed' : 'done';
      op.error = failure;
      // 帳簿の途中で例外が出ても、持ち場と結果の約束は必ず解く
      try {
        detach(op);
        for (const id of ids) if (tails.get(id) === slot) tails.delete(id);
        if (failure) {
          // 保存できなかった値は、後続の「操作前の値」に残さない（その行の次の操作は、この操作が動かした項目だけ、この操作の前の値を引き継ぐ）。
          // 1 行だけの操作の失敗は保存されていないと見てよい。複数の行をまとめた操作は一部だけ保存できていることがあるので、確かでない印を付ける
          for (const id of ids) {
            const next = opsOf(id)[0];
            const was = op.before.get(id);
            if (!next || !was) continue;
            const merged = { ...next.before.get(id) };
            for (const key of Object.keys(op.patches.get(id) ?? {})) if (key in was) merged[key] = was[key];
            if (ids.length > 1 || was.uncertain || merged.uncertain) merged.uncertain = true;
            next.before.set(id, merged);
          }
        } else {
          const after = stamp();
          for (const id of ids) settled.set(id, { patch: { ...settled.get(id)?.patch, ...op.patches.get(id) }, after });
        }
        for (const id of ids) refreshEntry(id);
      } catch (error) {
        onError(error);
      } finally {
        op.release();
        notify();
        op.resolve({ status: failure ? 'failed' : 'done', error: failure, before: op.before, rows: ids, patches: op.patches });
      }
    })();
    return finished;
  }

  /** 保存の後に始めた取り直しが一覧を適用したら、保存済みの移動先は取り直しの結果に任せる */
  function confirm(version) {
    let changed = false;
    for (const [id, saved] of settled) {
      if (saved.after >= version || opsOf(id).length) continue;
      settled.delete(id);
      changed = true;
    }
    return changed;
  }

  return {
    accept,
    confirm,
    patchFor,
    entries,
    isActive: (id) => opsOf(id).length > 0,
    /** その行へ受理済みの移動がすべて決着したら解ける（削除など、移動の後に始めたい操作が待つ。reject しない） */
    idle: (id) => tails.get(id) ?? Promise.resolve(),
    /** patchFor がある行の id（取り直しの上書きに使う） */
    patches() {
      const out = new Map();
      for (const id of new Set([...active.keys(), ...settled.keys()])) out.set(id, patchFor(id));
      return out;
    },
  };
}

/**
 * 複数の保存を並べて流し、全部の応答が決着してから最初の失敗を投げる。
 * Promise.all は最初の失敗で戻るので、残りの書き込みが走っている間に列の持ち場が空き、次の操作と重なる。
 */
export async function settleAll(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((r) => r.value);
}
