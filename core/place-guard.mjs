// 場所（リポジトリ）ごとの見張り（ADR 0353）。Pleiad が自分から始める裏の作業（git の状態・撮影など。誰も結果を待たない）が、
// 遅いファイルシステム（Google Drive for desktop・Dokan など）で積み上がらないようにする、**git に限らない共通の仕組み**。
// 場所は文字列の鍵で、git-info はリポジトリのルートを使う。3 つの部品:
//
//   ① 止めても終われない子の数（leftover）。子が I/O 待ちで kill を無視すると、止めても本当には終わらない。run() は待たずに戻る
//      （core/process.mjs の killDeadlineMs）ので、その子を「生きている」と数え、生きている間はその場所へ新しい裏の作業を始めない（BUSY）
//   ② 時間切れが続いた場所は、一定時間休む（REST）。休みは続くほど長くなり、1 度でも普通に終われば戻る。種類は light（読み）と heavy（撮影など）で、
//      heavy の時間切れは light を休ませない（大きいリポジトリの撮影が遅いだけで、状態の確認まで止めない）
//   ③ 同じ種類の裏の作業は、同じ場所で 1 本ずつ（coalesce）。join は走っているものに相乗りし、trailing は「走っているものの次の 1 回」を共有する
//      （走り始めた後に頼んだ側へ、前の結果を渡さないため。撮影はこちら）。待つ側が全員いなくなったら、走っているものを止める
//
// どれも自動で戻る（子が終われば BUSY が解け、休みは時間が過ぎれば解ける）。止める（kill）処理は残すが、それに頼らない。

