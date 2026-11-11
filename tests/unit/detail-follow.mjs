// 子の会話のモーダルの詳細を、出来事に合わせて間引いて読み直す部品（web/detail-follow.mjs。ADR 0315 の段 2）。
//   - どの出来事が、どの詳細のきっかけになるか（古い子・別の会話の出来事は捨てる）
//   - 続けて来る出来事の間引き（先頭はすぐ・間隔内の分は 1 回・承認は待たせない・止めた後は走らない）
//   - 読み込みが重いときの間隔・入力中の待たせ方・フォーカスの戻し先の印
// 実ブラウザーでの動きは tests/browser/work-dialog-keep-open.mjs。
import {
  followMode, followsEvent, gapFor, createDetailGate, shouldHold, markFocus, restoreFocus,
  FOLLOW_MIN_MS, FOLLOW_MAX_MS,
} from "../../web/detail-follow.mjs";

export const name = "detail-follow";
export const title = "子の会話のモーダル: 出来事で間引いて読み直す・古い子の出来事は捨てる・入力中は待つ";

const child = { group: "agent", source: "task", childId: "child-1", taskId: "t1", live: true };
const sub = { group: "agent", source: "native", parentId: "parent-1", agentId: "a1", live: true };

/** 偽の時計と偽のタイマー。待った時間だけ進める */
function clock() {
  let at = 1000, id = 0;
  const timers = new Map();
  return {
    now: () => at,
    setTimer: (fn, ms) => { timers.set(++id, { fn, at: at + ms }); return id; },
    clearTimer: (h) => { timers.delete(h); },
    advance(ms) {
      const end = at + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        at = due[1].at;
        due[1].fn();
      }
      at = end;
    },
    pending: () => timers.size,
  };
}