/** 場所の鍵（区切りと大文字小文字をそろえる。Windows・macOS のパスは大文字小文字を区別しない） */
export function placeKey(dir) {
  const k = String(dir ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? k.toLowerCase() : k;
}

/** 時間切れが連続した回数ごとの休み。2 回目から 30 秒・60 秒・120 秒・300 秒（以後 300 秒）。根拠は ADR 0353 */
export const REST_LADDER_MS = [30_000, 60_000, 120_000, 300_000];
/** 何回続けて時間切れになったら休むか（1 回はウイルス検査・初回の走査などの一時の遅れのことがある） */
export const REST_AFTER_TIMEOUTS = 2;

const MAX_ALIASES = 500;

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

export function createPlaceGuard({ now = Date.now, ladder = REST_LADDER_MS, restAfter = REST_AFTER_TIMEOUTS, isAlive = pidAlive } = {}) {
  const places = new Map();    // 場所 → { leftovers: Map<pid, { pid, since }>, light, heavy }
  const aliases = new Map();   // 呼び出しの cwd の鍵 → 場所（ルートが分かったら、サブフォルダーもルートの場所として数える）
  const lane = () => ({ consecutive: 0, lastTimeoutAt: 0, restUntil: 0 });
  const ensure = (place) => {
    let st = places.get(place);
    if (!st) { st = { leftovers: new Map(), light: lane(), heavy: lane() }; places.set(place, st); }
    return st;
  };

  /** dir が属する場所（alias が無ければ dir そのもの） */
  const placeOf = (dir) => { const k = placeKey(dir); return aliases.get(k) ?? k; };
  /** dir は place（リポジトリのルートなど）の中。以後の dir への問い合わせは place として数える */
  function alias(dir, place) {
    const k = placeKey(dir), p = placeKey(place);
    if (!k || !p || k === p || aliases.get(k) === p) return;
    if (aliases.size >= MAX_ALIASES) aliases.delete(aliases.keys().next().value);
    aliases.set(k, p);
  }

  /** 生きている「止めても終われなかった子」の数。もう居ない pid はここで外す */
  function alive(place) {
    const st = places.get(place);
    if (!st) return 0;
    for (const [pid] of st.leftovers) if (!isAlive(pid)) st.leftovers.delete(pid);
    return st.leftovers.size;
  }

  /** この場所へ今、裏の作業を始めてよいか。始めない理由（'BUSY' 生きている子がある・'REST' 休み中）か null */
  function blocked(place, cls = 'light') {
    const st = places.get(place);
    if (!st) return null;
    if (alive(place) > 0) return 'BUSY';
    const t = now();
    if (st.light.restUntil > t) return 'REST';
    if (cls === 'heavy' && st.heavy.restUntil > t) return 'REST';
    return null;
  }

  /** 止めても終われなかった子を数える。ended（子が本当に終わったとき解ける Promise）で外す */
  function leftover(place, { pid, ended } = {}) {
    if (!pid) return;
    const st = ensure(place);
    const entry = { pid, since: now() };
    st.leftovers.set(pid, entry);
    Promise.resolve(ended).then(() => { if (st.leftovers.get(pid) === entry) st.leftovers.delete(pid); }, () => {});
  }

  /**
   * 時間切れ。startedAt は、その子を始めた時刻。同じ詰まりで一斉に時間切れになった分（前の時間切れより前に始めたもの）は 1 回に数える
   * （7 つの会話が同時に頼んだ 7 本が一緒に時間切れになっても、連続 7 回とは見ない）
   */
  function timedOut(place, cls, startedAt) {
    const l = ensure(place)[cls === 'heavy' ? 'heavy' : 'light'];
    if (startedAt < l.lastTimeoutAt) return;
    l.lastTimeoutAt = now();
    l.consecutive += 1;
    if (l.consecutive >= restAfter) l.restUntil = l.lastTimeoutAt + ladder[Math.min(l.consecutive - restAfter, ladder.length - 1)];
  }

  /** 時間切れにならずに終わった（成功も、git のエラー終了も含む）。休みと連続の数を戻す。heavy が終われたなら light も動いている */
  function completed(place, cls) {
    const st = places.get(place);
    if (!st) return;
    st.light = lane();
    if (cls === 'heavy') st.heavy = lane();
  }

  // ---------------------------------------------------------------- 同じ種類の裏の作業を 1 本ずつ

  const slots = new Map();   // 鍵 → { running, next }
  const noop = () => {};

  const drop = (key, slot) => { if (!slot.running && !slot.next && slots.get(key) === slot) slots.delete(key); };

  function start(key, slot, run, work) {
    slot.running = run;
    run.promise = Promise.resolve().then(() => work(run.ctl.signal)).finally(() => {
      if (slot.running === run) slot.running = null;
      drop(key, slot);
    });
    run.promise.catch(noop);
    return run;
  }

  /** 結果を待つ側を 1 人足す。signal が止まったら、この側だけ null で抜ける。待つ側が全員抜けたら、走っているもの（まだなら始めない）を止める */
  function attach(run, signal) {
    run.waiters += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        run.waiters -= 1;
        if (run.waiters <= 0) run.ctl.abort();
        resolve(null);
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      Promise.resolve(run.promise).then(
        (value) => { if (settled) return; settled = true; signal?.removeEventListener?.('abort', onAbort); resolve(value); },
        (error) => { if (settled) return; settled = true; signal?.removeEventListener?.('abort', onAbort); reject(error); },
      );
    });
  }

  /**
   * 同じ鍵の仕事を 1 本ずつ走らせる。work(signal) の signal は、待つ側が全員 signal で抜けたときに止まる。
   *   join     走っているものがあれば、その結果に相乗りする（無ければ始める）
   *   trailing 走っているものがあれば、その終わりの後に 1 回だけ走らせ、その間に来た側みんなで結果を共有する（無ければ始める）
   * signal で抜けた側は null を受け取る
   */
  function coalesce(key, work, { mode = 'join', signal = null } = {}) {
    let slot = slots.get(key);
    if (!slot) { slot = { running: null, next: null }; slots.set(key, slot); }
    if (!slot.running) return attach(start(key, slot, { ctl: new AbortController(), waiters: 0, promise: null }, work), signal);
    if (mode === 'join') return attach(slot.running, signal);
    if (!slot.next) {
      const next = { ctl: new AbortController(), waiters: 0, promise: null };
      slot.next = next;
      const after = slot.running.promise.then(noop, noop);
      next.promise = after.then(() => {
        if (slot.next === next) slot.next = null;
        if (next.waiters <= 0 || next.ctl.signal.aborted) { drop(key, slot); return null; }
        // 同じ object のまま走らせる（待つ側の数と止める口を、始まる前と後で共有する。後から相乗りする側も同じ数に入る）
        return start(key, slot, next, work).promise;
      });
      next.promise.catch(noop);
    }
    return attach(slot.next, signal);
  }

  /** 状態の写し（試験・診断用） */
  function snapshot(place) {
    const st = places.get(place);
    if (!st) return { alive: 0, light: lane(), heavy: lane() };
    return { alive: alive(place), light: { ...st.light }, heavy: { ...st.heavy } };
  }
  const reset = () => { places.clear(); aliases.clear(); slots.clear(); };

  return { placeOf, alias, blocked, alive, leftover, timedOut, completed, coalesce, snapshot, reset };
}