export default async function (t) {
  const eq = (actual, expected, label) => t.ok(label, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} <> ${JSON.stringify(expected)}`);
  // ---- 出来事がどの詳細のものか ----
  eq(followMode(child, "parent-1"), "task", "委譲した子は task");
  eq(followMode({ ...child, host: { hostId: "h" } }, "parent-1"), null, "ホストに任せた子には出来事が届かない（従来の読み直し）");
  eq(followMode({ group: "command", source: "task" }, "parent-1"), null, "コマンドは対象外");
  eq(followMode(sub, "parent-1"), "subagent", "開いている会話のサブエージェントは subagent");
  eq(followMode(sub, "other"), null, "親が開いている会話でないサブエージェントには出来事が届かない");
  eq(followMode(null, "parent-1"), null, "項目が無ければ対象外");

  eq(followsEvent(child, "p", { type: "tool.start", sessionId: "child-1" }), { urgent: false }, "子の本文の出来事");
  eq(followsEvent(child, "p", { type: "text.delta", sessionId: "child-1" }), { urgent: false }, "子の本文の流れ");
  eq(followsEvent(child, "p", { type: "permission", sessionId: "child-1", id: "x" }), { urgent: true }, "子の承認は待たせない");
  eq(followsEvent(child, "p", { type: "permissionSettled", sessionId: "child-1", id: "x" }), { urgent: true }, "承認が片付いたのも待たせない");
  eq(followsEvent(child, "p", { type: "turnEnd", sessionId: "child-1" }), { urgent: true }, "ターンの終わり");
  eq(followsEvent(child, "p", { type: "tool.start", sessionId: "child-OLD" }), null, "前に見ていた別の子の出来事は捨てる");
  eq(followsEvent(child, "child-1", { type: "tool.start", sessionId: "p" }), null, "依頼元の会話の出来事ではない");
  eq(followsEvent(child, "p", { type: "running" }), null, "全体の配信は出来事のきっかけにしない（セッションに紐づかない）");
  eq(followsEvent(child, "p", { type: "title", sessionId: "child-1" }), null, "表示に関係しない出来事は読み直さない");
  eq(followsEvent({ ...child, host: { hostId: "h" } }, "p", { type: "tool.start", sessionId: "child-1" }), null, "ホストの子は出来事で読み直さない");
  eq(followsEvent(sub, "parent-1", { type: "tool.result", sessionId: "parent-1" }), { urgent: false }, "サブエージェントは親の道具の出来事で");
  eq(followsEvent(sub, "parent-1", { type: "text.delta", sessionId: "parent-1" }), null, "親の本文の流れは関係が薄いので読み直さない");
  eq(followsEvent(sub, "parent-1", { type: "tool.result", sessionId: "other" }), null, "別の会話の出来事は捨てる");
  eq(followsEvent(sub, "other", { type: "tool.result", sessionId: "parent-1" }), null, "親を開いていないときは出来事を使わない");

  // ---- 間隔 ----
  eq(gapFor(undefined), FOLLOW_MIN_MS, "読んだことがなければ最短");
  eq(gapFor(50), FOLLOW_MIN_MS, "軽ければ最短");
  eq(gapFor(700), 1400, "重ければ読み込みの時間の 2 倍");
  eq(gapFor(9000), FOLLOW_MAX_MS, "上限がある");

  // ---- 間引き: 先頭はすぐ、間隔内の分は 1 回にまとめる ----
  {
    const c = clock();
    const runs = [];
    const gate = createDetailGate({ run: (o) => runs.push({ at: c.now(), ...o }), gap: () => 400, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    gate.poke();
    eq(runs.length, 1, "最初の出来事はすぐ読む");
    c.advance(100);
    for (let i = 0; i < 20; i++) gate.poke();
    eq(runs.length, 1, "間隔内に来た 20 件は、まだ読まない");
    eq(gate.pending, true, "続きを 1 回予定している");
    c.advance(299);
    eq(runs.length, 1, "間隔が明ける前は読まない");
    c.advance(1);
    eq(runs.length, 2, "間隔が明けたら 1 回だけ読む");
    eq(runs[1].at - runs[0].at, 400, "先頭から間隔だけ空いている");
    c.advance(5000);
    eq(runs.length, 2, "出来事が来なければ読まない");
    gate.poke();
    eq(runs.length, 3, "間隔が空いた後の出来事はまたすぐ読む");
  }

  // ---- 承認は待たせない（予定している分も取り消す） ----
  {
    const c = clock();
    const runs = [];
    const gate = createDetailGate({ run: (o) => runs.push(o), gap: () => 400, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    gate.poke();
    c.advance(50);
    gate.poke();
    eq(runs.length, 1, "予定の待ち");
    gate.poke({ urgent: true });
    eq(runs.length, 2, "承認の出入りは間隔を待たずに読む");
    eq(runs[1].urgent, true, "読み直しに urgent を渡す");
    eq(gate.pending, false, "予定していた分は取り消す（二重に読まない）");
    c.advance(1000);
    eq(runs.length, 2, "取り消した分は走らない");
  }

  // ---- 止めた後・読んだと知らせた後 ----
  {
    const c = clock();
    const runs = [];
    const gate = createDetailGate({ run: () => runs.push(c.now()), gap: () => 400, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    gate.poke();
    c.advance(10);
    gate.poke();
    gate.cancel();
    eq(c.pending(), 0, "止めたら予定のタイマーも消える");
    c.advance(5000);
    eq(runs.length, 1, "モーダルを閉じた・別の子へ替えたら、古い子の出来事で読み直さない");
    eq(gate.poke(), false, "止めた後の poke は何もしない");
    eq(gate.poke({ urgent: true }), false, "止めた後は承認でも読まない");
    eq(runs.length, 1, "走らない");
    eq(gate.cancelled, true, "止めた印");
  }
  {
    const c = clock();
    const runs = [];
    const gate = createDetailGate({ run: () => runs.push(c.now()), gap: () => 400, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    gate.note();                    // 最初の読み込みを済ませた
    gate.poke();
    eq(runs.length, 0, "ほかの道で読んだ直後の出来事は、間隔が明けてから");
    c.advance(400);
    eq(runs.length, 1, "間隔が明けたら 1 回追いかける");
  }
  {
    // 読み込みが重いと間隔が伸びる（gap は都度読む）
    const c = clock();
    let gap = 400;
    const runs = [];
    const gate = createDetailGate({ run: () => runs.push(c.now()), gap: () => gap, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    gate.poke();
    gap = 1500;
    c.advance(10);
    gate.poke();
    c.advance(1489);
    eq(runs.length, 1, "重くなった間隔の分は待つ");
    c.advance(1);
    eq(runs.length, 2, "間隔が明けたら読む");
  }

  // ---- 入力中・選択中 ----
  eq(shouldHold({ typing: true }), true, "打っている途中は待つ");
  eq(shouldHold({ typing: true, urgent: true }), true, "承認でも、打っている途中の文字は消さない");
  eq(shouldHold({ selecting: true }), true, "文字を選んでいる間は待つ");
  eq(shouldHold({ selecting: true, urgent: true }), false, "承認の出入りは選びより優先する");
  eq(shouldHold({}), false, "何もしていなければ待たない");

  // ---- フォーカスの戻し先の印（最小の偽の DOM で） ----
  {
    const focusable = (name) => ({ name, focused: 0, focus(o) { this.focused++; this.opts = o; } });
    const makeRow = (key, nodes) => ({ dataset: { key }, querySelectorAll: () => nodes });
    const a = focusable("a"), b = focusable("b");
    const row = makeRow("perm:1", [a, b]);
    b.closest = () => row;
    const root = { contains: (n) => n === b || n === row, querySelectorAll: () => [row] };
    const mark = markFocus(root, b);
    eq(mark, { key: "perm:1", index: 1 }, "行の鍵と行の中の何番目かを控える");
    eq(markFocus(root, null), null, "フォーカスが無ければ印は無い");
    eq(markFocus(root, root), null, "本文そのものは印にしない");
    eq(markFocus(root, { closest: () => row }), null, "本文の外は印にしない");
    // 作り直した後の新しい行
    const a2 = focusable("a2"), b2 = focusable("b2");
    const row2 = makeRow("perm:1", [a2, b2]);
    const fresh = { querySelectorAll: () => [row2] };
    eq(restoreFocus(fresh, mark), true, "同じ鍵の行の同じ位置へ戻す");
    eq(b2.focused, 1, "戻した先にフォーカスが当たる");
    eq(b2.opts, { preventScroll: true }, "位置は動かさない");
    eq(restoreFocus({ querySelectorAll: () => [] }, mark), false, "行が無くなっていたら何もしない");
    eq(restoreFocus(fresh, null), false, "印が無ければ何もしない");
  }
}
